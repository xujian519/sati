# Agent Note: 项目看板（Kanban）Phase 1–5

Status: implemented

## Problem

Sati 缺少一个**按项目隔离、agent 可写、用户可持久化查看**的任务面板。现有 `todo_write` 是会话级、`task-master` 是外部 MCP 且未实现看板、`FileArtifact` 是会话产物——都无法让“人+AI”在长周期项目里共同掌握任务状态。

## Decision

### Phase 1 数据层（`src/board/storage/`）

实现 `BoardStore`，每项目一个 `{projectRoot}/kanban-board.json`：

- JSON 文件原子写（复用 `src/patent/persist-utils.js` 的 `atomicWriteJson`），损坏文件备份后重建默认三列。
- 数据模型 `BoardState` 含 `version`、`columns`、`cards`、`seq`；列 id `c<N>`、卡 id `k<N>` 按项目独立递增。
- `BoardStore` 提供列/卡片 CRUD、跨列/列内重排（splice + `toIndex`）、批量操作、跨项目移动（目标项目重新生成 id）。
- 项目隔离通过不同 `BoardStore` 实例指向不同 `projectRoot` 实现。
- 测试 `tests/board/board-store.spec.ts` 覆盖读写、原子写、损坏重建、CRUD、重排、批量、跨项目、隔离。

### Phase 2 领域运行时（`src/board/runtime/`）

实现 `BoardRuntime`，封装单个项目的业务规则：

- 包装 `BoardStore`；构造时接收 `projectId` / `projectRoot` / `emit` / `now` / `maxUndoSteps`。
- agent 写入时通过 `BoardActor` 注入 `source.{sessionKey,turnId,at}` 溯源。
- 每次写操作成功后通过 `emit(projectId, KanbanUpdatedPayload)` 触发事件，为后续 gateway 风扇分发 `kanban_updated` 做准备。
- 维护最多 50 步 undo 快照栈；写操作前 `structuredClone` 快照，undo 时回滚到上一状态。
- 跨项目移动由源 runtime 调用 `targetRuntime`，双方分别触发事件；跨项目移动不入 undo 栈（v1 限制）。
- 测试 `tests/board/board-runtime.spec.ts` 覆盖业务规则、溯源、事件、undo、跨项目、隔离。

### Phase 3 Gateway 协议接线（`src/gateway/kanban/` + `src/cli/*`）

- 协议版本从 1.4 升级到 1.5（MINOR），变更表登记所有 `kanban_*` 方法与 `kanban_updated` 事件；`isProtocolCompatible` 按 MAJOR 判定，Web 客户端 1.0 仍可连接。
- `src/gateway/protocol/frames.ts` 新增 17 个 `kanban_*` 方法到 `WsGatewayMethod`。
- `src/gateway/protocol/types.ts` 新增 `kanban_updated` 到 `GatewayEvent`，并在 `Gateway` 接口声明所有看板方法（可选，旧实现可缺省）。
- 新增 `KanbanBoardManager`（`src/gateway/kanban/KanbanBoardManager.ts`）：
  - 按 `projectRoot\0projectId` 缓存 `BoardRuntime` 实例。
  - 维护 `projectId -> Set<KanbanSubscriber>` 订阅表，支持订阅、取消订阅、全取消、风扇分发。
  - 订阅者 `send` 失败被吞掉，避免单个客户端拖垮广播。
- `InProcessGateway` 实现所有 `kanban_*` 业务方法：
  - 未注入 `KanbanBoardManager` 时统一返回 `notConfigured` 降级结果（与 `knowledge_capabilities` 等可选方法一致），便于 feature-detect。
  - `projectKey` v1 直接作为 `projectRoot`；后续可接入 workspace 解析。
- `GatewayWsConnection` 处理 `kanban_subscribe` / `kanban_unsubscribe`：
  - 连接级创建单一 `KanbanSubscriber`；`kanban_subscribe` 按 `projectId` 登记，`kanban_unsubscribe` 移除。
  - 连接关闭时自动 `unsubscribeAll`，防止内存泄漏。
  - 业务方法通过 `dispatchRequest` 转发到 `InProcessGateway`；未配置 kanban 时返回 `not_configured`。
