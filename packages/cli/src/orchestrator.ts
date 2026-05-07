import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from './config/loader.js';
import type { SwarmConfig } from './config/schema.js';
import { discoverSkills, loadOrchestratorRoot } from './skills/loader.js';
import { ManifestSkillAdapter, type LLMClient, type RepoContext, type SkillAdapter } from './skills/interface.js';
import { runReviewMode } from './skills/review.js';
import type { Finding } from './findings/schema.js';
import { meetsThreshold } from './findings/schema.js';
import { dedup } from './findings/dedup.js';
import { applySuppressions, type SuppressionRule } from './findings/suppress.js';
import { toSarif } from './emit/sarif.js';
import { toMarkdown } from './emit/markdown.js';
import { toDossier } from './emit/dossier.js';
import { changedFiles, isInsideGitRepo } from './util/git.js';
import { ArtifactCache, defaultCacheDir } from './util/cache.js';
import { createLogger } from './util/log.js';

const log = createLogger('orchestrator');

/**
 * Public mode names. v2 uses `review`/`scan`/`audit`; the legacy `pr`/`swarm`
 * names remain accepted for backwards compat and are normalised at the entry.
 */
export type Mode = 'review' | 'scan' | 'audit';
export type LegacyMode = 'pr' | 'swarm';

const MODE_ALIASES: Record<LegacyMode, Mode> = {
  pr: 'scan',
  swarm: 'audit',
};

export function normaliseMode(input: string): Mode {
  if (input in MODE_ALIASES) {
    const aliased = MODE_ALIASES[input as LegacyMode];
    log.warn(`mode '${input}' is deprecated; use '${aliased}' instead`);
    return aliased;
  }
  if (input === 'review' || input === 'scan' || input === 'audit') return input;
  throw new Error(`Unknown mode '${input}'. Valid: review | scan | audit (or legacy pr | swarm).`);
}

export interface RunOptions {
  mode: Mode | LegacyMode;
  repoRoot: string;
  baseRef?: string;
  configPath?: string;
  /** Restrict to a single skill id; runs only that skill (no graph). */
  onlySkillId?: string;
  /** Skip LLM calls even in modes that would normally use them. */
  noLlm?: boolean;
  llm?: LLMClient;
}

export interface RunResult {
  exitCode: 0 | 1 | 2;
  findings: Finding[];
  expiredSuppressions: SuppressionRule[];
  suppressionsApplied: number;
  skillsExecuted: string[];
  errors: Array<{ skill: string; message: string }>;
  artifacts: { sarif: string; markdown: string; dossier: string };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const mode: Mode = normaliseMode(opts.mode);

  const config = await loadConfig(opts.repoRoot, opts.configPath);
  const orchestratorRoot = await loadOrchestratorRoot();
  const skills = await discoverSkills(orchestratorRoot);

  const enabled = skills
    .filter((s) => config.enabled_skills.includes(s.manifest.id))
    .filter((s) => !opts.onlySkillId || s.manifest.id === opts.onlySkillId);

  if (enabled.length === 0) {
    log.warn('no enabled skills found — nothing to run');
    return finalize(config, opts, mode, [], [], 0, [], [], 0);
  }

  const artifactDir = resolve(opts.repoRoot, config.artifact_dir);
  await mkdir(artifactDir, { recursive: true });

  const inGit = await isInsideGitRepo(opts.repoRoot);
  const changed = inGit && opts.baseRef ? await changedFiles(opts.baseRef, opts.repoRoot) : [];
  const ctx: RepoContext = {
    repoRoot: opts.repoRoot,
    artifactDir,
    changedFiles: changed,
    ...(opts.baseRef !== undefined && { baseRef: opts.baseRef }),
    // RepoContext.mode is still the legacy enum (pr|swarm) used by the existing
    // ManifestSkillAdapter — `review` doesn't go through that path so it's safe
    // to flatten review→pr here for the few places ctx.mode is read.
    mode: mode === 'audit' ? 'swarm' : 'pr',
    defaultBlocking: mode !== 'audit',
    artifacts: new Map(),
  };

  // -------- review mode: LLM-only, diff-focused. Skip scanners entirely. -------
  if (mode === 'review') {
    if (!opts.llm) {
      log.warn('review mode requires an LLM client; nothing to run');
      return finalize(config, opts, mode, [], [], 0, [], [], 0);
    }
    const findings = await runReviewMode(enabled, ctx, opts.llm);
    return processAndEmit(config, opts, mode, findings, [], []);
  }
  // ------------------------------------------------------------------------------

  const adapters = enabled.map((s) => new ManifestSkillAdapter(s));
  const errors: Array<{ skill: string; message: string }> = [];
  const allFindings: Finding[] = [];
  const skillsExecuted: string[] = [];

  // Step 1: split into producer (oss-license) and consumers.
  const producer = adapters.find((a) => a.skill.manifest.produces.length > 0);
  const consumers = adapters.filter((a) => a !== producer);

  // Step 2: SBOM cache (if a producer exists).
  const cache = new ArtifactCache(defaultCacheDir(opts.repoRoot));

  if (producer) {
    skillsExecuted.push(producer.id);
    try {
      const findings = await runSkillWithCache(producer, ctx, cache);
      allFindings.push(...findings);
    } catch (err) {
      errors.push({ skill: producer.id, message: errMsg(err) });
    }
  }

