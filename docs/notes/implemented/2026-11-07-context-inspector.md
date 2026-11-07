# Agent Note: 模型上下文检查器（只读快照 sidecar）

Status: implemented

## Problem

`request_header` 只记录 provider/model 与 system prompt、工具 schema、消息条数的摘要（digest），用户无法回答「模型这次到底收到了什么」。排查提示词漂移、工具 schema 误改、压缩后上下文异常时，只能靠日志与猜测。

已有的上下文气泡只显示 token 用量，不显示内容；把完整请求写进 transcript 又会污染重放投影与历史体积。

## Decision

- 新增 `src/session/context/ModelContextSnapshot.ts`：
  - `createModelContextSnapshot(request, turnId)` 深拷贝请求；媒体块 `data` 替换为占位符并置 `mediaOmitted`；`tool_result.raw` 剥离。
  - 写入 `<transcript>.context.json`：目录 0700、文件 0600、临时文件 + rename 原子落盘。
  - 读取拒绝符号链接/非普通文件，校验 `version`/字段形状；缺失或坏 JSON 返回 `null`。
- `AgentLoopInput.onModelContext` 在请求装配完成、发送前调用（与 `onRequestHeader` 同点），回调失败不阻断请求。
- `TurnRunner` 用 `runtimeContext.transcriptPath` 写 sidecar；失败只告警。
- `readSessionMessages` 增加 `includeModelContext?: boolean | "summary"`：只有显式请求才读 sidecar；快照 `turnId` 必须等于最近一次 `accepted_input`，否则返回 `stale`，不把旧上下文当当前上下文。
- HTTP 路由透传查询参数并返回 `modelContext` / `modelContextStatus`。
- UI：上下文气泡增加「查看上下文」入口；`ContextInspector` 以 portal 模态展示 system / tools / messages，支持搜索与 Esc 关闭；状态放在 `ComposerV2`，不放在气泡内部。
- 删除会话时一并删除 sidecar；fork/重写不复制快照。

## Alternatives considered

- **把完整请求写进 transcript。** 落选。会进入重放/压缩/历史投影，改变既有契约与体积；sidecar 是旁路诊断。
- **通过流式 WebSocket 广播快照。** 落选。system prompt 与工具 schema 属敏感内容，广播面超出需要；HTTP 按需读取更窄。
- **默认开启快照。** 落选。每次模型请求都多一次磁盘写；默认只在用户打开检查器时读取，写入本身成本可控但不应无条件扩大落盘面。
- **新增工具来查询上下文。** 落选。会改工具目录与 `inputSchema`，触发 llm-replay 重录；上下文检查是 UI 能力，不是模型能力。
- **把检查器模态挂在气泡组件内部。** 落选。浏览器验证发现：气泡在点击时因失焦被父级 `onBlur` 卸载，模态随之消失。状态上移到 `ComposerV2` 后修复。
- **只返回摘要（summary）作为默认。** 落选。用户打开检查器就是要看内容；摘要只用于需要元信息时。

## Consequences

- 每个会话最多多一个 `<transcript>.context.json`；删除会话会清理，历史遗留文件不影响读取。
- 快照代表「最近一次模型请求」，不是整个 turn 的全部请求；多轮工具循环会覆盖为最后一轮。
- 诊断信息包含 system prompt 与消息原文，属本地敏感数据：0600、按需读取、不进 transcript、不广播。
- `AgentLoop.ts` 增加 2 行（import + 回调调用）；已在 `docs/technical-debt/architecture-baseline.json` 显式追认（1150 → 1152），未做无关重构。
- 浏览器验证覆盖：入口、缺失状态、完整快照三区切换、搜索过滤、Esc 关闭；验证用快照已删除。