- CLI 接线：
  - `createLocalGateway` 创建单例 `KanbanBoardManager`，注入 `InProcessGateway`，并通过 `CreateLocalGatewayResult.kanbanBoardManager` 暴露。
  - `satiServer.ts` 的 `StartSatiServerOptions` 接受 `kanban`，并透传给 `startGatewayServer`。
  - `sati.ts` 将 `kanbanBoardManager` 从 `createLocalGateway` 透传给 `startSatiServer`。
- 测试 `tests/gateway/kanban-protocol.spec.ts` 覆盖：
  - `InProcessGateway` 直接方法调用、持久化、undo、未配置时 `not_configured` 降级。
  - WebSocket 订阅后写操作触发 `kanban_updated` 通知。
  - 多 `projectId` 订阅隔离。
  - 取消订阅后不再收到通知。
  - GatewayServer 未注入 kanban 时返回 `not_configured`。
- `pnpm gen:event-matrix` 重新生成 `docs/event-producer-consumer.md`；`pnpm check:event-matrix` green。

### Phase 4 Agent 工具层（`src/tool/builtin/kanban.ts`）

实现 15 个 `kanban_*` 工具，与 UI 共用 `KanbanBoardManager` 缓存的 `BoardRuntime`：

- `createBuiltinRegistry` 新增 opt-in 选项 `kanban?: KanbanBoardManager`，未传时不注册看板工具，保持默认工具集不变（避免破坏 llm-replay fixture 的 `toolSchemaDigest`）。
- `createLocalGateway` 在创建 `KanbanBoardManager` 后通过 `registry.setKanbanBoardManager(manager)` 注入；`ProjectRuntimeRegistry` 新增私有 `_kanbanBoardManager` 与 setter，设置时 `invalidate` 使后续会话重建 tool registry 时包含新工具。
- 工具文件 `src/tool/builtin/kanban.ts` 导出 15 个 creator：
  - 读取：`kanban_get`（摘要级别：列+可见卡，支持 `includeArchived`）。
  - 卡片写：`kanban_add_card` / `kanban_update_card` / `kanban_delete_card`（软删） / `kanban_restore_card` / `kanban_purge_card` / `kanban_bulk_delete_cards` / `kanban_bulk_move_cards` / `kanban_move_card` / `kanban_duplicate_card` / `kanban_move_card_to_workspace`。
  - 列管理：`kanban_add_column` / `kanban_rename_column` / `kanban_delete_column`。
  - 撤销：`kanban_undo`。
- 工具 `execute` 用 `context.cwd` 作为当前项目根（v1 与 `InProcessGateway.resolveKanbanProjectRoot` 对齐），经 `manager.getRuntime(projectRoot, projectRoot)` 调用 `BoardRuntime`。
- `kanban_add_card` 自动注入 `source.{sessionKey,turnId,at}` 溯源；其他写操作不破坏已有溯源。
- 跨项目移动工具通过同一 manager 获取目标 runtime，调用 `sourceRuntime.moveCardToProject(cardId, targetRuntime)`。
- 所有工具声明 `outputSchema`，走 `ToolRuntime` 强制校验；输出保持摘要级别（`kanban_get` 返回列+卡摘要，写操作返回 `{cardId}/{ok}/{affected}` 等）。
- 工具不标注 domain，对所有角色默认可见；需裁剪的场景用角色 `hiddenDomains`。
- 修复 `BoardStore.updateCard`：原先 `{ ...existing, ...update }` 会把 `update` 中显式为 `undefined` 的字段覆盖为 `undefined`，导致 `archived` 等必填字段失效、板文件被判定损坏。改为只合并 `!== undefined` 的字段。
- 测试 `tests/tool/builtin/kanban.spec.ts` 覆盖：默认板、增删改卡、移动/复制、软删恢复彻底删、批量、列管理、undo、跨项目移动、`includeArchived`、溯源注入。

### Phase 5 UI（`ui/src/components/kanban/` + `ui/server` 桥）

实现项目级看板 UI，浏览器不直接碰 `src/`，全部经 gateway 协议方法读写；`kanban_updated` 实时事件经 ui/server 桥转发到浏览器。

