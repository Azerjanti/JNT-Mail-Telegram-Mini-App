---
name: PNPM workspace dependency repair
description: Restoring a package already declared in a pnpm workspace when its installed link is missing.
---

When a dependency already exists in an artifact's `package.json` and `pnpm-lock.yaml` but cannot be resolved at build time, restore workspace links with `pnpm install --filter @workspace/<package> --frozen-lockfile`.

**Why:** The generic package-install callback ran `pnpm add` from the monorepo root and pnpm rejected it with `ERR_PNPM_ADDING_TO_ROOT`; adding the package at root would have been the wrong fix.

**How to apply:** Use the filtered frozen install for dependency reconciliation. Only add a dependency to the artifact manifest if it is genuinely missing there.