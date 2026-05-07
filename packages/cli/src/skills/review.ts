import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fg from 'fast-glob';
import { exec } from '../tools/exec.js';
import type { Finding } from '../findings/schema.js';
import { finalize } from '../findings/schema.js';
import type { LoadedSkill } from './loader.js';
import type { LLMClient, RepoContext } from './interface.js';
import { createLogger } from '../util/log.js';

const log = createLogger('review');

const MAX_DIFF_CHARS = 80_000;
const MAX_REFERENCE_CHARS = 30_000;
const MAX_RESPONSE_TOKENS = 4096;

interface SkillReviewInputs {
  diff: string;
  changedFiles: string[];
  truncated: boolean;
}

/**
 * Run the lightweight LLM-only review against the PR diff.
 *
 * For each enabled skill: load SKILL.md + relevant references, send to the LLM
 * with the diff as the user message, parse structured findings, return.
 *
 * Skips Docker scanners entirely. Doesn't need an SBOM. Cheap and fast.
 * Findings have file/line locations only when the LLM can derive them from
 * the diff (often missing for cross-cutting concerns — that's expected).
 */
export async function runReviewMode(
  skills: LoadedSkill[],
  ctx: RepoContext,
  llm: LLMClient,
): Promise<Finding[]> {
  if (skills.length === 0) {
    log.warn('no skills to review');
    return [];
  }

  const diffInput = await collectDiff(ctx);
  if (!diffInput.diff.trim()) {
    log.info('no diff vs base — review mode has nothing to evaluate');
    return [];
  }

  log.info(`reviewing ${skills.length} skill(s) against diff`, {
    files: diffInput.changedFiles.length,
    diffChars: diffInput.diff.length,
    truncated: diffInput.truncated,
  });

  const results = await Promise.allSettled(
    skills.map((s) => reviewOne(s, diffInput, ctx, llm)),
  );

  const findings: Finding[] = [];
  for (const [i, res] of results.entries()) {
    if (res.status === 'fulfilled') {
      findings.push(...res.value);
    } else {
      const id = skills[i]?.manifest.id ?? '<unknown>';
      log.warn(`review failed for ${id}`, {
        error: res.reason instanceof Error ? res.reason.message : String(res.reason),
      });
    }
  }
  return findings;
}

async function reviewOne(
  skill: LoadedSkill,
  diff: SkillReviewInputs,
  ctx: RepoContext,
  llm: LLMClient,
): Promise<Finding[]> {
  const skillLog = log.child(skill.manifest.id);
  const skillMd = skill.skillMdPath ? await readFile(skill.skillMdPath, 'utf8') : '';
  const references = await loadReferences(skill.rootDir);

  const system = buildSystemPrompt(skill, skillMd, references);
  const user = buildUserMessage(skill.manifest.id, diff);

  skillLog.info(`invoking LLM`, { systemChars: system.length, userChars: user.length });
  const response = await llm.complete({ system, user, maxTokens: MAX_RESPONSE_TOKENS });

  const findings = parseLLMFindings(response, skill, ctx);
  skillLog.info(`${findings.length} finding(s)`);
  return findings;
}

function buildSystemPrompt(skill: LoadedSkill, skillMd: string, references: string): string {
  const fx = skill.manifest.finding_extraction;
  const crossList =
    fx.cross_framework.length > 0
      ? fx.cross_framework.map((c) => `  - ${c.tag}: ${c.control}`).join('\n')
      : '  (none)';

  return `You are a compliance reviewer for the **${fx.framework}** frame, specifically reviewing changes in a pull request.

# Skill knowledge base

${skillMd}

${references ? `# Reference material\n\n${references}` : ''}

# Cross-framework mappings declared by this skill

${crossList}

# Output contract

Respond with **strict JSON only** — no prose, no markdown fences. Schema:

\`\`\`
{
  "findings": [
    {
      "control_ref": string,        // e.g. "Art.5(1)(f)" | "V8.2.1" | "A.8.24" | "CC6.1" | "SPDX-AGPL-3.0"
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "status": "fail" | "manual_attestation_required",
      "message": string,            // one-sentence problem statement
      "evidence": string,           // ≤500 chars; verbatim diff snippet or quote from inputs
      "remediation": string,        // one-sentence fix
      "file": string,               // path from the diff if attributable; otherwise "n/a"
      "line": number                // optional; only when you can pinpoint
    }
  ]
}
\`\`\`

Rules:

- Only return real findings tied to the diff. Don't speculate or pad.
- Empty findings array is the correct response when nothing matters in this PR for this frame.
- Use \`severity: high\` for clear violations, \`medium\` for likely violations, \`low\`/\`info\` for nitpicks.
- Use \`status: manual_attestation_required\` when you flag something the LLM can't conclusively decide (e.g. policy adherence requires HR system check).
- Use exact \`control_ref\` identifiers from the skill's framework — do not invent IDs.`;
}

