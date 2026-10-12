# Agent Note: eventMapping 映射表化——mapAgentEventForTurn 417 行 switch → 按种类查表（#646 sweep P2.2）

Status: implemented

## Problem

`src/gateway/client/eventMapping.ts` 的 `mapAgentEventForTurn` 是把 `AgentEvent`（45 个种类的判别联合）映射成 `GatewayEvent[]` 的唯一入口，全部塞在一个 **417 行的 switch**里（backlog §38.1 P2 批次第 2 位，计划 §5 P2.2）。它是 P2.1 `submitTurn` 拆分后的直接下游：UI 看到的**每一个** gateway 帧都经此函数产出，且与 B1.2 `useChatRealtimeHandlers` 互为契约接缝（计划 §9 R7——「任一侧未绿另一侧不动」的接缝对）。

问题不在"长"本身，而在三点：

1. **结构性沉默**：16 个帧面不产出的事件种类靠 switch 的 `default: return []` 兜底，其中 4 个（`session_started` / `input_accepted` / `assistant_message` / `doomloop_signal`）连 case 标签都没有——读到 switch 末尾的人无法确认"这是穷举后的主动沉默，还是忘了映射"。
2. **新增种类无编译期强制**：`AgentEvent` union 加新种类时，不改这个 switch 也能编译过、测试也可能全绿（帧面沉默是合法行为），沉默是否正确只能靠人记得回来对表。
3. **复合分支淹没简单分支**：`tool_result`（含落盘 IO + 图片/附件投影）、`tool_results_projected`（三种 block 的序列化规则）两个大分支与十几行一行的直通帧平铺在同一视觉层级，读者无法一眼看出「哪些种类是纯投影、哪些有副作用、哪些是有意的静音」。

通过判据：计划条目原文「映射表化，事件矩阵不变」——矩阵语义不变（每事件生产/消费计数不漂移），帧形状逐字节不变。

## Decision

**45 个种类全部进一张 required Record 映射表 `AGENT_EVENT_MAPPERS`，按「直通帧 / agent_status 投影 / 复合映射 / 帧面静音」四组排布**；复合分支落到具名函数（`mapToolResultEvent` / `mapToolResultsProjected` / `mapSubagentToolResultEvent` / `mapContextBudgetEvent` / `mapTurnFailedEvent` / `mapSessionAbortedEvent` / `mapToolCallsDetected` / `mapSubagentToolCallsDetected`），原 `mapModelEvent` / `mapSubagentModelEvent` / `mapTurnCompleted` 保持不动。`mapAgentEventForTurn` 收缩为查表 + runId 之外的唯一防御分支（运行时传入 union 之外的旧事件类型 → `[]`，对齐旧 `default` 语义）。

关键决策点：

1. **表类型用 `{ [K in AgentEvent["type"]]: AgentEventMapper<K> }`（required，非 Partial）**。新增 `AgentEvent` 种类时 typecheck 直接报错强制补表项——把问题 2 从"纪律"变成"编译器义务"。旧 `default` 的静默面收敛为 dispatch 处一条带注释的 `undefined` 防御分支。
2. **帧对象一律在数组字面量里构造，不经 helper 调用传参**。`gen-event-matrix` 的 producer 启发式只认「调用表达式首参对象字面量"」（`scripts/gen-event-matrix.ts:202`）——旧代码里 `return [{ type: "agent_status", … }]` 本就不入矩阵，若表化时顺手抽 `statusFrame(event, detail)` 之类的 helper，会把约 12 个 `agent_status` 系帧变成矩阵新增 producer 行，矩阵语义漂移。此约束已写进文件头注释，防后人"简化"时踩中。
3. **矩阵最终只漂移 4 行、全部是同一 producer 的纯行号位移**（`assistant_attachment` ×1 / `structured_output` ×1 / `tool_result_detail_available` ×3 / `turn_completed` ×1 中的本文件行号），无新增/删除 producer——对拍 B1.2 所依赖的矩阵面保持计数不变。
4. **`persistToolResultText` 抽出但保持 fire-and-forget 语义逐字不变**（async IIFE、`mode: 0o600`、失败静默注释原样）。顺带消掉原 `writeFile(resultPath!, …)` 的非空断言——抽参后 `resultPath` 在函数签名里是确定的 `string`。这是唯一的"非逐字"点，属机械收窄。
5. **16 个静音种类显式列出**（`session_started` / `session_ended` / `input_accepted` / `user_prompt_submitted` / `setup_completed` / `instructions_loaded` / `assistant_message` / `pre_tool_execute` / `post_tool_execute` / `permission_requested` / `permission_denied` / `stop_requested` / `stop_failure` / `elicitation_requested` / `elicitation_resolved` / `doomloop_signal`），把旧 `default` 里隐式的 4 个也变成显式表项——行为零变化，但「有意沉默」从口头知识变成代码事实。

