# compliancemaxx

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
