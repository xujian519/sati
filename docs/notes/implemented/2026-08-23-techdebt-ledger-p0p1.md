# Agent Note: Adopt in-repo technical-debt ledger and remediate P0/P1 (2026-08-23)

Status: implemented

## Problem

Sati's codebase had no persistent, evidence-backed record of technical debt or
code smells. Prior audits produced one-off markdown reports that went stale
immediately, and there was no reproducible way to re-measure trends or to track
whether a given finding was fixed. Medium-priority security/consistency defects
identified during a full-repository audit (a handful of P0/P1 items) were
therefore unowned.

## Decision

Adopt an in-repo "living ledger" as the single source of truth for technical
debt:

- `docs/technical-debt/` — `README.md` (severity/effort/status machine + how to
  stay fresh), `metrics.md` (auto-generated baseline), `backlog.md` (evidence-
  backed entries keyed by `file:line`, across B1–B6 module batches and a B6
  cross-cutting synthesis with a prioritized remediation plan).
- `scripts/measure-techdebt.mjs` — read-only, idempotent, eslint/biome-clean
  metrics script (TS-compiler-API god-function detection, boundary checks,
  test coverage, i18n diff) so trends are re-measurable via
  `node scripts/measure-techdebt.mjs --update`.

Then remediate the P0/P1 "immediate" slice: three security fixes (MCP path
traversal, permission-corruption fail-safe, desktop port mis-kill), three data-
consistency fixes (wrong `workflow_failed.error` step id, duplicated PRD
template source, corrupt `tasks.json` silent reset), and two test-reliability
fixes (dropped weixin source-scanning pseudo-tests, explicit `t.skip` on the
llm-replay drafting fixture).

The workflow-engine regression test sits in `tests/workflow/WorkflowEngine.test.ts`,
which matches the repo's `.gitignore` `*.test.ts` "local draft" rule; per the
documented convention ("force-add intentional new tests with `git add -f`") it
is force-added so the P0/P1 fix carries its regression test.

## Alternatives considered

- **Keep one-off reports / no tracking**: rejected; reports rot immediately and
  there was no per-finding status to prove remediation, which is the whole point
  of an audit follow-through.
- **Issue-tracker-based tracking only**: rejected as the primary record; the team
  wanted a repo-local ledger co-located with the evidence (`file:line`), with the
  metrics script as the re-measurable baseline, and no dependency on an external
  tracker.
- **Force-add the whole ancient workflow test file**: chosen for the workflow
  regression test. Alternatives — omit the regression test (violates "core module
  change ships a test") or relocate to a new `.spec.ts` (splits the engine test
  suite across two files) were both worse.
- **Patch the permission fix to fail-loud (throw) instead of fail-safe**: rejected;
  throwing on a corrupt `permissions.json` would break startup for every user,
  whereas backing up + `skipPermissions:false` keeps the app usable while
  surfacing the corruption.

## Consequences

- The ledger is repo-local and single-sourced; metrics are regenerable via the
  committed script for quarterly trend checks.
- The P0/P1 "immediate" remediation slice is closed; remaining P2/P3 debt is
  tracked in the backlog with the B6 §C remediation plan as the roadmap.
- `tests/workflow/WorkflowEngine.test.ts` is now under version control, closing
  the gap where the dormant-but-exported workflow engine had no committed direct
  engine tests.
