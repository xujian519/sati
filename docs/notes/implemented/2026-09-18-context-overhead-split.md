# Agent Note: 上下文用量分列显示固定开销与对话用量（协议 1.10）

Status: implemented

## Problem

UI 的上下文气泡只有一个百分比加一句合计（`ui/src/components/chat-v2/ComposerV2.tsx` 的 `getContextStatus`：`displayUsed / total`）。而 `used` 里含 system prompt + 工具 schema 这一大块**与对话无关**的开销——本机实测首轮 37,517 tokens 里有 37,504 是固定开销，对话只占 13。用户看到「2% 已用」，读到的却是「我们的对话已经用了 2%」（#450 第 5 条）。

数据面根本没有这个拆分可给：`TokenBudgetSnapshot` 只暴露 `tokens` / `displayTokens`（合计），UI 无法从中推导，也没有 tokenizer 可以自己估。

## Decision

**在估算处顺手拆出固定开销，沿既有通路透传，UI 分两行显示。**

- 拆分点选在已经有这个信息的唯一位置：`TokenAccountingRuntime.estimateRequestInputOnce` 本就分别算出 `rawMessages` / `system` / `tools` 三段，新增返回 `fixedOverhead = system + tools`，**零额外编码成本**（不新增 tokenizer 调用）。
- 快照新增可选字段 `fixedOverheadTokens`（`TokenBudgetSnapshot`），语义：本地估算里不随对话增长的那部分。缺失 = 未拆分。
- 透传走既有链路，逐段都是加一个可选字段：`AgentEvent.context_budget.snapshot` → gateway frame（`context_budget`）→ web client `tokenBudget` → `ui/server/sati-bridge.js` → UI。transcript 的 `agent_status_message(context_budget)` 本来就整包存 `detail`，`sessionTokenUsage.latestContextBudget` 补一条投影规则即可让刷新页面后拆分仍在。
- 协议 **1.10**：无新方法，`context_budget` 新增可选 `fixedOverheadTokens`；旧客户端忽略该字段即退回单一用量。
- UI：`getContextStatus` 给出 `fixedOverhead` / `conversation` 两段（百分比同分母，都是模型完整窗口），**对话用量 = 合计 − 固定开销并夹取到非负**，因此两行数字恒等于合计本身，不会出现三行互相矛盾；字段缺席时 `known` 但两段为 `undefined`，气泡退回只显示合计。展示逻辑抽成 `ContextStatusPopover`，主组件因此不再继续膨胀（`ComposerV2` 函数 780 → 736 行，见指标基线）。
- 顺带修：气泡锚点从 44px 宽的按钮移到整条工具条（加 `relative`）。原锚点下 256px 气泡左溢，被助手面板的 `overflow-hidden` 裁掉——窄面板里「Context window」显示成「ext window」、数字被切半。已核对 `origin/main` 的类名逐字相同，属先前就有的缺陷，本次一并修掉（1601px 与 900px 两档实测气泡落在面板内）。

## Alternatives considered

- **只在 UI 侧估算固定开销** — 落选：UI 没有 tokenizer，自己估必然与后端显示口径不一致，等于再造一个易漂移的 `used`。
- **拆成三段（system prompt / 工具 schema / 对话）** — 落选：气泡 256px 放不下三段而不换行，用户要回答的问题只是「为什么一上来就少了四分之一」，两段足够；再细的分解该走设置页或诊断面板。
- **让 provider 计数也给出拆分** — 落选：provider 只回一个 `input_tokens` 总数，没有分项；拆分只能来自本地估算，故取值与合计不同源时以合计为准（见 Consequences）。
- **压缩重建路径（`buildCompactTokenBudget`）也带拆分** — 本轮不做：那条路径的 `used` 取自 `postTokens`（`estimateMessages` 的**消息**估算，不含 system/工具），此刻合计里本就没有固定开销，硬塞字段会让两行之和 ≠ 合计。这是既有的口径不对称（压缩后百分比按消息口径、下一轮快照又回到含开销口径），改它要动压缩后的百分比与告警阈值，属独立决策。
- **把气泡改成 portal 定位，彻底不受面板 `overflow-hidden` 约束** — 未采纳：为一次位置问题引入 portal + 手动定位与滚动跟随，成本高于收益；挂到工具条右缘已解决实测的两种布局。
- **只改 tooltip 文案（"已用含固定开销"）** — 落选：用户要的是分清两块，不是读一句免责声明。

## Consequences

- 用户能一眼看出「37.5k 是提示与工具，13 是对话」——首轮 2% 里真正属于对话的部分是 0%。（本机实测数据；同一气泡同时给出百分比与两段 token 数。）
- 换来了 `fixedOverheadTokens` 这个**展示口径**的契约：它由本地估算给出，而合计可能是 provider 精确计数。两者不同源时对话用量 = 合计 − 本地开销，会吸收估算误差；夹取保证不出现负数，也不会让三行数字互相矛盾。
- 已知限制一：**面板宽度 < 约 304px 时气泡仍会横向溢出被裁**（面板 `overflow-hidden` 是聊天滚动所需的），本次只保证常见布局两档（1601px / 900px 实测通过）。
- 已知限制二：**压缩后到下一轮快照之间**，气泡退回只显示合计——那段时间的预算来自压缩重建，没有拆分字段；下一轮请求的快照立刻恢复拆分。
- 已知限制三：气泡在两行拆分之外仍只显示一个总百分比（口径 = `used / 模型完整窗口`，也就是自动压缩阈值所依据的那个数）。百分比刻意不拆，避免用户拿两个不同的分母互相比较。
- 协议 1.10 只加可选字段，Web 客户端镜像（`SATI_GATEWAY_PROTOCOL_VERSION_WEB = "1.0"`）同 MAJOR 不受影响；两个钉住当前版本的用例（`tests/gateway/discovery-protocol.spec.ts`、`tests/gateway/protocol-versioning.spec.ts`）随 bump 同步更新。
