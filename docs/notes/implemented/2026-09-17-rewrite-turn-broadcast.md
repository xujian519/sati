# Agent Note: rewrite 分支的回答流与 sati-command 走同一条广播路径

Status: implemented

## Problem

`ui/server/websocket/chat.js` 的 `handleChatConnection` 里有两条 writer：

- `writer`（`WebSocketWriter`）——**只回提交页**（`this.ws`；仅当提交页已关闭时才回落到同 userId 的全部连接）；
- `streamWriter`——`broadcastChatFrame(data, ws, userId)`，投给该会话的 watcher + 提交页 + 重连兜底。

`edit-last-turn` / `regenerate-last-turn` 两条分支把 gateway 流交给了 `writer`，
而 `sati-command` 分支交给 `streamWriter`（issue #411，复核见
`2026-09-17-ui-server-dead-surface-retirement.md` 复核 #1）。

这不是「少刷一点」：同一段代码先调用 `broadcastRewriteOptimisticFrames()`
把**乐观 user 行与 `Processing` 状态广播**给兄弟 watcher，紧接着把**回答流**
只回提交页 ⇒ 兄弟标签页停在 `Processing` 不动，直到它自己去 `check-session-status`。
即**半广播半私有**，是可见的界面错误。两处同在 `1014a694d`（PR #245，协议 1.7）内，
可确认为漏改而非省流：多标签页/多屏同看一个会话是这套代码明确支持并投入维护的场景
（`sessionWatchRegistry`、`browserSessionActivity` 引用计数、`/watch-session` 帧、
`panel_heartbeat` 离线判定）。

## Decision

两条 rewrite 分支的 `runChatViaGateway(..., writer, ...)` 改为 `streamWriter`，
与 `sati-command` 分支**同一个广播入口**。判据不写成「用了哪个 writer」（实现细节），
而写成行为：**同一会话的兄弟 watcher 必须收到这一轮的 `stream_delta`**。

**仍留在 `writer` 上的两处**是刻意的：`rewritten` 为假时的 `kind:"complete"` +
`rewriteError` 回复是对**提交者这次操作**的直接应答（提交页已经渲染了乐观行，
需要就地看到失败），且失败路径**不会**先广播 `Processing` ⇒ 兄弟页不存在卡住状态。

## Alternatives considered

- **保留 `writer`，另把每帧再广播一份** —— 落选：同一帧会经两条路径写出（提交页可能
  收到两遍），且「哪个 writer 发什么」这层判断会复制到每个新增帧类型上，正是本缺陷的成因。
- **让 `WebSocketWriter` 自己变成广播** —— 落选：`writer` 还被 abort / steer /
  permission-response 等**只属于提交者**的应答使用（`kind:"complete"` 携带
  `exitCode`/`steered`/`reason`），把它们广播给兄弟 watcher 会制造重复的
  「已中止」「已投递」提示。广播应是**逐调用点**的选择，不是传输层属性。
- **给 `streamWriter` 补全 writer 接口（setSessionId 等）后全局替换** —— 落选：
  `streamWriter` 目前只有 `send`，而 `runChatViaGateway` 只用 `send`；
  为了「统一类型」去补齐不会被调用的方法，会把一个协议窄口伪装成完整实现。
- **在前端轮询 `check-session-status` 兜住** —— 落选：把服务端的投递缺陷变成前端的
  轮询成本，且卡住的是「这一轮的答案」——轮询只能发现状态变化，拿不到已丢失的流。

## Consequences

- **行为变化**：编辑/重新生成最后一轮时，同一会话的兄弟标签页现在会收到完整的回答流，
  不再停在 `Processing`。提交页的投递不变（`broadcastChatFrame` 会排除已投递的重复项）。
- **判据 2 例**（`ui/server/websocket/chat.test.js`）：真实 HTTP + 真实 WS + 真实
  `sessionWatchRegistry`，只有 gateway 调用被替换——兄弟 watcher 收到
  `stream_delta`（`edit-last-turn` 与 `regenerate-last-turn` 各一例），
  并回归断言提交页也收到、乐观行仍广播。
  **负控制 2 条逐条命中且互不串扰**：只把 `edit-last-turn` 换回 `writer` → 只有该例转红；
  只把 `regenerate-last-turn` 换回 `writer` → 只有该例转红；还原后复绿。
  （先在不修代码的树上跑，两例都因「兄弟侧等不到帧」超时而红——缺陷可复现。）
- **新增 ui/server 的 WS 层覆盖**：此前 `ui/server` 的用例完全不覆盖 `/ws`
  （复核记录的已知缺口）；本次建立的 harness（auth / shell / plugin-port / sati-bridge
  四处 stub + 真实 broadcast 注册表）可复用于 `/ws` 的其它帧类型。
- **未覆盖**：`writer` 的「提交页已关闭 ⇒ 回落同 userId 全部连接」这条兜底路径仍无用例；
  它与本 issue 的广播语义正交，留待独立载体。
