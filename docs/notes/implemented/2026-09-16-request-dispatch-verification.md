# Agent Note: 请求侧对拍改在派发点，差异必须被声明

Status: implemented

## Problem

`request_header` 快照是「模型可见 = 已记录」在请求侧的**唯一**验证手段。但生产路径的对拍器用**同一对** `(request, decision)` 既生成快照又做比对：`AgentLoop` 以该对入参算出快照，`await input.onRequestHeader?.(…)` 之后又拿同一对入参调 `verifyRequestHeaderSnapshot`；而被调函数里的期望值本身就是 `buildRequestHeaderSnapshot(request, decision)`，是个只读纯函数。

于是比对**恒等**：除 `onRequestHeader` 的 await 窗口里有人原地改写 `request` 对象（生产接线只做落盘，不会）之外，永不触发。它提供的是虚假保证——模块注释与 `CLAUDE.md` 都宣称「篡改（如路由后 maxOutputTokens 被改）必报」，而被点名的那个例子恰好是它看不见的那类：装配态在 `AgentLoop`，输出上限夹取发生在 router 内部。

台账 `TD-AGENT-N01` / issue #360 记录了该缺陷并给出两个修复方向；核码后两个方向都需要修正（见下）。

## Decision

把对拍的**点位**与**判据**分开重做：

1. **点位**：新增 `RouterExecuteContext.onDispatchRequest`。router 在两条派发路径（`enabled` 的 attempt 循环、`enabled: false` 的直通分支）**送出首字节之前**各报一次：即将交给 `modelRuntime` 的请求、该 attempt 的有效决策、本次派发实际施行的改写标签（`RouterTransformTag`）。
2. **判据**：`verifyDispatchedRequest` 要求「落盘快照与派发请求的字段级差异 ⊆ 本次派发标签声明的字段集」。标签到字段的映射在 `requestInvariant.ts` 用 `Record<RouterTransformTag, …>` 强制穷尽——新增标签却忘记登记字段会**编译失败**，「改写必须声明」因此不靠注释承重。
3. **替掉自比**：`AgentLoop` 不再调 `verifyRequestHeaderSnapshot(requestHeader, request, decision)`，改为在 `execute` 的 ctx 上提供 `onDispatchRequest`，且仅在 `SATI_VERIFY_REQUEST_RECONSTRUCTION=1` 时提供（未开启即零开销）。
4. 快照的**落盘时机与内容都不变**（仍是发送前、仍记 loop 装配态）——理由见下。

判据不再恒真的原因：两侧由**不同入参**派生——落盘侧来自 loop 装配态与决策，派发侧来自 router 逐 attempt 施行的结果。这是变换式判据（「差异 ⊆ 声明」），不是识别式（「像不像某个已知形态」）。

## Alternatives considered

- **方向 A（issue 推荐）：生产路径改用 `verifyRequestReconstruction`** — 落选：**它修不了这个洞**。该函数内部仍是 `verifyRequestHeaderSnapshot(entry.header, request, decision)`，期望值照样由传入的同一对 `(request, decision)` 派生，而落盘的 `entry.header` 同样是这对入参算出来的。换过去只多一项「落盘—读回」的序列化保真，对 issue 点名的三类漂移（materialize 改写 / 工具集被过滤 / 输出上限被路由调整）依旧无能为力。issue 称它「真正有牙齿」是核码前的判断。
- **方向 B：把注释与 `CLAUDE.md` 的承诺降级为「仅检测入参原地改写」** — 落选：诚实，但把请求侧留成空白。它正确的部分（不该保留假承诺）已并入文档修正。
- **让快照直接记派发值（把落盘点移进 router）** — 落选：pre-send 落盘是 `request_header` 作为 durable 标记的语义基础，`TaskResumeScanner` 的 (a) 形态判定依赖「request_header 已落、响应未到」；且持久化失败会在 router 生成器内抛出、被 `AgentLoop` 现有 catch 归成 `agent_model_error`，fail-closed 的错误归因被搅浑。代价换来的只是快照多填几个字段，而那几个字段的差异现在已被逐条声明并验证。
- **在 loop 侧重算 `materializeRequest(decision, request)` 作为快照来源** — 落选：它在一条真实配置上不成立。`enabled: false` 的直通分支**不**走 `applyDecisionToRequest`（`requestPatch` 与 `subagentTagStripped` 在该路径不生效），loop 侧重算会记下一个从未上网的形态。`tests/router/request-dispatch-report.spec.ts` 首个用例已钉住「直通路径不声明未施行的改写」。
- **给差异设粗粒度白名单**（如「凡有改写即放行全部字段」） — 落选：那会把 `systemPromptDigest` / `toolSchemaDigest` 一起放开，恰是「工具集被静默过滤」这类漂移的落点。`tests/agent/loop/request-invariant.spec.ts` 有一条表驱动用例：每个标签在自己的越界字段上仍须转红。

## Consequences

- 请求侧第一次有了**可被证伪**的判据。负控制：往 `applyDecisionToRequest` 注入一处未声明的静默系统提示改写 → 走真实路由链路的用例转红；还原 → 复绿。接线层另有常驻负控制：同一处未声明漂移，开关关时回合正常完成、开关开时回合失败。
- 如实记录的边界：
  - 快照记的是 **loop 装配态**。合法改写（输出上限夹取、逐 attempt 媒体降级、fallback 换 provider/model、子代理标记剥离）造成的差异被**声明并放行**，而不是被记录——判据保证「差异不超出声明」，**不**保证「快照等于线上形态」。
  - 对拍失败经 `AgentLoop` 现有 catch 归类为 `agent_model_error` 的 `stop_failure`（回合失败，消息里点名字段），不新增错误分类。
  - 开关默认关（与旧实现一致），默认路径零开销、也零保护。
- 核码顺带发现两处**声明了却零生产者**的字段，本 PR 未清理（已登记在 issue 结论）：`RouterDecision.requestPatch` 全仓无写入点（`RouterRequestPatch` 的 `tools` / `systemPrompt` 分支因此从未生效）；`RouterMutationsLog` 的 `systemPromptSlim` / `toolsStripped` 只在类型里存在。映射表已为 `requestPatch:*` 预留标签，一旦真有生产者，对拍会立即要求同步声明。
