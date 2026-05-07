---
'compliancemaxx': patch
---

`action.yml` now executes the published npm package via `npx -y compliancemaxx@$GITHUB_ACTION_REF` instead of installing the action's own checkout. This fixes a path-resolution bug: when the package was installed inside `packages/cli/` of the action's checkout, npm workspaces hoisted `tsx` to the root `node_modules/`, breaking the hardcoded path. Using the published package side-steps the problem and means consumers always run a tested release.
