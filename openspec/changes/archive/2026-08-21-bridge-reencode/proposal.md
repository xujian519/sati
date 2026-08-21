## Why

Models often jump to a conclusion first and reconstruct the supporting steps afterwards ("conclusion-first rationalization"), which fails exactly on chains they have not seen before. Two cheap prompt-level corrections help: re-encoding the requirement in one line before working (to buy back recurrence the architecture lacks), and letting the required intermediate light up before the conclusion consumes it.

## What Changes

- Add a methodology component that, when triggered, injects a "bridge-before-conclusion + re-encode" prompt: restate the requirement in one line, then let the needed intermediate form before the conclusion.
- Register it in the default methodology registry so it is injected on matching tasks.

## Capabilities

### New Capabilities

- `bridge-reencode`: a trigger-gated prompt that asks the model to re-encode the requirement and let the bridge concept form before the conclusion.

### Modified Capabilities

None.

## Impact

- **New source**: `src/methodology/runtime/components/bridge-reencode.ts`.
- **Modified source**: `src/methodology/runtime/MethodologyRegistry.ts` (register in `DEFAULT_METHODOLOGY_COMPONENTS`).
- **Tests**: `tests/methodology/bridge-reencode.spec.ts`.
- **Config**: reuses the existing methodology-injection path (trigger-gated, no new config).