function buildUserMessage(skillId: string, input: SkillReviewInputs): string {
  const fileList = input.changedFiles.length > 0 ? input.changedFiles.join('\n') : '(no file list available)';
  const truncatedNote = input.truncated ? '\n\n[Diff truncated to fit context window.]' : '';

  return `Review the following pull-request diff for ${skillId} compliance issues.

## Files changed

\`\`\`
${fileList}
\`\`\`

## Diff

\`\`\`diff
${input.diff}${truncatedNote}
\`\`\``;
}

async function collectDiff(ctx: RepoContext): Promise<SkillReviewInputs> {
  const baseRef = ctx.baseRef ?? 'main';

  // Best-effort: fetch the base ref if it's not local, so `git diff` works.
  await exec('git', ['fetch', 'origin', baseRef, '--depth=1'], {
    cwd: ctx.repoRoot,
    timeoutMs: 30_000,
  }).catch(() => undefined);

  const filesResult = await exec(
    'git',
    ['diff', '--name-only', `${baseRef}...HEAD`],
    { cwd: ctx.repoRoot, timeoutMs: 30_000 },
  );
  const changedFiles = filesResult.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const diffResult = await exec(
    'git',
    ['diff', `${baseRef}...HEAD`],
    { cwd: ctx.repoRoot, timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024 },
  );
  let diff = diffResult.stdout;
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }
  return { diff, changedFiles, truncated };
}

async function loadReferences(rootDir: string): Promise<string> {
  const refsDir = join(rootDir, 'references');
  if (!existsSync(refsDir)) return '';
  const files = await fg('**/*.md', { cwd: refsDir, absolute: true });
  if (files.length === 0) return '';

  const blocks: string[] = [];
  let totalChars = 0;
  for (const f of files) {
    const content = await readFile(f, 'utf8').catch(() => '');
    if (!content.trim()) continue;
    const header = `## ${f.split('/').pop()}\n`;
    const block = header + content;
    if (totalChars + block.length > MAX_REFERENCE_CHARS) break;
    blocks.push(block);
    totalChars += block.length;
  }
  return blocks.join('\n\n');
}

interface LLMFinding {
  control_ref?: unknown;
  severity?: unknown;
  status?: unknown;
  message?: unknown;
  evidence?: unknown;
  remediation?: unknown;
  file?: unknown;
  line?: unknown;
}

function parseLLMFindings(raw: string, skill: LoadedSkill, ctx: RepoContext): Finding[] {
  let parsed: unknown;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]!) : JSON.parse(raw);
  } catch {
    log.warn('LLM returned non-JSON response', { skill: skill.manifest.id, head: raw.slice(0, 200) });
    return [];
  }
  const arr = Array.isArray((parsed as { findings?: unknown[] }).findings)
    ? ((parsed as { findings: LLMFinding[] }).findings)
    : [];

  const fx = skill.manifest.finding_extraction;
  const out: Finding[] = [];

  for (const f of arr) {
    const file = typeof f.file === 'string' ? f.file : 'n/a';
    const lineNum = typeof f.line === 'number' && Number.isFinite(f.line) ? f.line : undefined;
    const severity = parseSeverity(f.severity);
    const status = f.status === 'manual_attestation_required' ? 'manual_attestation_required' : 'fail';

    out.push(
      finalize({
        framework: fx.framework,
        control_ref: typeof f.control_ref === 'string' ? f.control_ref : 'unknown',
        rule_id: `review.${skill.manifest.id}`,
        severity,
        status,
        modality: 'agentic',
        source_tool: `llm-${llmShortName(ctx)}`,
        location: { file, ...(lineNum !== undefined && { line: lineNum }) },
        message: typeof f.message === 'string' ? f.message : '',
        evidence: typeof f.evidence === 'string' ? f.evidence : '',
        remediation: typeof f.remediation === 'string' ? f.remediation : '',
        cross_framework: fx.cross_framework,
        blocking: ctx.defaultBlocking,
      }),
    );
  }
  return out;
}

function parseSeverity(raw: unknown): Finding['severity'] {
  if (typeof raw !== 'string') return 'medium';
  const lower = raw.toLowerCase();
  if (lower === 'critical' || lower === 'high' || lower === 'medium' || lower === 'low' || lower === 'info') {
    return lower;
  }
  return 'medium';
}

function llmShortName(ctx: RepoContext): string {
  // ctx doesn't carry the LLM client name; this is just a label for source_tool
  // so we use a generic value. Could be improved by passing client.providerName through.
  return 'agent';
}