- **浏览器→gateway 命令面（REST 代理）**：`ui/src/utils/api.js` 新增 `api.kanban.*`（`get`/`subscribe`/`unsubscribe`/`addCard`/`updateCard`/`moveCard`/`archiveCard`/`restoreCard`/`purgeCard`/`duplicateCard`/`bulkArchiveCards`/`bulkMoveCards`/`moveToProject`/`addColumn`/`renameColumn`/`deleteColumn`/`undo`），经 `#POST /api/kanban/*`。`ui/server/routes/kanban.js` 为每个 gateway 方法建一条带入参校验的转发路由，统一走 `getSatiGatewayWithReset`（gateway 重启死连接自动复位），并在 `ui/server/index.js` 挂载 `/api/kanban`（`authenticateToken`）。未配置 gateway 看板时返回 `not_configured`（501）。
- **`RemoteGateway` 增加看板方法**：`src/gateway/client/RemoteGateway.ts` 新增 17 个 `kanban_*` 方法 + `kanbanSubscribe`/`kanbanUnsubscribe`（此前 Phase 3 只实现 `InProcessGateway`，桥客户端侧缺失）。`Gateway` 接口（`protocol/types.ts`）同步声明可选的 `kanbanSubscribe`/`kanbanUnsubscribe`，便于 feature-detect。
- **`kanban_updated` 实时推送（WS 通知）**：`sati-bridge.js` 新增 `registerKanbanNotificationForwarding`（注册 `onNotification` 处理 `kanban_updated`）+ `gwKanbanSubscribe`/`gwKanbanUnsubscribe` 原语（共享 gateway 连接订阅/退订项目）。`websocket/broadcast.js` 维护 `projectId -> Set<ws>` 的 `kanbanProjectWatchers`，第 0 个 watcher 加入时 `kanban_subscribe`、第 0 个离开时 `kanban_unsubscribe`，并对该项目 watchers 扇出 `kanban_updated` 帧。`websocket/chat.js` 浏览器帧处理 `kanban-watch` / `kanban-unwatch`，连接关闭时 `kanbanUnwatchAll` 清理，防订阅残留。
- **UI feature-folder**：`types/`（对齐 gateway 契约 + `KanbanUpdatedPayload`）、`constants/`（默认列颜色、优先级/标签/色板）、`utils/boardPosition.ts`（复刻后端 `moveCard` 的**全局数组索引** `toIndex` 排序纯函数：`cardsByColumn`/`getCard`/`dropToGlobalIndex`/`applyMove`）、`hooks/useBoardState.ts`（加载 + 订阅 + 乐观更新与回滚 + 全部变更操作）、`hooks/useBoardDragDrop.ts`（dnd-kit 感知器 + 拖拽结束换算 `toIndex`）、`view/`（`KanbanBoardView` 容器 + `KanbanColumn` + `KanbanCard` + `KanbanCardEditor` 弹层 + `KanbanWorkspacePicker`）。
- **挂载点**：`useAppTabs.ts` 在 `BASE_APP_TABS` 登记 `kanban`（图标 `Columns3`）；`MainAreaV2` 头部加“看板”按钮（与 Files 同构，项目级 tab）；`MainContent` 把 `kanban` 加入 full-screen 工具并按 `activeTab==="kanban"` 渲染 `KanbanBoardView`。项目上下文取 `selectedProject.path`（= 项目根目录，即 gateway 的 `projectKey`/订阅 `projectId`）。
- **i18n**：新增 `ui/src/i18n/locales/{en,zh-CN}/kanban.json`，并在 `config.js` 注册 `kanban` namespace；`tabs.kanban` 加入 `common.json`。
- **拖拽库**：按用户拍板用 **dnd-kit**，新增依赖 `@dnd-kit/core`（6.3.1）、`@dnd-kit/sortable`（10.0.0）、`@dnd-kit/utilities`；列内 `SortableContext`（`verticalListSortingStrategy`）+ `DragOverlay` 跟随拖拽卡。
- **测试**：`ui/src/components/kanban/utils/boardPosition.spec.ts`（11 用例：按列过滤、查卡、`dropToGlobalIndex` 全局索引、`applyMove` 跨列/列内/clamp/不存在/updatedAt）、`KanbanCardEditor.spec.tsx`（新建保存带默认列、空标题校验、编辑模式预填+复制/删除、回收站模式恢复/彻底删除）。

