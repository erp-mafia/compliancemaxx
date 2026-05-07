---
'compliancemaxx': major
---

**v2: lightweight `review` mode is now the default.**

The biggest user-facing change: `uses: erp-mafia/compliancemaxx@v2` with no
inputs runs a fast, cheap LLM-only diff review (~90s, ~$0.05) and posts a
sticky markdown comment. No Docker, no scanners, no config required, no
manifests required.

### Three modes (renamed for clarity)

| Mode | What | LLM | Docker scanners |
|---|---|---|---|
| `review` (default, NEW) | LLM-only diff review | ✅ | ❌ |
| `scan` (was `pr`) | deterministic scanners only | ❌ | ✅ |
| `audit` (was `swarm`) | both | ✅ | ✅ |

`pr` and `swarm` still work as deprecated aliases (with a warning log).

### Manifest-less skills

Skills can now ship as just `SKILL.md` (with optional YAML frontmatter) for
review-mode-only contributions. `manifest.yml` is still required for
scan/audit modes that drive deterministic scanners.

### Migration

- Bumping `@v1` → `@v2` with **no other changes** switches you from PR-mode
  scanner runs to lightweight LLM review. To keep v1 behavior, add
  `mode: scan` to your action invocation.
- The `mode` input is no longer required; defaults to `review`.
- `.compliance/config.yml` is now optional with sensible defaults.

### Internals

- New `runReviewMode()` runner in `src/skills/review.ts`.
- Loader supports both manifest-driven and SKILL.md-only skills.
- Mode aliases handled at the orchestrator boundary (`normaliseMode`).
- 10 new unit tests; 57 total green.
