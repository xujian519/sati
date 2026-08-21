## 1. Metacognitive control module

- [ ] 1.1 Create `src/agent/loop/metacognitiveControl.ts`: `parseSelfEstimate(text)` (bracket-marked confidence/diagnosis), `buildMetacognitivePrompt()`, and `shouldRetryDiagnosis(text)`.
- [ ] 1.2 Create `tests/agent/loop/metacognitive-control.spec.ts` (parse strong/thin/shaky, no-tag, diagnosis extraction, retry-prompt embedding).

## 2. AgentLoop wiring

- [ ] 2.1 In `src/agent/loop/AgentLoop.ts`, append the metacognitive prompt to the system prompt in `createModelRequest` when enabled.
- [ ] 2.2 In `handleNoToolCalls`, parse the confidence tag; on `shaky` (and not already retried) inject a transient retry prompt carrying the diagnosis via `continueWithTransientPrompt`, and set a per-turn guard.

## 3. Config + gate

- [ ] 3.1 Add `metacognitiveControl?: boolean` and `metacognitivePrompt?: string` to `src/agent/runtime/AgentRuntimeConfig.ts`.
- [ ] 3.2 Add `SATI_METACOGNITIVE_CONTROL` env gate and wire it in `src/cli/createLocalGateway.ts` + `src/env.ts`.

## 4. Full verification

- [ ] 4.1 Run `pnpm typecheck && pnpm lint && pnpm format:check` and the new test.
