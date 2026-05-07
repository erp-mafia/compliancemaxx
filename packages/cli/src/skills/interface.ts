import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import fg from 'fast-glob';
import { exec } from '../tools/exec.js';
import { dockerRun } from '../tools/docker.js';
import { PARSERS } from '../tools/parsers/index.js';
import type { Finding } from '../findings/schema.js';
import { createLogger } from '../util/log.js';
import type { LoadedSkill } from './loader.js';
import type { StaticScanStepT, DeepAuditStepT } from './manifest.js';

export interface RepoContext {
  repoRoot: string;
  artifactDir: string;
  changedFiles: string[];
  baseRef?: string;
  mode: 'pr' | 'swarm';
  defaultBlocking: boolean;
  /** Map of artifact name → absolute path. Mutated by skills as they produce. */
  artifacts: Map<string, string>;
}

export interface LLMClient {
  complete(args: { system: string; user: string; maxTokens?: number }): Promise<string>;
  readonly providerName: string;
}

export interface SkillAdapter {
  readonly id: string;
  readonly skill: LoadedSkill;
  detect(ctx: RepoContext): Promise<boolean>;
  staticScan(ctx: RepoContext): Promise<Finding[]>;
  deepAudit(ctx: RepoContext, llm: LLMClient): Promise<Finding[]>;
}

export class ManifestSkillAdapter implements SkillAdapter {
  readonly id: string;
  private readonly log;

  constructor(public readonly skill: LoadedSkill) {
    this.id = skill.manifest.id;
    this.log = createLogger(`skill:${this.id}`);
  }

  async detect(ctx: RepoContext): Promise<boolean> {
    const m = this.skill.manifest;
    if (m.detection.always_applicable) return true;
    if (m.detection.paths.length === 0) return true;
    const matched = await fg(m.detection.paths, {
      cwd: ctx.repoRoot,
      onlyFiles: false,
      dot: true,
      ignore: ['node_modules/**', '.git/**'],
    });
    return matched.length > 0;
  }

  async staticScan(ctx: RepoContext): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const step of this.skill.manifest.static_scan) {
      if (ctx.mode === 'pr' && !step.pr_mode_enabled) {
        this.log.debug(`skip ${step.id} in pr mode`);
        continue;
      }
      if (ctx.mode === 'swarm' && !step.swarm_mode_enabled) continue;

      try {
        const stepFindings = await this.runStep(step, ctx);
        findings.push(...stepFindings);
      } catch (err) {
        const action = step.failure_action;
        const msg = err instanceof Error ? err.message : String(err);
        if (action === 'fail') throw new Error(`step ${step.id} failed: ${msg}`);
        if (action === 'warn') this.log.warn(`step ${step.id} failed`, { message: msg });
      }
    }
    return findings;
  }

  async deepAudit(ctx: RepoContext, llm: LLMClient): Promise<Finding[]> {
    if (ctx.mode !== 'swarm') return [];
    const findings: Finding[] = [];
    for (const step of this.skill.manifest.deep_audit) {
      try {
        const stepFindings = await this.runDeepStep(step, ctx, llm);
        findings.push(...stepFindings);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`deep_audit ${step.id} failed`, { message: msg });
      }
    }
    return findings;
  }

  private async runStep(step: StaticScanStepT, ctx: RepoContext): Promise<Finding[]> {
    const stepLog = this.log.child(step.id);
    stepLog.info(`running ${step.tool} (parser=${step.parser})`);

    await mkdir(ctx.artifactDir, { recursive: true });
    const outputPath = join(ctx.artifactDir, `${this.id}.${step.id}.${step.output_format}`);

    const subs: Record<string, string> = {
      REPO: ctx.repoRoot,
      OUT: outputPath,
      ARTIFACT_DIR: ctx.artifactDir,
    };
    for (const [name, path] of ctx.artifacts) subs[`ARTIFACT_${name.toUpperCase()}`] = path;

    const args = step.args.map((a) => substituteEnv(a, subs));

    let result;
    if (step.tool === 'docker') {
      if (!step.image) throw new Error(`step ${step.id}: docker tool requires image`);
      result = await dockerRun({
        image: step.image,
        args,
        mounts: [
          { host: ctx.repoRoot, container: ctx.repoRoot, readonly: true },
          { host: ctx.artifactDir, container: ctx.artifactDir },
        ],
        timeoutMs: step.timeout_seconds * 1000,
      });
    } else {
      const command = step.binary ?? step.tool;
      result = await exec(command, args, {
        cwd: ctx.repoRoot,
        timeoutMs: step.timeout_seconds * 1000,
      });
    }

    if (result.timedOut) throw new Error(`timed out after ${step.timeout_seconds}s`);

    let raw: string;
    if (existsSync(outputPath)) {
      raw = await readFile(outputPath, 'utf8');
    } else {
      raw = result.stdout;
    }

    if (step.produces_artifact && existsSync(outputPath)) {
      ctx.artifacts.set(step.produces_artifact, outputPath);
      stepLog.debug(`produced artifact ${step.produces_artifact} → ${outputPath}`);
    }

    const parser = PARSERS[step.parser];
    if (!parser) throw new Error(`unknown parser '${step.parser}'`);
    const findings = parser.parse(raw, {
      manifest: this.skill.manifest,
      stepId: step.id,
      defaultBlocking: ctx.defaultBlocking,
    });
    stepLog.info(`${findings.length} finding(s)`);
    return findings;
  }

  private async runDeepStep(
    step: DeepAuditStepT,
    ctx: RepoContext,
    llm: LLMClient,
  ): Promise<Finding[]> {
    const stepLog = this.log.child(`deep:${step.id}`);
    const promptPath = resolve(this.skill.rootDir, step.prompt_file);
    if (!existsSync(promptPath)) {
      throw new Error(`prompt file not found: ${promptPath}`);
    }
    const promptContent = await readFile(promptPath, 'utf8');
    const promptSection = step.section ? extractSection(promptContent, step.section) : promptContent;

    const inputs = await collectInputs(step.inputs, ctx);
    const userMessage = buildUserMessage(promptSection, inputs, step.max_input_chars);

    stepLog.info(`invoking ${llm.providerName} (${userMessage.length} chars)`);
    const response = await llm.complete({
      system: SYSTEM_PROMPT(this.skill.manifest.id),
      user: userMessage,
    });

    const findings = extractStructuredFindings(response, this.skill.manifest, step.id, ctx);
    stepLog.info(`${findings.length} agentic finding(s)`);
    return findings;
  }
}