  // Step 3: parallel consumers. Each one re-receives the artifacts ctx that was mutated.
  const consumerResults = await Promise.allSettled(
    consumers.map(async (c) => {
      if (!(await c.detect(ctx))) {
        log.debug(`${c.id} not applicable to this repo`);
        return { id: c.id, findings: [] as Finding[] };
      }
      const findings = await c.staticScan(ctx);
      let deep: Finding[] = [];
      if (mode === 'audit' && !opts.noLlm && opts.llm) {
        deep = await c.deepAudit(ctx, opts.llm);
      }
      return { id: c.id, findings: [...findings, ...deep] };
    }),
  );

  for (const [idx, res] of consumerResults.entries()) {
    const id = consumers[idx]!.id;
    if (res.status === 'fulfilled') {
      skillsExecuted.push(id);
      allFindings.push(...res.value.findings);
    } else {
      errors.push({ skill: id, message: errMsg(res.reason) });
    }
  }

  // Step 4: Producer also gets a deep_audit pass in audit mode.
  if (producer && mode === 'audit' && !opts.noLlm && opts.llm) {
    try {
      const deep = await producer.deepAudit(ctx, opts.llm);
      allFindings.push(...deep);
    } catch (err) {
      errors.push({ skill: producer.id, message: errMsg(err) });
    }
  }

  return processAndEmit(config, opts, mode, allFindings, skillsExecuted, errors);
}

async function processAndEmit(
  config: SwarmConfig,
  opts: RunOptions,
  mode: Mode,
  rawFindings: Finding[],
  skillsExecuted: string[],
  errors: Array<{ skill: string; message: string }>,
): Promise<RunResult> {
  // dedup → suppress → threshold → emit.
  const merged = dedup(rawFindings);
  const suppressionResult = applySuppressions(
    merged as unknown as Finding[],
    config.suppressions,
  );

  // Apply severity threshold to determine `blocking`.
  const thresholded = suppressionResult.findings.map((f) => {
    if (f.status === 'pass') return { ...f, blocking: false };
    const block = f.blocking && meetsThreshold(f.severity, config.severity_threshold_to_block);
    return { ...f, blocking: block };
  });

  const blockingCount = thresholded.filter((f) => f.blocking && f.status === 'fail').length;
  const expiredCount = suppressionResult.expired.length;
  const exitCode: 0 | 1 | 2 = errors.length > 0 ? 2 : blockingCount > 0 || expiredCount > 0 ? 1 : 0;

  return finalize(
    config,
    opts,
    mode,
    thresholded,
    suppressionResult.expired,
    suppressionResult.applied_count,
    skillsExecuted,
    errors,
    exitCode,
  );
}

async function runSkillWithCache(
  skill: SkillAdapter,
  ctx: RepoContext,
  cache: ArtifactCache,
): Promise<Finding[]> {
  // Detect lockfiles to use as cache material.
  const lockfilePatterns = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'requirements.txt', 'go.sum', 'Cargo.lock', 'Gemfile.lock'];
  const fg = (await import('fast-glob')).default;
  const lockfiles = await fg(lockfilePatterns, { cwd: ctx.repoRoot, dot: false, ignore: ['node_modules/**'] });
  const hashes = await ArtifactCache.hashFiles(lockfiles.map((p) => `${ctx.repoRoot}/${p}`));

  if (!(await skill.detect(ctx))) return [];
  const findings = await skill.staticScan(ctx);

  // Mirror produced artifacts into cache (best-effort).
  for (const [name, path] of ctx.artifacts) {
    try {
      await cache.cacheFile({ name, contentInputs: hashes }, path);
    } catch {
      // ignore
    }
  }

  return findings;
}

async function finalize(
  config: SwarmConfig,
  opts: RunOptions,
  mode: Mode,
  findings: Finding[],
  expired: SuppressionRule[],
  applied: number,
  skillsExecuted: string[],
  errors: Array<{ skill: string; message: string }>,
  exitCode: 0 | 1 | 2,
): Promise<RunResult> {
  void opts;
  const repoRoot = opts.repoRoot;
  const sarifPath = resolve(repoRoot, config.sarif_path);
  const mdPath = resolve(repoRoot, config.pr_comment_path);
  const dossierPath = resolve(repoRoot, config.dossier_path);

  // SARIF is only useful when scanners ran (file/line precision); skip in
  // review mode where findings often lack physical locations.
  const sarif = mode === 'review' ? toSarif([]) : toSarif(findings);
  const md = toMarkdown(findings, {
    mode: mode === 'audit' ? 'swarm' : mode === 'scan' ? 'pr' : 'pr',
    expiredSuppressionCount: expired.length,
  });
  const dossier = toDossier({
    mode: mode === 'audit' ? 'swarm' : 'pr',
    exit_code: exitCode,
    findings,
    expired_suppressions: expired,
    suppressions_applied: applied,
    skills_executed: skillsExecuted,
    errors,
  });

  await writeFile(sarifPath, JSON.stringify(sarif, null, 2));
  await writeFile(mdPath, md);
  await writeFile(dossierPath, JSON.stringify(dossier, null, 2));

  return {
    exitCode,
    findings,
    expiredSuppressions: expired,
    suppressionsApplied: applied,
    skillsExecuted,
    errors,
    artifacts: { sarif: sarifPath, markdown: mdPath, dossier: dossierPath },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
