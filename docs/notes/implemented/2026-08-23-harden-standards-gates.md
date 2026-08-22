# Harden standards gates: @ts-ignore ban + negative control in check (2026-08-23)

## Status

Implemented

## Problem

Two "prose iron rules" from the standards baseline were not backed by a machine
gate (code review Important findings):

1. `AGENTS.md` rule 1 bans `@ts-ignore` ("用 @ts-expect-error"), but neither
   eslint config enabled `@typescript-eslint/ban-ts-comment`, so the rule could
   be violated silently.
2. The negative control `tests/development-standards/verify-config.spec.ts`
   asserts `strict`/`noFallthroughCasesInSwitch` remain on, but it only runs under
   `pnpm test` — not `pnpm check`. A `strict: false` regression would still leave
   `pnpm check` green (typecheck uses `--noEmit` and does not verify the flags).

## Decision

1. Enable `@typescript-eslint/ban-ts-comment: error` (root + ui eslint) banning
   `@ts-ignore`/`@ts-nocheck` and allowing `@ts-expect-error` with a description.
2. Add a no-build config-pin `scripts/verify-ts-config.mjs` wired as
   `pnpm check:config` at the head of `pnpm check`.

## Alternatives considered

- **Keep the @ts-ignore rule prose-only**: rejected; violates the standards' own
  "铁律必须有门禁" principle (§4b).
- **Enable ban-ts-comment as warn**: rejected; the rule is a hard prohibition, so
  warn would let violations land silently (and `--max-warnings 0` is not set).
- **Fold the config-pin into the existing `verify-config.spec.ts` only**: rejected;
  the spec is a compiled test that only runs under `pnpm test`.
- **Wire `pnpm test` into `pnpm check`**: rejected; the full test suite is slower
  and out of scope for the check gate.
- **Chosen**: lightweight `check:config` script + hard `ban-ts-comment` error.

## Consequences

- `@ts-ignore` / `@ts-nocheck` are now lint errors (0 pre-existing usages, so no
  regression); `@ts-expect-error` requires an accompanying description.
- `pnpm check` now begins with `check:config`, which fails if root/ui tsconfig
  drop `strict` or `noFallthroughCasesInSwitch`.
- `docs/development-standards.md` §4 updated to reflect both gates as enforced.