const SYSTEM_PROMPT = (skillId: string) => `You are an auditor for the ${skillId} compliance frame.
Respond with valid JSON only — no prose, no markdown fences, no commentary.
Each finding MUST be an object with these fields:
  control_ref: string (e.g. "Art.5(1)(f)" | "V8.2.1" | "A.8.24")
  severity: "critical" | "high" | "medium" | "low" | "info"
  status: "fail" | "manual_attestation_required"
  message: string (one-sentence problem statement)
  evidence: string (≤500 chars; verbatim citation or excerpt)
  remediation: string (one-sentence)
  file: string (path; "n/a" if not applicable)
  line: number (optional)
Output shape: { "findings": [Finding, ...] }
If no findings, return { "findings": [] }.`;

function buildUserMessage(prompt: string, inputs: string, maxChars: number): string {
  const combined = `${prompt}\n\n--- INPUTS ---\n${inputs}`;
  if (combined.length <= maxChars) return combined;
  return combined.slice(0, maxChars) + '\n\n[truncated]';
}

function extractSection(content: string, section: string): string {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.includes(section));
  if (start === -1) return content;
  // walk forward until next heading at same depth
  const headingMatch = lines[start]?.match(/^(#+)/);
  const depth = headingMatch ? headingMatch[1]?.length ?? 1 : 1;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i]?.match(/^(#+)\s/);
    if (h && (h[1]?.length ?? 99) <= depth) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

async function collectInputs(inputNames: string[], ctx: RepoContext): Promise<string> {
  const parts: string[] = [];
  for (const input of inputNames) {
    if (input === 'changed_files') {
      parts.push(`### Changed files\n${ctx.changedFiles.join('\n') || '(none)'}`);
      continue;
    }
    if (ctx.artifacts.has(input)) {
      const path = ctx.artifacts.get(input)!;
      const content = await readFile(path, 'utf8').catch(() => '');
      parts.push(`### Artifact: ${input}\n\`\`\`\n${content.slice(0, 20_000)}\n\`\`\``);
      continue;
    }
    // treat as repo-relative path; glob for any matches
    const matched = await fg(input, { cwd: ctx.repoRoot, onlyFiles: true });
    for (const m of matched.slice(0, 10)) {
      const path = resolve(ctx.repoRoot, m);
      const content = await readFile(path, 'utf8').catch(() => '');
      parts.push(`### File: ${m}\n\`\`\`\n${content.slice(0, 8_000)}\n\`\`\``);
    }
  }
  return parts.join('\n\n');
}

function extractStructuredFindings(
  raw: string,
  manifest: import('./manifest.js').SkillManifest,
  stepId: string,
  ctx: RepoContext,
): Finding[] {
  let json: unknown;
  try {
    // Tolerate fenced or wrapped output by grabbing the first {...} block.
    const match = raw.match(/\{[\s\S]*\}/);
    json = match ? JSON.parse(match[0]) : JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray((json as { findings?: unknown[] }).findings)
    ? ((json as { findings: unknown[] }).findings as Array<Record<string, unknown>>)
    : [];
  const fx = manifest.finding_extraction;
  return arr.map((f) => {
    const file = String(f.file ?? 'n/a');
    return {
      framework: fx.framework,
      control_ref: String(f.control_ref ?? 'unknown'),
      rule_id: `agent.${stepId}`,
      severity: (['critical', 'high', 'medium', 'low', 'info'].includes(f.severity as string)
        ? f.severity
        : 'medium') as Finding['severity'],
      status: ((f.status === 'manual_attestation_required'
        ? 'manual_attestation_required'
        : 'fail') as Finding['status']),
      modality: 'agentic' as const,
      source_tool: 'llm-claude',
      location: { file, ...(typeof f.line === 'number' && { line: f.line }) },
      message: String(f.message ?? ''),
      evidence: String(f.evidence ?? ''),
      remediation: String(f.remediation ?? ''),
      cross_framework: fx.cross_framework,
      blocking: ctx.defaultBlocking,
      id: '', // finalize will derive
    } as Finding;
  }).map((draft) => ({ ...draft, id: makeId(draft) }));
}

function makeId(f: Finding): string {
  return createHash('sha256')
    .update([f.framework, f.control_ref, f.rule_id, f.source_tool, f.location.file, String(f.location.line ?? '')].join('|'))
    .digest('hex')
    .slice(0, 16);
}

function substituteEnv(s: string, env: Record<string, string>): string {
  return s.replace(/\$\{([A-Z_]+)\}/g, (_, k: string) => env[k] ?? '');
}
