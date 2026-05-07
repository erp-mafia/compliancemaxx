---
'compliancemaxx': patch
---

First release through the OIDC trusted-publisher pipeline.

  - Bundle `packages/skills/` into the npm tarball via `prepack` so
    `npx compliancemaxx` works without checking out the repo.
  - `release.yml` no longer needs `NPM_TOKEN`; npm trusted publishing
    mints a short-lived OIDC token at publish time and produces
    provenance attestations automatically.
  - Canonicalize `bin` and `repository.url` per `npm pkg fix`.