**传输实现取舍（vs 设计文档 §5.1 的“WebSocket 帧”）**：命令面采用 ui/server REST 代理而非浏览器直接发 `WsRequestFrame`——这与 `teams.js`（同为 gateway 协议方法转发的先例）一致、可单测、更贴近 `api.js` 现有调用习惯；实时性不依赖命令通道，靠 `kanban_updated` WS 通知达成（设计 §5.2 的核心增量仍满足）。浏览器↔ui/server 仍走既有 `/ws`（`kanban-watch`/`kanban-unwatch` + `kanban_updated` 帧）。

**Phase 5 浏览器端到端验证（2026-08-26，Playwright + 从我源码起的干净 stack）**：
- 选项目→点头部“Kanban”→默认三列（待办/进行中/已完成）渲染正常；无控制台错误。
- “Add card”弹层填标题→保存→卡片出现在看板；服务端落盘可查。
- **实时**：看板打开期间，外部 curl 经 REST 写卡（同项目），页面**无刷新**自动出现新卡（`kanban_updated` WS 通知链路打通）。
- **拖拽**：真实鼠标把“E2E 浏览器卡片”从待办拖到进行中，服务端 `columnId` 由 `c1` 变为 `c2`（dnd-kit `onDragEnd` → `moveCard` 乐观更新 + 落盘一致）。
- i18n：头部/按钮为英文（默认 en），优先级徽章显示 “Medium”、标签显示译文（修复了误用 `t("kanban.x")` 点号前缀、应 `t("kanban:x")` 命名空间的问题）。

### Phase 5.1 收尾（2026-08-26，补三项设计缺口）

补齐设计文档明确但首轮未做的三项：

- **卡片溯源回链**：卡片 `source` 存在时，卡片底部渲染「源会话」按钮（`kanban:card.source`/`kanban:card.openSource`），点击调用 `MainContent.handleOpenKanbanSourceSession`（在 SplitBody 内）——优先在已加载 `projects` 里找到源项目/会话并 `onSelectSession` 打开 + `setActiveTab("chat")`；找不到则按 `onNavigateToSession(sessionKey)` 回退。**注意**：卡片本体因 `useSortable` 自带 `role="button"`，交互测试须用精确 `aria-label`（`button[aria-label='Open source session']`）而非 `getByRole` 正则，避免误点卡片本体。
- **列拖拽排序**：新增后端 `BoardStore.reorderColumns`（校验排列/重复/未知 id）+ `BoardRuntime.reorderColumns`（emit `column` 事件）+ gateway 方法 `kanban_reorder_columns`（`InProcessGateway`/`RemoteGateway`/`Gateway` 接口/`GatewayWsConnection` 分发/`WsGatewayMethod`）+ REST `#reorder-columns` + `api.kanban.reorderColumns` + `useBoardState.reorderColumns`（乐观重排 + 失败回滚）。UI 侧把列改为 `useSortable`（`data.type:"column"`，列头 GripVertical 拖拽把手），顶层 `SortableContext`（`horizontalListSortingStrategy`）包裹列，`useBoardDragDrop` 按 `data.type` 路由卡片/列拖拽（列拖拽经 `computeColumnOrder` 产出新顺序）。
- **断线重连订阅**：`useBoardState` 订阅 `websocket-reconnected` 帧，重连后重新 `kanban-watch` 当前项目 + `refresh()`；ui/server 桥 `registerKanbanNotificationForwarding` 重构为模块级 handler + `ensureKanbanForwarding`（每次 `gwKanbanSubscribe` 时校验并重挂到当前 gateway 实例，gateway 重启/重连后实时推送恢复）。浏览器侧重连 → 重发 watch → 桥重挂 handler。

**浏览器端到端验证（Phase 5.1）**：列拖拽把「进行中」拖到「待办」前，服务端列序变为 `进行中 / 待办 / 已完成`；卡片拖拽到进行中后 `columnId` 变为 `c2`；点击「Open source session」链接 URL 跳转 `/session/<源key>` 且 `sessionFound=true`；无控制台错误。断线重连路径经代码走查确认（未能端到端模拟网络中断）。

**评审修复（2026-08-26 code review，Merge 前）**

