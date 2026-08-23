# Agent Note: Defer multi-engine unification until capability evaluation

Status: implemented

## Problem

The patent domain carries three overlapping execution semantics:

- `src/workflow/` — declarative DAG engine, adapted from XiaoNuo, with `DagEngine` /
  `SafeEvaluator` / checkpoint handling.
- `src/patent/graph/` — SuperStep (BSP) graph engine ported from Mady `graph/pregel.go`,
  designed to be auto-executable / degradable / evaluable.
- `flexible-plan` — stage-level plan that emits `toManifest()` into the workflow path.

They converge on the same job — turn patent rules and workflows into executable, resumable
stages — but differ in error-retry, approval-gate passthrough, and executor branching. These
differences are documented as known deviations in `src/patent/graph/README.md`. The overlap is
flagged as R4 accidental complexity in `.brooks-lint.yaml`, and removing or merging any engine
is non-trivial: deleting the wrong one would strand real consumers.

## Decision

Keep all engines for now and set a deadline instead of deleting now. Recorded as an R4 entry in
`.brooks-lint.yaml` (date 2026-08-20, expires 2026-11-18): do not remove `src/workflow/**`
until a capability-coverage comparison plus the real needs of its two consumers
(`patent/graph/adapter`, `patent/workflow-dag`) is completed. `runWorkflow` remains the
compatibility entry point; `manifestToGraph` / `handlerToNode` already back it with an
equivalence test suite (happy path / interrupt / rollback), giving a future removal a safety net.

## Alternatives considered

- **Immediately delete `src/workflow` or the graph engine** — rejected; the two consumers'
  needs are not fully mapped, so the wrong engine could be removed and strand live flows.
- **Merge all engines into one now** — rejected; the most expensive option, and the drivers for
  each (DAG vs SuperStep vs stage-plan) are not yet reconciled against present requirements.
- **Keep indefinitely without a deadline** — rejected; this is exactly how accidental complexity
  accretes, so the deferral is bound to the suppress expiry (2026-11-18).
- **Chosen**: defer with an explicit deadline, confirmed by a capability-vs-consumer evaluation.

## Consequences

- Until 2026-11-18 the team carries the maintenance cost of overlapping engines (three mental
  models, plus the risk that a new feature picks the wrong engine).
- In exchange, no engine is removed before its consumer needs are known, and the `runWorkflow`
  equivalence suite is a safety net if a removal is later chosen.
- When the evaluation concludes, write a NEW note recording the delete/merge decision — do not
  edit this one (per `docs/notes/README.md` rule 2).
