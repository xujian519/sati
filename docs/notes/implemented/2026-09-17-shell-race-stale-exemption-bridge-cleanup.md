# Agent Note: PTY 竞态 / stale 豁免 / bridge 记账清退

Status: implemented

## Problem

三条 P2 级缺陷（#412、#336、#413）在 2026-09-17 的 ui/server 复核裁定中确认仍成立
（见 `2026-09-17-ui-server-dead-surface-retirement.md` §3），但彼时不在退役范围内，留作独立修复。

- **#412** `shell.js` PTY 会话生命周期竞态：`onData`/`onExit`/`close` 回调通过可变闭包变量
  `ptySessionKey`/`shellProcess` 查找会话身份，重连时闭包被覆写导致旧连接清空新连接 ws 引用、
  旧 PTY onExit 误删新会话条目、跨会话串流。
- **#336** stale 豁免清单与分诊目标抵销：`stale.yml` 不含 `priority: p0/p1`，高优先级议题
  （堵塞/主链路受损）120 天后被自动关闭，与 `docs/issue-management.md` §3 的治理目标冲突。
- **#413** `sati-bridge.js` 三张进程内记账 Map（`sessionState`/`subagentActivityStarts`/
  `pendingAgentToolCalls`）+ `knownSessions` 在 turn 被中断/从未收到终态事件时无清退路径，
  长驻进程内存单调增长。

## Decision

三处缺陷按域独立修复，不改对外协议（帧格式 / gateway 协议 / API 面均不变）。

### #412：实例身份捕获 + 所有权比对

- `init` 内用 `const myProcess = shellProcess; const mySessionKey = ptySessionKey` 捕获当前 PTY
  与会话键，所有回调（`onData`/`onExit`）读捕获值而非闭包变量。
- 每个 `delete`/清理操作前比对 `session.pty === myProcess`，确认当前 PTY 仍持有 map 条目。
- `close` 处理器额外捕获 `const myWs = ws`，守卫条件 `session.ws === myWs && session.pty === shellProcess`
  防止旧连接 close 清空新连接引用。
- `setTimeout` 回调内**重新从 map 取条目并比对**，防止 30 分钟期间条目被替换。

### #336：豁免 `priority: p0/p1`

- 在 `exempt-issue-labels` 末尾追加 `priority: p0,priority: p1`。
- 不加 `status: triage`（避免分诊永不衰减），保留现有 90+30 天的提醒机制。
- 注释补齐高优先级豁免理由并链接 `docs/issue-management.md §3`。

### #413：四道防线

1. `sessionState` 容量上限 `MAX_ACTIVE_SESSIONS = 500`，超限时按 LRU 淘汰非活跃会话。
2. `runChatViaGateway` 的 `finally` 块调用 `cleanupSessionBookkeeping(sessionKey)`，在 turn 终结
   （completed 或 error）时清除该 session 的 `pendingAgentToolCalls` / `subagentActivityStarts` /
   `knownAlwaysOnSessions` 条目。
3. `knownSessions` 从 `registerAlwaysOnNotificationForwarding` 内部提升到模块级
   `knownAlwaysOnSessions`，使兜底清退可达。
4. `beginDeletion` 的 `finish(true)` 同步调用 `cleanupSessionBookkeeping`，会话删除联动清退。

## Alternatives considered

- **#412 用事件总线替代闭包变量** —— 落选：改动面过大，需要重构整个 `handleShellConnection`
  为 class 或工厂模式。当前方案只改回调查找逻辑，最小 diff、零协议变化。
- **#336 豁免 `status: triage`** —— 落选：与「控制噪音」初衷相悖，分诊议题永不衰减等于
  分诊机制失效。只豁免 p0/p1 更精准。
- **#336 保持现状 + 在文档里写明 triage 自动归档是设计** —— 落选：p0/p1 被自动关闭不是
  任何合理设计，必须修。
- **#413 给每张表单独加 TTL 定时器** —— 落选：`ui/server` 没有统一的定时器生命周期管理，
  新增 `setInterval` 会引入新的泄漏面（定时器本身）。turn 终结时清退 + 容量上限是更轻量的方案。
- **#413 只在 `turn_completed` 时清退** —— 落选：这正是当前缺陷的根因——中断 turn 永远
  到不了 `turn_completed`。必须在 `finally` 里清退。

## Consequences

- **协议无变化**：`/shell` 帧格式、gateway frames、API 面均不变，无需重录 replay fixture
  或重生成事件矩阵。
- **无新增用户可见文案**，无需 i18n 提取。
- **`ui/server` 现有 8 个 `*.test.js` 不覆盖 `/shell` 与 `sati-bridge`**，本次修复无测试
  回归风险但也未补测试。判据方向写在各自 issue 的「备注」里，待 #411–#416 批次统一补。
- **`stale.yml` 变更立即生效**：下次 stale workflow 运行时 p0/p1 议题将被豁免。
