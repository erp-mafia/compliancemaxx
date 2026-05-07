# compliancemaxx

## 1.0.2

### Patch Changes

- [`976b08f`](https://github.com/erp-mafia/compliancemaxx/commit/976b08fc2b527c8c4498ba7996563db5499dc5e4) Thanks [@jakobwennberg](https://github.com/jakobwennberg)! - Fix two issues that surfaced on first real-world swarm-mode runs:

  - **`require is not defined` in deep_audit**: the agentic finding extractor
    used CommonJS `require('node:crypto')` inside an ESM module, crashing
    every deep_audit step _after_ the LLM successfully returned. Replaced
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

## 1.0.1

### Patch Changes

- [`b4238ee`](https://github.com/erp-mafia/compliancemaxx/commit/b4238ee5e8ad30ce1b4534c5f57e5ea0f1706eee) Thanks [@jakobwennberg](https://github.com/jakobwennberg)! - `action.yml` now executes the published npm package via `npx -y compliancemaxx@$GITHUB_ACTION_REF` instead of installing the action's own checkout. This fixes a path-resolution bug: when the package was installed inside `packages/cli/` of the action's checkout, npm workspaces hoisted `tsx` to the root `node_modules/`, breaking the hardcoded path. Using the published package side-steps the problem and means consumers always run a tested release.

## 1.0.0

### Major Changes

- [`1f716a9`](https://github.com/erp-mafia/compliancemaxx/commit/1f716a9161747806b6332825d4ff59309519be5d) Thanks [@jakobwennberg](https://github.com/jakobwennberg)! - First stable release. The action's `with:` inputs and the JSON dossier shape
  are now considered the public contract; breaking changes will require a major
  version bump from here on.

  No behavior changes from 0.1.1 — this release exists so consumers can pin
  `uses: erp-mafia/compliancemaxx@v1` (the floating major tag) per the
  documented quickstart.

## 0.1.1

### Patch Changes

- [`5686758`](https://github.com/erp-mafia/compliancemaxx/commit/568675885e056dd698d6cd06fe455744bc16df92) Thanks [@jakobwennberg](https://github.com/jakobwennberg)! - First release through the OIDC trusted-publisher pipeline.

  - Bundle `packages/skills/` into the npm tarball via `prepack` so
    `npx compliancemaxx` works without checking out the repo.
  - `release.yml` no longer needs `NPM_TOKEN`; npm trusted publishing
    mints a short-lived OIDC token at publish time and produces
    provenance attestations automatically.
  - Canonicalize `bin` and `repository.url` per `npm pkg fix`.
