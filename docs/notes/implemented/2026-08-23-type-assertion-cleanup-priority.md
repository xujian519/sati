# Agent Note: Prioritize type-assertion cleanup as the highest-ROI tech-debt item

Status: implemented

## Problem

`.brooks-lint.yaml` (R4 suppressed for `src/workflow/**`) and the tech-debt ledger
(`docs/technical-debt/backlog.md`) left the team with a large, evidence-backed backlog but no
ranking across decay-risk types. During the Brooks-Lint re-review, the ledger's own metrics showed
that while module-level dependency hygiene is good (no module cycles, no `src→ui` imports), the
dominant remaining risk is type-assertion/contract erosion: >90 sites across the codebase cast
`unknown`/DB rows to concrete types with `as never`, `as XResult`, `as X`, or `as unknown as X`. This
was tracked as `TD-TYPE-002` (issue #163) but had not been scheduled ahead of other, more visible
work (frontend god-components, policy-bridge wiring, engine unification).

## Decision

Rank #163 (type-assertion convergence) as the **first** item in the tech-debt remediation order
(`docs/technical-debt/next-batches-schedule.md` §7), ahead of the frontend god-component split
(#159) and the multi-engine unification (#150). Rationale: it is mechanical, self-verifying via
`tsc`, has no UI and no behavior change, touches no tool `inputSchema` (so llm-replay fixtures
stay valid), and has the smallest blast radius in the list. Break it into independent per-module
PRs as specified in `docs/type-assertion-cleanup-plan.md`.

Also confirmed (not re-litigated): keep #150 deferred until its 2026-11-18 capability evaluation,
per `2026-08-23-defer-multi-engine-unification.md`; keep #161 (policy-bridge) last because it
affects the global permission path.

## Alternatives considered

- **Start with the frontend god-component split (#159)** — rejected as the opening move; it
  requires browser verification, has the largest blast radius, and does not recover compile-time
  type guarantees.
- **Start with engine unification (#150)** — rejected; already deferred with a hard deadline and a
  capability-vs-consumer evaluation as the gate, and it is higher-risk than a mechanical type pass.
- **Don't create a ranked order / treat backlog as a flat list** — rejected; an unranked backlog
  invites the team to pick by visibility (the flashier item) rather than by ROI.
- **Chosen**: rank #163 first and slice it per module.

## Consequences

- The team now has an explicit first move for the debt batch: converge the >90 type assertions
  module by module, each slice independently verified by `tsc`.
- This does not change runtime behavior, so it is safe to run as a low-risk filler alongside other
  work; it also sets up a narrower, typed contract for the later gateway client/server work.
- The ranking is recorded in the schedule file; if priorities shift, edit that file — do not edit
  this note to change the ranking (per `docs/notes/README.md` rule 2).
