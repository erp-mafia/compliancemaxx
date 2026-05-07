---
'compliancemaxx': patch
---

Fix two issues that surfaced on first real-world swarm-mode runs:

  - **`require is not defined` in deep_audit**: the agentic finding extractor
    used CommonJS `require('node:crypto')` inside an ESM module, crashing
    every deep_audit step *after* the LLM successfully returned. Replaced
    with a top-level ESM `import`. Bedrock LLM calls were always working;
    only post-processing was broken.

  - **Disable scanners with broken Docker image refs by default**:
    `ghcr.io/github/codeql-action/codeql-cli:latest` doesn't exist (CodeQL
    isn't published as a public Docker image) and `stonehenge/gdpr-scanner`
    (Helsinki GDPR Scanner) was a placeholder that doesn't resolve.
    Both now have `swarm_mode_enabled: false` so swarm-mode runs cleanly
    out-of-the-box. Consumers can opt back in by overriding the manifest.

  - **Fix scancode image path**: was `ghcr.io/aboutcode-org/scancode-toolkit`
    (denied), now `aboutcode/scancode-toolkit` on Docker Hub.