## Alternatives considered

- **保留 switch、只把大分支抽函数（不建表）**：能把 417 压到 ~120 行，但问题 1/2 原封不动——静音仍靠 `default`，新增种类仍无编译期强制。表的 required Record 才是本次拆分要买的性质。否决。
- **用 helper（如 `statusFrame(kind, detail)`）消除帧构造样板**：会触发决策点 2 的矩阵漂移（~12 个 `agent_status` 系新增 producer 行），与「事件矩阵不变」判据冲突。否决。
- **Partial Record + 运行时兜底**：静音种类不写表项、靠 `?? () => []` 兜底——表不再穷举，问题 1 退回 switch 形态，问题 2 的编译期强制也消失。否决。
- **把映射表拆到独立模块（如 `agentEventMappers.ts`）**：`eventMapping.ts` 525→表+函数约 530 行，远低于 800 行棘轮；拆模块只会让帧构造与表定义跨文件导航，且 `toolResultSanitize` 等私有 import 要跟着搬家。纯搬运，否决不切。
- **`detail` 投影再抽一层数据表（`{ token_cap_adjusted: ["token_cap_adjusted", e => ({…})] }`）**：多一级间接，类型上还得再处理异参函数联合的调用问题（Extract 交集为 never），收益只是少几行。否决。

## Verification

- **帧形状对拍（搬迁等价的核心证据）**：/tmp 语料脚本覆盖 **45 个种类全量 + 边界形态（context_budget 双快照回退链、tool_result 大结果落盘/图片/附件/data 消毒、turn_completed 带/不带 structuredOutput、session_aborted 带/不带 reason、未知类型 → [] 等）共 61 例**，在基线 commit 与拆分后跑 `mapAgentEvent` 输出 JSON **逐字节 diff = 0**（61/61）。`resultPath` 含本机 tmpdir 绝对路径，对拍时按路径内容哈希稳定化。
- **负控制 3 处**（每处都触发预期用例转红 + 语料 diff）：
  1. `mapTurnCompleted` 帧序翻转 → `turn_completed 顺序产出 structured_output 后 turn_completed` 红；
  2. `mapContextBudgetEvent` 的 `fixedOverheadTokens` 改取 `budgetTokens` → `context_budget 透传固定开销` 红（语料 diff 2 行）；
  3. `mapTurnFailedEvent` 删 `providerError` → `turn_failed 携带 providerError 映射` 红。
- **矩阵**：`pnpm gen:event-matrix` 后再 `--check` 绿；diff 仅 4 行纯行号位移（见决策点 3），生产/消费计数逐行不变。
- **门禁**：`pnpm check` EXIT=0（含 `check:event-matrix` / `check:techdebt-metrics` / 棘轮）；`pnpm test` **5494 pass / 0 fail**（`renderPatentDocument.spec` 一次 60s `testTimeoutFailure` 为本机负载产物，同文件隔离复跑 17/17 绿——与 P2.1 记录的本地环境噪声同类）；`pnpm test:pr-tooling` 绿；`pnpm --filter sati-ui test` **1286/1286**（复跑两次均绿）。
- **指标**：`pnpm measure:update` → God function 榜 `mapAgentEventForTurn | 417 | function` 移除（M1 ≥400 存量 32→31）；`src` 总行数 187672→187684（表项签名/注释净增 12 行）；文件 525→530 行，无 ≥800 棘轮面（该文件本就不在 `architecture-baseline.json` 豁免表）。

## Impact

- 计划条目：P2.2（D9–D18 第 2 项）✓；backlog §38.1 回填勾选。
- 后续：P2.3 `telemetry.ts:emitSessionTelemetry`（333 行）起，P2 批次余 15 项。
