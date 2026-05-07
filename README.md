# compliancemaxx

[![CI](https://github.com/erp-mafia/compliancemaxx/actions/workflows/ci.yml/badge.svg)](https://github.com/erp-mafia/compliancemaxx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/compliancemaxx.svg)](https://www.npmjs.com/package/compliancemaxx)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

**Multi-framework compliance orchestrator for repos and CI/CD.** One tool runs five
audit lenses — **OSS licensing**, **OWASP ASVS v5**, **ISO 27001:2022**, **SOC 2**,
**GDPR** — and dedups findings across frameworks so you don't see the same AWS-key
leak reported four times.

## Quickstart — 30 seconds

Drop this into `.github/workflows/compliance.yml`:

```yaml
name: compliance
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  compliance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: erp-mafia/compliancemaxx@v2
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: eu-north-1
```

Open a PR. Within 90 seconds you get a sticky comment with reasoned compliance
findings across all five frameworks. No `mode:` to choose, no config file, no
Docker. The default `review` mode reads the PR diff, sends it to Claude with
the bundled skill knowledge, and posts structured findings.

Want native scanners (Trivy/Semgrep/Checkov/Gitleaks) too? Add `mode: audit`
to also run them. Want only scanners (no LLM cost)? `mode: scan`.

## Three modes

| Mode | Speed | Cost | LLM | Docker scanners | Output |
|---|---|---|---|---|---|
| `review` (default) | ~90s | ~$0.05 | ✅ | ❌ | sticky PR comment + JSON dossier |
| `scan` | <5min | $0 | ❌ | ✅ | + SARIF annotations on changed lines |
| `audit` | ~10min | ~$0.20 | ✅ | ✅ | full report; nightly cron |

## What you'll see

A finding tagged once but mapped to every framework it violates:

```json
{
  "framework": "asvs",
  "control_ref": "V13.3",
  "severity": "critical",
  "location": { "file": "src/secret.ts", "line": 12 },
  "message": "AWS access key in source",
  "cross_framework": [
    { "tag": "soc-2", "control": "CC6.1" },
    { "tag": "iso-27001", "control": "A.8.24" },
    { "tag": "NIST 800-53", "control": "AC-3" }
  ],
  "remediation": "Rotate the key and remove it from history (git filter-repo or BFG)."
}
```

## Configure

Optional `.compliance/config.yml` at your repo root:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/erp-mafia/compliancemaxx/main/packages/cli/.compliance/config.schema.yml

severity_threshold_to_block: high     # critical | high | medium | low | info
asvs_level: L2
soc2_categories: [security, confidentiality]
llm_provider: bedrock                 # or "anthropic"

suppressions:
  - control_ref: A.8.24
    path: extensions/example-logger/**
    justification: Reference impl, never deployed
    expires: '2026-12-31'
    risk_id: RISK-2026-014           # required for ISO/SOC 2 controls
```

Suppressions expire — once `expires` passes, the build fails until renewed.
ISO 27001 and SOC 2 control suppressions require a `risk_id` referencing your
Risk Register.

See [docs/configuration.md](./docs/configuration.md) for the full reference.

## Action inputs

| Input               | Default            | Description                                                       |
|---------------------|--------------------|-------------------------------------------------------------------|
| `mode`              | `review`           | `review` \| `scan` \| `audit` (or legacy `pr` \| `swarm`)         |
| `base`              | PR base SHA        | Diff base for changed-files.                                      |
| `config-path`       | `.compliance/config.yml` | Override config location. Optional — defaults are sensible. |
| `no-llm`            | `false`            | Skip LLM calls even in modes that use them.                       |
| `llm-provider`      | `bedrock`          | `bedrock` or `anthropic`.                                         |
| `upload-sarif`      | `true`             | Push SARIF to Code Scanning (skipped in `review` mode).           |
| `upload-dossier`    | `true`             | Archive JSON dossier as artifact.                                 |
| `post-comment`      | `true`             | Sticky PR comment.                                                |
| `fail-on-findings`  | `true`             | Exit non-zero on blocking findings.                               |
| `working-directory` | `.`                | Repo dir to scan.                                                 |

## Beyond GitHub Actions

| Platform     | How                                                                                  |
|--------------|--------------------------------------------------------------------------------------|
| GitLab CI    | [`examples/gitlab/.gitlab-ci.yml`](./examples/gitlab/.gitlab-ci.yml)                 |
| pre-commit   | [`examples/pre-commit/`](./examples/pre-commit/.pre-commit-config.yaml)              |
| Local CLI    | `npm i -g compliancemaxx && compliancemaxx run` (review mode by default)             |

## v1 → v2 migration

If you were using v1 (`uses: erp-mafia/compliancemaxx@v1`):

| v1                  | v2 equivalent       | Why change                              |
|---------------------|---------------------|-----------------------------------------|
| `mode: pr` (was required) | `mode: scan`  | More accurate name; `pr` still works as a deprecated alias |
| `mode: swarm`       | `mode: audit`       | More accurate name; `swarm` still works as a deprecated alias |
| (no mode existed)   | `mode: review` (default) | NEW: lightweight LLM-only diff review |

Just bumping `@v1` → `@v2` with no other changes will switch you from
deterministic-only PR scans to LLM-only diff review — the lightest possible
mode, perfect for trying first. Add `mode: scan` to keep v1 behavior.

## Architecture

```
              orchestrator
                  │
   ┌──────────────┼──────────────┐
   │ oss-license  │  asvs ┐
   │ runs first   │  iso-27001 │ run in parallel,
   │ produces SBOM│  soc-2     │ consume the SBOM
   │              │  gdpr      ┘
   └──────────────┘
                  │
          dedup → suppress → SARIF + markdown + JSON dossier
```

The orchestrator owns no compliance logic. Every check lives in a skill
manifest under [`packages/skills/`](./packages/skills/) — a YAML file declaring
detection triggers, scanner invocations, agentic prompts, and cross-framework
mappings. To add a new framework, write a new manifest. See
[docs/writing-a-skill.md](./docs/writing-a-skill.md).

## What it can and can't do

✅ Catches: hardcoded secrets, dangerous IaC misconfigs, copyleft license
contamination, missing CI gates, PII leaking into logs, RoPA drift, broken
access control patterns, change-management bypasses, supply-chain risk via SBOM.

❌ Cannot: physical security audits, vendor contract review, policy creation
(it audits policies you've already written), regulator filings, manual
attestation. Findings tagged `extrinsic` or `manual_attestation_required`
flag where human judgement is required.

## Documentation

- [Quickstart](./docs/quickstart.md) — run it in 5 minutes
- [Configuration](./docs/configuration.md) — every config option, with examples
- [Suppressions](./docs/suppressions.md) — how to waive findings without losing the audit trail
- [Writing a skill](./docs/writing-a-skill.md) — extend with a new framework
- [Architecture](./docs/architecture.md) — how the pipeline works internally

## License

Apache-2.0. See [LICENSE](./LICENSE).

## Contributing

Issues and PRs welcome. The repo dogfoods itself — every commit triggers a
self-audit run, so changes that break the orchestrator's own scan get caught
early.

```sh
git clone https://github.com/erp-mafia/compliancemaxx
cd compliancemaxx
npm install
npm test
```

Add a [changeset](./.changeset/README.md) to any user-facing change.
