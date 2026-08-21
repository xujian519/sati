## Why

Sati's `doomLoop` / `repeatToolReminder` are external circuit breakers that observe the model's behavior; they never read the model's own estimate of correctness. Turning that self-estimate (feeling-of-knowing / judgment-of-learning) into an explicit control interface raised a fixed model's pooled accuracy from 48.3 to 56.9 with no parameter updates. A "blank retry" is the same attempt at the same price; an estimate that selects no action is a comment, not a monitoring act.

## What Changes

- Inject a config-gated metacognitive prompt that asks the model to tag its confidence before finalizing and to carry a one-clause diagnosis into any retry.
- Parse the model's confidence tag; when `shaky`, the loop does not silently finish — it enforces one of: retry-with-diagnosis, externalize the weak step, or escalate the pass.
- Ensure retries carry the model's diagnosis (not a fixed prompt), matching the "retry with the diagnosis attached" protocol.

## Capabilities

### New Capabilities

- `metacognitive-control`: a model self-estimate → control-exit interface (trust / retry-with-diagnosis / reconcile) gated by config.

### Modified Capabilities

None.

## Impact

- **New source**: `src/agent/loop/metacognitiveControl.ts` (parse self-estimate, build prompt, choose exit).
- **Modified source**: `src/agent/loop/AgentLoop.ts` (inject prompt, enforce exit on `shaky`), `src/agent/runtime/AgentRuntimeConfig.ts` (`metacognitiveControl`, `metacognitivePrompt`), `src/cli/createLocalGateway.ts` + `src/env.ts` (env gate).
- **Tests**: `tests/agent/loop/metacognitive-control.spec.ts`.
- **Config**: `SATI_METACOGNITIVE_CONTROL` env gate (off by default).
