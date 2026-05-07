import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSkills } from '../../src/skills/loader.js';

describe('skill loader (manifest-less skills)', () => {
  let tmp: string;
  let orchestratorRoot: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'loader-test-'));
    const skillsRoot = join(tmp, 'skills');
    orchestratorRoot = join(skillsRoot, 'compliance-swarm');
    mkdirSync(orchestratorRoot, { recursive: true });

    originalEnv = process.env.COMPLIANCE_SWARM_ROOT;
    process.env.COMPLIANCE_SWARM_ROOT = orchestratorRoot;
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.COMPLIANCE_SWARM_ROOT = originalEnv;
    else delete process.env.COMPLIANCE_SWARM_ROOT;
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeSkillMd(skillId: string, content: string): void {
    const dir = join(tmp, 'skills', skillId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), content);
  }

  function writeManifest(skillId: string, framework: string): void {
    const dir = join(tmp, 'skills', skillId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.yml'),
      `id: ${skillId}\nversion: 1.0.0\ndetection:\n  paths: []\nfinding_extraction:\n  framework: ${framework}\n`,
    );
  }

  it('loads SKILL.md without manifest, infers framework from dir name', async () => {
    writeSkillMd('asvs-v5', '# Test ASVS skill\n');
    const loaded = await discoverSkills(orchestratorRoot);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.manifest.id).toBe('asvs-v5');
    expect(loaded[0]?.manifest.finding_extraction.framework).toBe('asvs');
    expect(loaded[0]?.manifestPath).toBeNull();
    expect(loaded[0]?.skillMdPath).toMatch(/SKILL\.md$/);
  });

  it('loads SKILL.md with frontmatter overriding inferred framework', async () => {
    writeSkillMd(
      'mystery-skill',
      `---
id: my-cool-skill
framework: gdpr
cross_framework:
  - { tag: "ISO 27001:2022", control: "A.5.34" }
---

# Whatever\n`,
    );
    const loaded = await discoverSkills(orchestratorRoot);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.manifest.id).toBe('my-cool-skill');
    expect(loaded[0]?.manifest.finding_extraction.framework).toBe('gdpr');
    expect(loaded[0]?.manifest.finding_extraction.cross_framework).toContainEqual({
      tag: 'ISO 27001:2022',
      control: 'A.5.34',
    });
  });

  it('prefers full manifest.yml when both exist', async () => {
    writeSkillMd('soc-thing', '# x\n');
    writeManifest('soc-thing', 'soc-2');
    const loaded = await discoverSkills(orchestratorRoot);
    expect(loaded[0]?.manifestPath).toMatch(/manifest\.yml$/);
    expect(loaded[0]?.skillMdPath).toMatch(/SKILL\.md$/);
    expect(loaded[0]?.manifest.finding_extraction.framework).toBe('soc-2');
  });

  it('infers framework heuristically: iso, soc, gdpr, oss', async () => {
    writeSkillMd('iso-thing', '# iso\n');
    writeSkillMd('soc-thing', '# soc\n');
    writeSkillMd('gdpr-thing', '# gdpr\n');
    writeSkillMd('oss-thing', '# oss\n');
    const loaded = await discoverSkills(orchestratorRoot);
    const byId = Object.fromEntries(loaded.map((s) => [s.manifest.id, s.manifest.finding_extraction.framework]));
    expect(byId['iso-thing']).toBe('iso-27001');
    expect(byId['soc-thing']).toBe('soc-2');
    expect(byId['gdpr-thing']).toBe('gdpr');
    expect(byId['oss-thing']).toBe('oss-license');
  });

  it('skips dirs without SKILL.md or manifest.yml', async () => {
    mkdirSync(join(tmp, 'skills', 'empty-dir'), { recursive: true });
    writeSkillMd('real-skill', '# x\n');
    const loaded = await discoverSkills(orchestratorRoot);
    expect(loaded.map((s) => s.manifest.id)).toEqual(['real-skill']);
  });
});
