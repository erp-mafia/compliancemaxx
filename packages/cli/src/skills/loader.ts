import { readFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SkillManifestSchema, type SkillManifest, type Framework } from './manifest.js';
import { createLogger } from '../util/log.js';

const log = createLogger('skill-loader');

export interface LoadedSkill {
  manifest: SkillManifest;
  rootDir: string;
  /** Absolute path to manifest.yml. May be null when synthesised from SKILL.md alone (review-mode skills). */
  manifestPath: string | null;
  /** Absolute path to SKILL.md. May be null if the skill is manifest-only. */
  skillMdPath: string | null;
}

const VALID_FRAMEWORKS: ReadonlyArray<Framework> = [
  'oss-license',
  'asvs',
  'iso-27001',
  'soc-2',
  'gdpr',
];

/**
 * Discover skills. A "skill" is a directory containing one of:
 *   - `manifest.yml` (full skill: scanners + agentic + framework metadata)
 *   - `SKILL.md`     (lightweight: review-mode only, framework derived from
 *                     YAML frontmatter or directory name)
 *
 * Search roots, in order:
 *   1. `COMPLIANCE_SKILLS_ROOT` env override
 *   2. `<orchestratorRoot>/skills/` — npm-published layout
 *   3. `<orchestratorRoot>/../skills/` — monorepo layout
 *   4. `<orchestratorRoot>/..`        — legacy `.claude/skills/<skill>/` siblings
 *
 * Returns the first root with ≥1 valid skill.
 */
export async function discoverSkills(orchestratorRoot: string): Promise<LoadedSkill[]> {
  const candidates: string[] = [];
  if (process.env.COMPLIANCE_SKILLS_ROOT) {
    candidates.push(resolve(process.env.COMPLIANCE_SKILLS_ROOT));
  }
  candidates.push(resolve(orchestratorRoot, 'skills'));
  candidates.push(resolve(orchestratorRoot, '..', 'skills'));
  candidates.push(resolve(orchestratorRoot, '..'));

  for (const root of candidates) {
    if (!existsSync(root)) continue;
    const found = await readSkillsFromRoot(root, orchestratorRoot);
    if (found.length > 0) {
      log.debug(`loaded ${found.length} skill(s)`, { from: root });
      return found;
    }
  }
  return [];
}

async function readSkillsFromRoot(
  skillsRoot: string,
  excludeOrchestratorRoot: string,
): Promise<LoadedSkill[]> {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const orchestratorBasename = excludeOrchestratorRoot.split('/').pop();

  const dirs = entries
    .filter((e) => e.isDirectory())
    .filter((e) => e.name !== orchestratorBasename && e.name !== 'cli' && e.name !== 'compliance-swarm')
    .map((e) => ({ name: e.name, path: join(skillsRoot, e.name) }));

  const loaded: LoadedSkill[] = [];
  for (const { name, path } of dirs) {
    const manifestPath = join(path, 'manifest.yml');
    const skillMdPath = join(path, 'SKILL.md');

    if (existsSync(manifestPath)) {
      try {
        const skill = await loadFromManifest(manifestPath, skillMdPath);
        loaded.push(skill);
        continue;
      } catch (err) {
        log.warn(`failed to load manifest at ${manifestPath}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
    }

    if (existsSync(skillMdPath)) {
      try {
        const skill = loadFromSkillMd(skillMdPath, name);
        loaded.push(skill);
      } catch (err) {
        log.warn(`failed to load SKILL.md at ${skillMdPath}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return loaded;
}

async function loadFromManifest(manifestPath: string, skillMdPath: string): Promise<LoadedSkill> {
  const raw = await readFile(manifestPath, 'utf8');
  const parsed: unknown = parseYaml(raw);
  const result = SkillManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid manifest at ${manifestPath}:\n${issues}`);
  }
  return {
    manifest: result.data,
    rootDir: dirname(manifestPath),
    manifestPath,
    skillMdPath: existsSync(skillMdPath) ? skillMdPath : null,
  };
}

/**
 * Synthesise a minimal manifest from a SKILL.md file, for review-mode skills
 * that don't ship a full manifest. Looks for YAML frontmatter at the top of
 * the file:
 *
 *   ---
 *   id: my-skill                # optional, defaults to dir name
 *   framework: asvs             # optional, derived from dir name
 *   cross_framework:            # optional
 *     - { tag: "ISO 27001:2022", control: "A.8.25" }
 *   ---
 */
function loadFromSkillMd(skillMdPath: string, dirName: string): LoadedSkill {
  const content = readFileSync(skillMdPath, 'utf8');
  const fm = parseFrontmatter(content);
  const framework = inferFramework(fm.framework, dirName);

  const manifest = SkillManifestSchema.parse({
    id: typeof fm.id === 'string' ? fm.id : dirName,
    version: typeof fm.version === 'string' ? fm.version : '0.0.0',
    description: typeof fm.description === 'string' ? fm.description : '',
    detection: { always_applicable: true, paths: [] },
    static_scan: [],
    deep_audit: [],
    finding_extraction: {
      framework,
      cross_framework: Array.isArray(fm.cross_framework) ? fm.cross_framework : [],
    },
  });

  return {
    manifest,
    rootDir: dirname(skillMdPath),
    manifestPath: null,
    skillMdPath,
  };
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]+?)\n---\s*\n/;

function parseFrontmatter(content: string): Record<string, unknown> {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return {};
  try {
    const parsed: unknown = parseYaml(m[1]!);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function inferFramework(declared: unknown, dirName: string): Framework {
  if (typeof declared === 'string' && (VALID_FRAMEWORKS as ReadonlyArray<string>).includes(declared)) {
    return declared as Framework;
  }
  // Heuristics on directory name. Falls back to oss-license as a stable default
  // (if a skill author writes a SKILL.md without frontmatter, they get a
  // working but mislabeled finding instead of a crash).
  const lower = dirName.toLowerCase();
  if (lower.includes('asvs') || lower.includes('owasp')) return 'asvs';
  if (lower.includes('iso')) return 'iso-27001';
  if (lower.includes('soc')) return 'soc-2';
  if (lower.includes('gdpr') || lower.includes('privacy')) return 'gdpr';
  if (lower.includes('license') || lower.includes('oss')) return 'oss-license';
  log.warn(`framework not inferable for skill '${dirName}', defaulting to oss-license`);
  return 'oss-license';
}

export async function loadManifest(manifestPath: string): Promise<LoadedSkill> {
  const skillMdPath = join(dirname(manifestPath), 'SKILL.md');
  return loadFromManifest(manifestPath, skillMdPath);
}

export async function loadOrchestratorRoot(): Promise<string> {
  const fromEnv = process.env.COMPLIANCE_SWARM_ROOT;
  if (fromEnv) return resolve(fromEnv);
  const here = new URL('.', import.meta.url).pathname;
  return resolve(here, '..', '..');
}
