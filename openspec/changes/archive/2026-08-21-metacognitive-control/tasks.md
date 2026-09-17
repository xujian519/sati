> **验收状态（2026-09-18 补）**：本文件是历史快照，勾选状态曾长期停留在交付前（见 #359）。
> 截至 2026-09-18 复核：未勾选 7 项中 **5 项已交付**（已回填勾选）、**1 项仍未交付**、**1 项无法核实**。本变更全部产物随提交 `651b77b0` 落地（已在 main）。
>
> - 已交付：1.2 测试 —— 证据 `tests/agent/loop/metacognitive-control.spec.ts`（8 用例：strong/thin/shaky `:15`、同义词 `:21`、无 tag `:26`、诊断提取 `:32`/`:38`、retry prompt 携带诊断 `:43`/`:48`）；2.1 系统提示追加（配置开启时）—— 证据 `src/agent/loop/modelRequest.ts:116-118` + `:133-134`（`appendSystemPrompt` 数组内 `metacognitiveAddendum`）；2.2 shaky 带诊断重试 + 每轮守卫 —— 证据 `src/agent/loop/AgentLoop.ts:705-716`（位于 `handleNoToolCalls`，函数起于 `:552`）+ 每轮状态 `src/agent/loop/turnRuntimeState.ts:45`；3.1 配置字段 —— 证据 `src/agent/runtime/AgentRuntimeConfig.ts:81`/`:83`；3.2 env 门 —— 证据 `src/env.ts:66` + 接线 `src/cli/agentSessionConfig.ts:147`（`createLocalGateway.ts` 内联实现后被 `61c7feaa` 抽到 `agentSessionConfig.ts`，接入点未变）。
> - 仍未交付：1.1 的 `shouldRetryDiagnosis(text)` —— 该同名函数从未落地，模块 `src/agent/loop/metacognitiveControl.ts` 只导出 `parseSelfEstimate:33` / `buildMetacognitivePrompt:47` / `buildMetacognitiveRetryPrompt:62`；「是否重试」的判定改为 `AgentLoop.ts:707` 内联的 `estimate.tag === "shaky"` 判断。
> - 无法核实：4.1 全量验证 —— 条目是一次性命令 `pnpm typecheck && pnpm lint && pnpm format:check` + 新测试，仓库内不存该次运行结果，无法用产物判定（只能确认同批产物已随 `651b77b0` 合入 main）。

## 1. Metacognitive control module

- [ ] 1.1 Create `src/agent/loop/metacognitiveControl.ts`: `parseSelfEstimate(text)` (bracket-marked confidence/diagnosis), `buildMetacognitivePrompt()`, and `shouldRetryDiagnosis(text)`.
- [x] 1.2 Create `tests/agent/loop/metacognitive-control.spec.ts` (parse strong/thin/shaky, no-tag, diagnosis extraction, retry-prompt embedding).

## 2. AgentLoop wiring

- [x] 2.1 In `src/agent/loop/AgentLoop.ts`, append the metacognitive prompt to the system prompt in `createModelRequest` when enabled.
- [x] 2.2 In `handleNoToolCalls`, parse the confidence tag; on `shaky` (and not already retried) inject a transient retry prompt carrying the diagnosis via `continueWithTransientPrompt`, and set a per-turn guard.

## 3. Config + gate

- [x] 3.1 Add `metacognitiveControl?: boolean` and `metacognitivePrompt?: string` to `src/agent/runtime/AgentRuntimeConfig.ts`.
- [x] 3.2 Add `SATI_METACOGNITIVE_CONTROL` env gate and wire it in `src/cli/createLocalGateway.ts` + `src/env.ts`.

## 4. Full verification

- [ ] 4.1 Run `pnpm typecheck && pnpm lint && pnpm format:check` and the new test.
