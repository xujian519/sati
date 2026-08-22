# Address minor code-review findings on the standards baseline (2026-08-23)

## Status

Implemented

## Problem

Three Minor code-review findings on the standards baseline remain:

1. `verify-config.spec.ts` was a config-pin (asserts flags are set) but not a
   true "gate self-test" proving the typecheck gate actually rejects a violation.
2. `docs/development-standards.md` §5.4 called pre-push a "type 兜底" without
   noting it is local-only and bypassable; CI is the real authority.
3. `docs/notes/README.md` example pointed at a non-existent "首个 note".

A fourth Minor finding (eslint off-rule rationale) was verified instead of
changed: `no-case-declarations` has a real trigger
(`src/gateway/client/eventMapping.ts`), so the rationale comment is truthful.

## Decision

1. Add a gate self-test to `verify-config.spec.ts` that compiles a tiny fixture
   violating `noFallthroughCasesInSwitch` and `strict`, asserting `tsc` exits
   non-zero — proving the gate really blocks.
2. Add a note to §5.4 that pre-push is a local, bypassable fallback and CI's
   full gate set is the authority.
3. Point the `docs/notes/README.md` example at the actual first note.

## Alternatives considered

- **Leave the config-pin as-is**: rejected for finding 1; the reviewer flagged it
  as not proving the gate blocks, and the self-test is cheap (two `tsc` runs,
  ~2s).
- **Make pre-push non-bypassable**: rejected; server-side prevention isn't
  feasible for a local git hook, so the honest framing is "CI is authority".
- **Drop the stale example**: rejected; a concrete pointer is more useful.

## Consequences

- `verify-config.spec.ts` now has 3 tests (config-pin + gate self-test).
- §5.4 and `docs/notes/README.md` references are accurate.
- No change needed for the eslint off-rule rationale (verified truthful).
