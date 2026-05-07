# Review mode

The lightweight default: pure LLM, diff-focused, no Docker scanners, no SBOM.

## What it does

For every enabled skill:

1. Loads the skill's `SKILL.md` and any files under `references/`.
2. Builds a system prompt from those + the skill's framework metadata.
3. Sends the system prompt + the PR diff to the configured LLM.
4. Parses the structured JSON response into `Finding[]`.
5. Cross-framework dedups across skills.
6. Posts a sticky markdown comment.

## When to use it

- **Default for most repos.** It's fast, cheap, and catches things scanners
  can't (semantic reasoning, policy adherence, missed business-logic checks).
- **Non-Node, non-Docker, polyglot CI environments.** The action just needs Node
  to invoke the npm package; the LLM does the rest.
- **Repos with documented policies in markdown** (`.compliance/`, `docs/security/`,
  `ISMS/`). Review mode reasons over those alongside the diff.

## When `scan` or `audit` is better

- **Catching specific known patterns** — leaked AWS keys, CVE-XXXX in deps,
  insecure Terraform — use `scan` (or `audit`). Scanners are deterministic
  and won't hallucinate; LLMs occasionally miss obvious things or invent
  control IDs.
- **You need SARIF annotations on specific lines.** Review mode often can't
  pinpoint a line; scanners always can.
- **You want a verifiable audit trail with rule IDs from CVE/CWE/OWASP
  databases.** Use `scan`/`audit` for this.

Best practice for serious shops: `mode: audit` nightly + `mode: review` (or
`mode: scan` if you can't afford LLM cost) on every PR.

## What goes into the prompt

For each skill, the system prompt is:

```
You are a compliance reviewer for the <framework> frame.

# Skill knowledge base
<contents of SKILL.md>

# Reference material
<concatenated references/*.md, capped at 30 KB>

# Cross-framework mappings
<from manifest or frontmatter>

# Output contract
<strict JSON schema>
```

The user message is the PR diff (capped at 80 KB) + changed file list.

## Cost estimate

Per skill, per PR: roughly 1 Bedrock Sonnet 4.6 call with ~30-100 KB input and
≤4 KB output. At current pricing (~$3/M input tokens, $15/M output tokens):

- Per skill: ~$0.01
- Five skills: ~$0.05 per PR

A repo doing 100 PRs/month → ~$5/month for review-mode coverage across all
five frameworks.

## When the LLM is unavailable

If `--no-llm` is passed or no provider creds are configured, review mode logs
a warning and exits cleanly with zero findings. It does NOT crash. The PR
comment will say "no LLM available; review skipped".

## Output

Review mode writes the same artifacts as the other modes:

- `compliance-comment.md` — sticky PR comment
- `compliance-dossier.json` — full structured report
- `compliance.sarif` — empty in review mode (no per-line findings); other
  modes populate it

## Authoring a review-only skill

You can ship a skill that *only* works in review mode (no Docker tooling
needed) by writing just `SKILL.md` with optional YAML frontmatter:

```markdown
---
id: my-framework
framework: gdpr           # one of: oss-license | asvs | iso-27001 | soc-2 | gdpr
cross_framework:
  - { tag: "ISO 27001:2022", control: "A.5.34" }
---

# My framework

When reviewing a PR, look for ...
```

No `manifest.yml` needed. The orchestrator infers the rest.