- **Critical — `BoardStore` 加进程内串行化**：原实现每个写操作 `load → mutate → save` 无锁，并发 `addCard` 会共享同一 `seq`、最后一次 `save` 覆盖其余（实测 20 并发仅落盘 1 张卡）。改为 `FileHistoryStore` 同款 **mutex-tail**（`private mutex: Promise<void>` + `run<T>()` + `mutate<T>()`），每项目一个 store 即项目级串行。同时顺带消除「读两次」；写失败则对象丢弃、不留半写。
- **跨项目移动双锁 + 先落目标**：`moveCardToStore` 在源锁内再取目标锁（锁定序固定源→目标，无反向无死锁），目标先落盘、源后落盘——目标失败则源板不动（卡片不丢）；目标成功、源失败则两板重复（而非丢失），v1 简化、非跨文件事务。
- **`kanban_undo` 触发 `kanban_updated`**：`KanbanUpdatedKind` 新增 `"board"`（整板快照回滚），undo 成功后 `emitChange("board")`，避免订阅端 UI 停留过期卡片。
- **网关 `kanban_get` 尊重 `includeArchived`**：默认过滤回收站卡，`includeArchived=true` 才含；与 agent 工具语义对齐。
- **`kanban_move_card_to_workspace` 相对路径基于当前工作区解析**：`toWorkspaceId` 改为 `resolve(context.cwd, toWorkspaceId)`，避免以 gateway 进程 cwd 拼出任意路径；绝对路径原样使用。
- 测试补充：`tests/board/board-store.spec.ts` 并发写回归（20 并发全落盘、id 唯一）；`board-runtime.spec.ts` undo 触发 `board` 事件；`kanban-protocol.spec.ts` includeArchived；`kanban.spec.ts` 相对 `toWorkspaceId` 解析。

## Alternatives considered

- **SQLite / boards.db（落选）** — 失去“人可读/可 git”特性，与“人机共同知道”目标冲突；JSON-per-project 与 dsh 参考实现对齐、实现最简。
- **整数/浮点 position 字段排序（落选）** — 与 dsh 参考实现对齐，采用数组顺序即排序，省掉额外字段。
- **全局唯一 id / UUID（落选）** — 保持人可读、与 dsh 同款 `k<N>`；跨项目移动时由目标项目重新生成 id，避免冲突。
- **undo 用逆操作而非快照（落选）** — 逆操作在跨列移动、批量操作、列删除等场景下容易遗漏边界；快照简单可靠，内存成本对单用户看板可接受。
- **undo 支持跨项目移动（落选）** — 涉及两个项目的状态回滚，v1 暂不支持；已在 `moveCardToProject` 明确不入栈。

## Consequences

- 换项目即换文件，天然隔离；`seq` 自增保证同一项目内 id 唯一。
- 跨项目移动会丢失 `source` 溯源（目标项目重新建卡），符合“卡片归属目标项目”语义。
- 损坏 JSON 会触发备份+重建，数据不会静默清空。
- `BoardRuntime` 与 gateway / 工具解耦：gateway 只需注入 `emit` 回调并映射 `projectId`；工具只需提供 `BoardActor`。
- Gateway 协议已升级到 1.5，所有看板方法均为可选；旧客户端/服务端通过 `describe_server` / `not_configured` feature-detect，不会硬性崩溃。
- `kanban_updated` 以 `projectId` 为键风扇分发，同一项目下的多个客户端/会话都能实时同步看板变更。
- 连接关闭自动清理订阅，订阅表不会泄漏。
- `pnpm check` 与 `pnpm test` 全部 green；事件矩阵已随变更重新生成。
- Agent 工具与 UI/Gateway 共用同一份 `BoardRuntime`，agent 写卡后打开中的看板能收到 `kanban_updated`。
- 看板工具为 opt-in 注册：默认 `createBuiltinRegistry()` 不包含它们，避免破坏既有 llm-replay fixture；只有真实 gateway 启动路径才会注入。
- `BoardStore.updateCard` 修复后不再因未提供字段而损坏板文件。
- `BoardStore` 以 mutex-tail 串行化同一项目内的并发写，agent 多会话/常驻后台并发写卡不再丢数据；跨项目移动先落目标、源板不动以保卡片不丢。
