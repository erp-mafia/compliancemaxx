import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReviewMode } from '../../src/skills/review.js';
import type { LoadedSkill, RepoContext, LLMClient } from '../../src/skills/interface.js';
import { SkillManifestSchema } from '../../src/skills/manifest.js';
import { execSync } from 'node:child_process';

function makeSkill(tmpRoot: string, id: string, framework: 'asvs' | 'gdpr' | 'soc-2' | 'iso-27001' | 'oss-license'): LoadedSkill {
  const dir = join(tmpRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `# ${id}\n\nThis is a test skill for the ${framework} framework.\n\nLook for any obvious problems.\n`,
  );
  return {
    manifest: SkillManifestSchema.parse({
      id,
      version: '0.0.0',
      detection: { paths: [] },
      finding_extraction: { framework, cross_framework: [] },
    }),
    rootDir: dir,
    manifestPath: null,
    skillMdPath: join(dir, 'SKILL.md'),
  };
}

function makeMockLLM(responses: Record<string, string>): LLMClient {
  let callCount = 0;
  const calls: Array<{ system: string; user: string }> = [];
  const client: LLMClient & { calls: typeof calls; callCount: () => number } = {
    providerName: 'mock',
    async complete({ system, user }) {
      callCount++;
      calls.push({ system, user });
      // Match the skill ID in the system prompt to pick the right response
      for (const [skillIdFragment, response] of Object.entries(responses)) {
        if (system.includes(skillIdFragment)) return response;
      }
      return JSON.stringify({ findings: [] });
    },
    calls,
    callCount: () => callCount,
  };
  return client;
}

describe('runReviewMode', () => {
  let tmp: string;
  let repoRoot: string;
  let skillsRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'review-test-'));
    repoRoot = join(tmp, 'repo');
    skillsRoot = join(tmp, 'skills');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(skillsRoot, { recursive: true });

    // Set up a real-ish git repo with a base commit + a diff
    execSync('git init -q -b main', { cwd: repoRoot });
    execSync('git config user.email t@t.com && git config user.name T', { cwd: repoRoot, shell: '/bin/bash' });
    writeFileSync(join(repoRoot, 'README.md'), '# initial\n');
    execSync('git add . && git commit -q -m base', { cwd: repoRoot, shell: '/bin/bash' });
    writeFileSync(join(repoRoot, 'src.ts'), 'console.log(user.email);\n');
    execSync('git add . && git commit -q -m change', { cwd: repoRoot, shell: '/bin/bash' });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns no findings when LLM responds with empty array', async () => {
    const skill = makeSkill(skillsRoot, 'test-asvs', 'asvs');
    const llm = makeMockLLM({});
    const ctx: RepoContext = {
      repoRoot,
      artifactDir: join(tmp, 'artifacts'),
      changedFiles: [],
      baseRef: 'main~1',
      mode: 'pr',
      defaultBlocking: false,
      artifacts: new Map(),
    };
    const findings = await runReviewMode([skill], ctx, llm);
    expect(findings).toEqual([]);
  });

  it('parses LLM JSON response into Findings', async () => {
    const skill = makeSkill(skillsRoot, 'test-gdpr', 'gdpr');
    const response = JSON.stringify({
      findings: [
        {
          control_ref: 'Art.5(1)(f)',
          severity: 'high',
          status: 'fail',
          message: 'PII logged in plaintext',
          evidence: 'console.log(user.email);',
          remediation: 'Redact PII before logging.',
          file: 'src.ts',
          line: 1,
        },
      ],
    });
    const llm = makeMockLLM({ 'test-gdpr': response });
    const ctx: RepoContext = {
      repoRoot,
      artifactDir: join(tmp, 'artifacts'),
      changedFiles: ['src.ts'],
      baseRef: 'main~1',
      mode: 'pr',
      defaultBlocking: true,
      artifacts: new Map(),
    };
    const findings = await runReviewMode([skill], ctx, llm);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.framework).toBe('gdpr');
    expect(findings[0]?.control_ref).toBe('Art.5(1)(f)');
    expect(findings[0]?.severity).toBe('high');
    expect(findings[0]?.modality).toBe('agentic');
    expect(findings[0]?.location.file).toBe('src.ts');
    expect(findings[0]?.location.line).toBe(1);
    expect(findings[0]?.blocking).toBe(true);
  });

  it('tolerates malformed LLM output without crashing', async () => {
    const skill = makeSkill(skillsRoot, 'test-bad', 'asvs');
    const llm = makeMockLLM({ 'test-bad': 'this is not json at all, just prose' });
    const ctx: RepoContext = {
      repoRoot,
      artifactDir: join(tmp, 'artifacts'),
      changedFiles: [],
      baseRef: 'main~1',
      mode: 'pr',
      defaultBlocking: false,
      artifacts: new Map(),
    };
    const findings = await runReviewMode([skill], ctx, llm);
    expect(findings).toEqual([]);
  });

  it('returns nothing when there is no diff', async () => {
    const skill = makeSkill(skillsRoot, 'test-noop', 'asvs');
    const llmCalls = vi.fn();
    const llm: LLMClient = {
      providerName: 'mock',
      async complete(args) {
        llmCalls(args);
        return JSON.stringify({ findings: [] });
      },
    };
    const ctx: RepoContext = {
      repoRoot,
      artifactDir: join(tmp, 'artifacts'),
      changedFiles: [],
      baseRef: 'HEAD',         // diffing HEAD against itself = empty
      mode: 'pr',
      defaultBlocking: false,
      artifacts: new Map(),
    };
    const findings = await runReviewMode([skill], ctx, llm);
    expect(findings).toEqual([]);
    expect(llmCalls).not.toHaveBeenCalled();
  });

  it('runs all skills in parallel', async () => {
    const skills = [
      makeSkill(skillsRoot, 'test-asvs', 'asvs'),
      makeSkill(skillsRoot, 'test-gdpr', 'gdpr'),
      makeSkill(skillsRoot, 'test-soc2', 'soc-2'),
    ];
    const llm = makeMockLLM({});
    const ctx: RepoContext = {
      repoRoot,
      artifactDir: join(tmp, 'artifacts'),
      changedFiles: ['src.ts'],
      baseRef: 'main~1',
      mode: 'pr',
      defaultBlocking: false,
      artifacts: new Map(),
    };
    const findings = await runReviewMode(skills, ctx, llm);
    expect(findings).toEqual([]);
    expect((llm as unknown as { calls: unknown[] }).calls.length).toBe(3);
  });
});
