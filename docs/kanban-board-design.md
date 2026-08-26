# Sati 项目看板（Kanban）功能设计文档

- 创建日期：2026-08-26
- 状态：**定稿（已按 2026-08-26 评审补全高优 4 项）**（按用户拍板：① 每项目一个 JSON 文件；② 页签为**项目级**、看板不随会话变；③ 拖拽用 dnd-kit；④ 已补 subscribe/unsubscribe、项目上下文、跨项目 id 冲突、checklist 去留）
- 前置调研：本次会话已完成 (a) 开源方案选型（dnd-kit / react-beautiful-dnd / @asseinfo/react-kanban 对比 + Focalboard/Kanboard/Vikunja/Plane 数据模型 + license 合规，npm registry / GitHub API / raw 源码一手核实）；(b) 用户 dsh 插件 `dsh-project-kanban` 实际实现逆向（见 §1.2），本设计与之对齐并明确 Sati 增强点
- 关联决策记录：随实施 PR 提交 `docs/notes/implemented/` 一条 note（含 `## Alternatives considered`）

---

## 1. 背景与目标（业务价值）

Sati 的核心工作单元是 WorkSpace（工作区），agent 在会话里执行任务、产出交付物。但缺少一个**面向用户的、可持久化的任务面板**来跟踪"正在做什么、做到哪、下一步是什么"——目前这些信息散布在三个不统一的地方：

| 现状 | 位置 | 范围 | 问题 |
|---|---|---|---|
| `todo_write` 工具 | `src/tool/builtin/todoWrite.ts`（scope: `session`） | 会话级待办清单 | 会话结束即失焦，无法跨会话聚合 |
| task-master | `ui/src/components/task-master/` | **外部 Task Master AI MCP server**，按 git 项目 | 外部依赖、看板组件未实现（`TasksV2.tsx` 仅 169 行列表） |
| FileArtifact | `src/session/artifacts/` | 会话级文件产物 | 是"投交物"，不是任务状态面板 |

**目标**：新增一个**原生、按工作区隔离、agent 可写、本地持久化**的项目看板，支持卡片拖拽换列、编辑/删除/复制/移动到其他工作区，卡片可溯源到产生的会话与 turn。

**非目标（本期不做）**：多用户实时协作、跨设备同步、甘特/日历视图、看板自动化规则（swimlane）、对外 API。

### 1.2 参考实现：dsh-project-kanban（用户在 dsh 的现有插件）

本项目目标与用户在 DeepSeek Harness（dsh）中已用插件 `dsh-project-kanban`（MIT，`~/.dsh/profiles/<profile>/node_modules/dsh-project-kanban/`）实现并验证的功能一致。现把它作为**先例与参照**，避免重复发明、并明确 Sati 相对它的增强点。

**它已经验证成立的结论**：

- **定位**：agent 在对话里直接用 `kanban_*` 工具写规划卡，人共用一眼看板掌握长周期项目进度。这被用户实际使用并认可（"效果还可以"）。
- **数据模型**：每工作区一个 JSON 文件 `kanban-board-<workspaceId>.json`，形如 `{ columns: [{id,title}], cards: [{id,columnId,title,note,label,priority,color,dueDate,archived,source:{sessionId,at}}] }`；列/卡 id 为 `c<N>`/`k<N>`，排序由数组顺序决定（无 position 字段）。**按工作区（项目）隔离**，卡片排序 = splice 数组。
- **工具**：14 个 `kanban_*` 工具（get / add_card / update_card / delete_card / restore_card / purge_card / bulk_delete_cards / move_card / duplicate_card / move_card_to_workspace / undo / add_column / rename_column / delete_column），每个带 inputSchema(`parameters`) + 输出契约(`output.schema`) + **模型可见渲染(`output.render`，把 board 摘要渲染成文本)**。
- **工作区解析**：`exec.agent.session.header.cwd` → `workspaceRegistry.resolveByPath` 反查工作区，缺省 `default`。
- **溯源**：agent 建的卡带 `source: { sessionId, at }`，可点击跳回源会话——与 Sati 的"卡片溯源到会话/turn"目标一致。
- **UI 传输**：浏览器端经**同源 `fetch` 到宿主 `/api/kanban` 前缀路由**（dsh `webServer` 扩展点）发起 JSON RPC；不依赖沙箱 host.call。
- **UI 挂载**：作为 `conversation.view` slot 注册（`id:'kanban', order:20, label:'看板'`），用一个"看板"页签挂在会话头部。
- **拖拽**：**原生 HTML5 drag-and-drop**（`draggable` + `dataTransfer`），未用任何拖拽库。

**Sati 相对它应明确的增强点（也是本设计的取舍动机）**：

1. **实时联动**：dsh 插件**没有事件推送**——agent 在某 turn 用工具写卡后，已打开看板的用户不会自动看到新卡，须手动操作/刷新。Sati 的 gateway 有事件推送机制（`kanban_updated`），可让 agent 写卡→打开中的看板**实时更新**，真正实现"人机共同知道"。这是本设计要拿下的核心增量。
2. **传输按 Sati 边界**：Sati 的 `ui/` 不得直连 `src/`，`ui/` 只经 gateway API / WebSocket（或 `ui/server` 桥）通信；因此看板数据面放 `src/board/`，以 gateway `kanban_*` 方法（而非浏览器直连 HTTP）暴露。
3. **渲染分离**：Sati 现有工具把模型可见 prose 放在 `description` + `execute` 返回值里，没有 dsh 的 `output.render` 纯函数分离；本设计的看板工具可沿用 Sati 现状（返回值即模型可见），是否补 `render` 分离作为该工具的可选项。

---

## 2. 需求范围

### 2.1 功能清单

- **看板**：**每项目（工作区）一块看板**，含若干**列（list/column）**与**卡片（card）**；看板随项目文件夹走，不随会话变。
- **列**：默认"待办 / 进行中 / 已完成"，可增删改、拖拽排序；每列有颜色。
- **卡片**：标题、备注、优先级、标签、自定义颜色、截止日期；可拖拽换列、列内排序。
- **卡片操作**：编辑、删除（软删入回收站）、复制、"移动到其他项目"。
- **agent 写入**：agent 通过 `kanban_*` 工具建卡/更新/换列（结构化输出校验），不直接改文件。
- **溯源**：卡片记录 `source.{sessionKey,turnId}`，便于审计与回链会话。
- **隔离**：每次读写按**当前项目**定位看板文件，不同项目的板互不可见；卡片可跨项目移动。

### 2.2 用户故事

- 作为用户，打开某项目的"看板"页签，看到该项目下所有会话产生的任务卡片，按状态分成列；换个会话再打开，内容不变。
- 作为 agent，在一个 turn 里调用 `kanban_add_card` 建卡、`kanban_move_card` 把卡片推进到"进行中"，用户看板实时看到。
- 作为用户，拖拽一张卡片到另一列，界面乐观更新，WebSocket 事件回推保持多端一致。
- 作为用户，把一张卡片"移动到其他项目"，该卡片从当前板移走并在目标项目的板出现。

---

## 3. 总体架构（分层定位）

```
┌─────────────────────── ui/ (React 19) ───────────────────────┐
│ kanban 组件（dnd-kit + shadcn/ui）  仅经 gateway 帧读写      │
└──────────────┬───────────────────────────────────────────────┘
               │ WsRequestFrame{ method: kanban_* } / WsEventFrame{ event: kanban_updated }
┌──────────────▼───────────────────────────────────────────────┐
│ src/gateway/  （协议 1.5：kanban_* 方法 + kanban_updated 事件）│
└──────────────┬───────────────────────────────────────────────┘
               │
    ┌──────────▼──────────┐      ┌──────────────────────────┐
    │ BoardRuntime         │      │ agent 工具 (kanban_*)    │
    │ 业务规则 + workspace │◄─────┤ src/tool/builtin/kanban*.ts│
    │ 隔离 + 事件发射       │      │ outputSchema 校验         │
    └──────────┬──────────┘      └──────────────────────────┘
               │
    ┌──────────▼──────────┐
    │ BoardStore (JSON)   │  <projectRoot>/kanban-board.json（每项目一份）
    └─────────────────────┘
```

**边界纪律**（遵从 AGENTS.md）：`src/` 不得导入 `ui/`；`ui/` 只能通过 gateway 帧与 `kanban_*` 通信；agent 只能通过 `kanban_*` 工具写看板；看板的唯一事实源是 `src/board/`（每项目一块板，落盘为项目文件夹下的 JSON）。

---

## 4. 数据模型（每项目一个 JSON 文件）

### 4.1 文件与路径

**每项目（工作区）一个 JSON 文件**，与 dsh 参考实现一致。Sati 的项目即工作区，看板落在**项目文件夹**下、随项目走（不随会话变）：

```
{projectRoot}/kanban-board.json
```

- 读写由 `BoardStore` 负责，内部写盘为**原子写**（写临时文件再 rename，避免中断损坏）。
- 文件缺失/损坏时**自动重建**默认三列 `待办/进行中/已完成`。
- 反查归属：网关/工具从**当前项目（工作区）上下文**解析 `projectRoot`（见 §5.1），无需在请求里带 workspace 参数。

### 4.2 JSON Schema（v1）

```jsonc
{
  "version": 1,
  "columns": [
    { "id": "c1", "title": "待办",   "color": "#64748b" },
    { "id": "c2", "title": "进行中", "color": "#f59e0b" },
    { "id": "c3", "title": "已完成", "color": "#10b981" }
  ],
  "cards": [
    {
      "id": "k1",
      "columnId": "c1",
      "title": "实现 X 模块",
      "note": "背景/验收标准",
      "label": "功能",
      "priority": "high",
      "color": "#0ea5e9",
      "dueDate": "2026-09-01",
      "archived": false,
      "createdAt": "2026-08-26T10:00:00.000Z",
      "updatedAt": "2026-08-26T10:00:00.000Z",
      "source": { "sessionKey": "session-a", "turnId": "turn-3", "at": "2026-08-26T10:00:00.000Z" }
    }
  ]
}
```

字段语义：

| 字段 | 说明 |
|---|---|
| `version` | schema 版本，迁移/默认列重建依据 |
| `columns[].id` | `c<N>`，列 id（`seq` 按项目独立递增） |
| `cards[].id` | `k<N>`，卡 id（`seq` 按项目独立递增；跨项目移动时会在目标项目重新编号，避免 id 冲突） |
| `cards[].columnId` | 归属列 id |
| `label` | 功能 / 缺陷 / 文档 / 优化（预置 4 类，可扩展） |
| `priority` | `high` \| `medium` \| `low` |
| `color` | `#rrggbb` 自定义背景 |
| `dueDate` | `YYYY-MM-DD` |
| `archived` | 软删入回收站 |
| `source` | 溯源：`{ sessionKey, turnId, at }`；用户手工建卡则空 |

**排序**：由 **`cards` 数组顺序**决定（dsh 同款，靠 splice 重排），**无 position 字段**。跨列/列内重排即对数组做 splice；`toIndex` 指示插入位。

**溯源**：`cards[].source.{sessionKey,turnId}` 使卡片可回链会话与 turn；UI 点击可跳回源会话。

### 4.3 ID 策略与跨项目移动

- 列 id `c<N>`、卡 id `k<N>` 均按**项目独立递增**（每个 `kanban-board.json` 自维护 `seq` 计数器），不全局共享，保持文件自包含与人可读。
- **跨项目移动**（`kanban_move_card_to_workspace`）时，源文件删除该卡，目标文件按目标自己的 `seq` 重新生成卡 id 后插入第一列。这样既避免两项目 `k1` 冲突，也保证目标文件仍是连续的本地序列。
- 撤销栈只跟踪**同一项目内**的写操作；跨项目移动的撤销不在 v1 支持范围内（可在目标板手动删除/移回）。

---

## 5. Gateway 协议设计

版本由 **1.4 → 1.5**（MINOR，向后兼容；改动记录进 `src/gateway/protocol/version.ts` 变更表）。Web 客户端（1.0）同 MAJOR 仍可连接。

### 5.1 新增方法（`WsGatewayMethod`，`src/gateway/protocol/frames.ts`）

dsh 参考实现把浏览器与宿主的通信做成了一个扁平 RPC（`kanban.get` / `kanban.addCard` / …，经 `/api/kanban` 一次收发的整板请求/响应），**一个工作区一块看板**，没有独立的 board/list/card 创建粒度。Sati 沿用这一简化：网关方法即那组 `kanban_*` 操作（浏览器需要的能力与工具同构），但**改经 WebSocket 帧**而非浏览器直连 HTTP，以换取实时推送。

**`projectRoot` 反查**：网关从**当前所选项目（工作区）上下文**解析看板文件路径（复用 `src/session/workspace`/项目解析逻辑），因此 UI 方法**无需传 workspace 参数**；只有跨项目移动要显式传 `toProjectId`。agent 工具侧则从 `exec.agent.session.header.cwd` 反查（与 dsh 一致）。

| 方法（method） | 入参 | 说明 |
|---|---|---|
| `kanban_get` | `{ includeArchived? }` | 整板读取（列+卡），UI 首屏渲染 |
| `kanban_add_card` | `{ columnId, title, note?, label?, priority?, color?, dueDate? }` | 加卡 |
| `kanban_update_card` | `{ cardId, title?, note?, label?, priority?, color?, dueDate? }` | 更新卡 |
| `kanban_delete_card` / `kanban_restore_card` / `kanban_purge_card` | `{ cardId }` | 软删 / 恢复 / 彻底删 |
| `kanban_bulk_delete_cards` / `kanban_bulk_move_cards` | `{ ids[], columnId? }` | 批量软删 / 批量移动 |
| `kanban_move_card` | `{ cardId, columnId, toIndex? }` | 跨列 或 列内重排 |
| `kanban_duplicate_card` | `{ cardId, columnId?, toIndex? }` | 复制卡 |
| `kanban_move_card_to_workspace` | `{ cardId, toProjectId }` | 跨项目移动（到目标板第一列）；目标板重新生成 cardId，避免两项目 `k<N>` 序列冲突 |
| `kanban_add_column` / `kanban_rename_column` / `kanban_delete_column` | `{ … }` | 列管理 |
| `kanban_subscribe` | `{ projectId }` | UI 打开某项目看板时订阅；网关维护 projectId→client 映射 |
| `kanban_unsubscribe` | `{ projectId }` | UI 离开看板/切换项目时取消订阅 |
| `kanban_undo` | `{}` | 撤销最近写操作 |

> 方法为**可选新增**，客户端经 `describe_server` / `not_configured` 探测，旧网关/客户端不假设对方实现。
>
> **项目上下文**：`kanban_*` 方法（除跨项目移动外）**不带 `projectId` 参数**——网关/工具从当前所选项目的上下文解析。UI 在项目级 tab 体系内打开"看板"时，应通过 `useAppTabs` / session/workspace 状态拿到当前激活项目的 `projectId`，并在调用 `kanban_get` 前先发 `kanban_subscribe { projectId }`；切换项目时先发旧 project 的 `kanban_unsubscribe`，再发新 project 的 `kanban_subscribe`。agent 工具侧从 `exec.agent.session.header.cwd` 反查工作区，复用 `src/session/workspace/` 的解析逻辑。

### 5.2 新增事件（`GatewayEvent`，`src/gateway/protocol/types.ts`）

| 事件 | 载荷 | 说明 |
|---|---|---|
| `kanban_updated` | `{ projectId, kind: "card"｜"column", cardId?, columnId?, at }` | 看板变更推送；agent 在某 turn 改卡后，打开中的看板**实时刷新** |

> **增强点**：dsh 插件无事件推送——agent 写卡后已打开的看板不会自动更新（须手动操作/刷新）。Sati 以 `kanban_updated` 事件达成"agent 写→用户看板实时变"，这才是真正的"人机共同知道任务情况"。
>
> **分发语义**：看板是**项目级**而非单会话级——在同一项目下不同会话里打开看板，agent 在任一会话写该项目的卡，打开中的看板都应刷新。故 `kanban_updated` 以 `projectId` 为键，由网关**风扇分发**给所有正在查看该项目看板的客户端，而非仅发给产生该写操作的会话。
>
> **订阅登记**：网关维护 `Map<projectId, Set<clientId>>` 订阅表。UI 打开看板时调用 `kanban_subscribe { projectId }` 登记，离开/切换项目时调用 `kanban_unsubscribe { projectId }` 移除。写操作成功后，`BoardRuntime` 通过注入的 `emitKanbanUpdated(projectId, payload)` 回调让网关按订阅表风扇分发 `kanban_updated` 事件。浏览器断线重连时应重新订阅并重新 `kanban_get`。

### 5.3 事件面与审计

- 事件类型与 emit/订阅边由 `scripts/gen-event-matrix.ts` 解析，新增后**必须** `pnpm gen:event-matrix` 重生成 `docs/event-producer-consumer.md`，且 `pnpm check:event-matrix` green。

---

## 6. Agent 工具契约（`src/tool/builtin/board*.ts`）

agent 通过工具写看板（与 UI 的 gateway 方法共用同一 `BoardRuntime`/`BoardStore`，保证唯一事实源）。工具命名与 dsh 参考实现一致（`kanban_*`），便于移植与复用已验证的工具语义。`createBuiltinRegistry` 已开启 `requireOutputSchema: true`，**每个工具必须声明 `outputSchema`**——`inputSchema`（含描述文本）改动会使 llm-replay fixture 失配，须重录。

| 工具 | 入参（inputSchema 要点） | outputSchema / 模型可见反馈 |
|---|---|---|
| `kanban_get` | `{ includeArchived? }` | 返回当前板摘要（列+卡），规划前先读 |
| `kanban_add_card` | `{ title, columnId?, note?, label?, priority?, color?, dueDate? }` | `{ cardId }`；自动带 `source` 溯源 |
| `kanban_update_card` | `{ id, title?, note?, label?, priority?, color?, dueDate? }` | `{ cardId, updatedAt }` |
| `kanban_delete_card` | `{ id }` | 软删（入回收站） |
| `kanban_restore_card` | `{ id }` | 从回收站恢复 |
| `kanban_purge_card` | `{ id }` | 彻底删除 |
| `kanban_bulk_delete_cards` | `{ ids[] }` | 批量软删 |
| `kanban_move_card` | `{ id, columnId, toIndex? }` | 跨列或列内重排（`toIndex`） |
| `kanban_duplicate_card` | `{ id, columnId?, toIndex? }` | 复制卡片（含标签/优先级/颜色） |
| `kanban_move_card_to_workspace` | `{ id, toWorkspaceId }` | 跨工作区移动（到目标板第一列）；卡片在目标板按目标板的 `seq` 重新生成 id，原 id 留在源板历史/撤销栈 |
| `kanban_add_column` | `{ title }` | 加列 |
| `kanban_rename_column` | `{ id, title }` | 重命名列 |
| `kanban_delete_column` | `{ id }` | 删列（卡片并入第一列，至少留一列） |
| `kanban_undo` | `{}` | 撤销最近一次写操作（50 步栈） |

**domain 元数据**：为通用工作区能力，**不标注 domain**（对所有角色可见）；需裁剪的场景可在角色 `hiddenDomains` 隐藏。这是一个决策点，见 §9 备选 6。

**渲染分离（可选）**：dsh 参考实现把模型可见反馈放进 `output.render`（纯函数把 board 摘要渲染成文本）。Sati 当前工具无 `render` 分离，模型可见 prose 在 `description` + `execute` 返回值中；本设计的 `kanban_*` 工具沿用 Sati 现状（返回值即模型可见），如需与 dsh 完全一致可补 `output.render` 纯函数（作为该工具的可选项，见 §9 备选 7）。

**校验**：工具运行时走 `outputSchema` 强制校验（data 存在时 `tool_output_schema_mismatch` fail-loud）；结构化错误走 `SatiToolRuntimeError` 与"无结果"区分。

---

## 7. UI 设计（`ui/src/components/kanban/`）

### 7.1 组件结构（feature-folder 模式）

```
kanban/
  view/
    KanbanBoardView.tsx      # 看板容器：读取/订阅 kanban_updated，列即 dnd 容器
    KanbanColumn.tsx         # 单列（Droppable）：列头 + 卡片流 + "添加卡片"
    KanbanCard.tsx           # 卡片（Draggable）：标题/优先级/标签概览
    KanbanCardEditor.tsx     # 卡片编辑弹层（Sheet/Modal）：详情/标签/删除/复制/移动
    KanbanWorkspacePicker.tsx # "移动到其他工作区"选择器
  hooks/
    useBoardState.ts         # 板+列+卡状态，乐观更新 + WS 事件 reconciled
    useBoardDragDrop.ts      # dnd-kit 拖拽落位逻辑
  types/
    types.ts                 # 与 gateway kanban_* 响应结构对齐的 TS 类型
  constants/
    constants.ts             # 默认列颜色、优先级枚举、状态 key 中文映射
  utils/
    boardPosition.ts         # 拖拽落位 → position 重排纯函数（可单测）
```

### 7.2 拖拽与状态

- **库**：推荐 `@dnd-kit/core` + `@dnd-kit/sortable`（MIT、peer `>=16.8.0` 兼容 React 19、headless 契合 shadcn/ui；**不用** react-beautiful-dnd——已官方归档且仅支持到 React 18）。dsh 参考实现用的是**原生 HTML5 drag-and-drop**（`draggable` + `dataTransfer`，无库）；若要与 dsh 完全同构可沿用原生，但 dnd-kit 的键盘/无障碍与列内排序更稳。见 §9 备选 2。
- **交互**：卡片跨列拖拽（Droppable=Droppable）+ 列内排序（SortableContext），`onDragEnd` → `boardPosition` 纯函数算新 position → 乐观更新本地 state → 调 `kanban_move_card`（带 `toIndex`）→ 失败回滚。
- **一致性**：`useBoardState` 订阅 WebSocket `kanban_updated` 事件，重建/增量重取，避免多端（多会话/多客户端）不同步；agent 用工具写卡后，打开中的看板**实时刷新**（dsh 缺此能力）。
- **样式**：shadcn/ui `Card/Button/Badge/Sheet/DropdownMenu`，Tailwind 4 布局；列头颜色取自列颜色字段。

### 7.3 挂载入口（项目级页签）

按用户已拍板：页签是**项目级**，不是会话级——**在某项目文件夹下，看板内容不随不同会话而变化**。挂载为 Sati 主内容区的一个**项目级顶级 tab**（与 `FilesV2`/`GitV2` 这类项目级 tab 同构），选中某项目时即可见"看板"。

需要补的前置改动：

1. 在 `ui/src/hooks/useAppTabs.ts` 的顶级 tab 清单（`BASE_APP_TABS` 附近）登记 `"kanban"`，图标用 `Columns3`/`Kanban`。
2. `KanbanBoardView` 通过 `useAppTabs` / `useWorkspace` 等已有 hook 获取**当前激活项目的 `projectId`**，作为 `kanban_subscribe { projectId }` 和 `kanban_get` 的上下文。若用户未选中任何项目（空状态），看板 tab 显示占位提示。
3. 切换项目时，组件 `useEffect`  cleanup 阶段调用 `kanban_unsubscribe` 旧 projectId，新 projectId 生效后再 `kanban_subscribe` + `kanban_get`，避免事件串扰。
4. 网关 handler 收到 `kanban_get/subscribe/unsubscribe` 时，用与 `FilesV2`/`GitV2` 相同的当前项目解析逻辑（复用 `src/session/workspace/` 或 `ui/server` 的 workspace resolver）定位 `projectRoot`，无需 UI 显式传路径。

> 与 dsh 差异：dsh 的看板是会话级 `conversation.view` 页签（随会话）；Sati 采用**项目级**页签，看板归属项目而非会话——这正是你拍板的方向，也是"长周期项目"场景更自然的形态。

---

## 8. 事件面 / 兼容性 / 重放影响

| 变更 | 影响 | 处置 |
|---|---|---|
| 新增 GatewayEvent | 事件矩阵失配 | `pnpm gen:event-matrix` 重生成 + `pnpm check:event-matrix` green |
| 新增工具 `inputSchema` | llm-replay fixture 失配 | 走 `scripts/record-llm-replay.ts` 重录（`pnpm record:replay`） |
| 协议 1.4→1.5 | MINOR 向后兼容 | 变更表登记；`isProtocolCompatible` 按 MAJOR 判定，Web(1.0) 同 MAJOR 兼容 |
| 移动代码/删 import 触发 eslint --fix | 事件矩阵 file:line 漂移 | 改动后重新 `pnpm gen:event-matrix` |

---

## 9. 关键决策与备选（Alternatives considered）

> 项目纪律：非平凡变更须记录"放弃了什么"。以下为本设计真实评估过的备选。

1. **自建原生看板 vs 复用/扩展 task-master（外部 Task Master AI MCP）**
   - **自建原生 `src/board/`（采用）** —— 看板需按工作区隔离 + 会话级溯源 + agent 结构化输出写入，这些是 L1 原生能力；task-master 是外部 MCP、按 git 项目、且其看板组件未实现，无法满足"卡片溯源到会话/turn"。
   - 复用 task-master —— 落选：外部依赖 + 数据模型不匹配 + 看板未实现，改造成本高于自建。

2. **拖拽库选型**
   - **dnd-kit（采用）** —— MIT、React 19（peer `>=16.8.0`）、headless 契合 shadcn/ui、活跃维护；键盘/无障碍与列内排序体验更稳。
   - react-beautiful-dnd —— 落选：官方已归档（README 首行弃用声明）、peer 仅到 React 18、StrictMode 兼容差。
   - @asseinfo/react-kanban / react-trello —— 落选：均已归档/停更，且底层依赖 react-beautiful-dnd。
   - 原生 HTML5 drag-and-drop（dsh 参考实现所用） —— 可行且零依赖，但键盘/无障碍欠佳、React 19 下偶有细节问题；可作为"最小实现"备选。

3. **持久化形态（已定：JSON-per-project）**
   - **每项目一个 JSON 文件 `{projectRoot}/kanban-board.json`（采用）** —— 与 dsh 参考实现一致；可直接 `cat` 审阅（利好"人机共同知道"）、实现最简、天然可版本管理；每次改动整文件重写对单用户体量足够。代价：无查询/事务（本项目用不到）、跨项目移动需搬字段。**用户已拍板采用。**
   - 单库 boards.db + workspaceKey 分区（曾为备选） —— 落选：虽可支撑后续统计/回溯，但失去"人可读/可 git"特性，与本设计重点"人机共同知道"冲突。
   - 每项目独立 db 文件 —— 落选：多文件/多连接管理复杂。
   - 复用 transcript 派生 —— 落选：看板需独立可变状态，不可从只读 transcript 重派生。
   - 外部数据库（Plane 式 PG+Redis） —— 落选：单机单用户体量不匹配。

4. **数据建模**
   - **Kanboard 式显式 board/list/card 关系（采用）** —— 语义清晰、字段显式、贴合 `outputSchema` 契约与逐字段校验；v1 不引入 checklist 子任务，保持与 dsh 一致。
   - Focalboard 单 `blocks` 表 —— 落选：过度泛化（view/card/text/image 全一张表），类型校验与审计难度增大；可借鉴其 `position` 排序字段思想。

5. **UI 挂载入口（已定：项目级页签）**
   - **项目级顶级 tab（采用）** —— 与 Sati 的 `FilesV2`/`GitV2` 项目级 tab 同构，选中项目即见"看板"；看板归属项目、不随会话变（用户已拍板）。前置：在 `useAppTabs.ts` 登记 `kanban` tab。
   - 会话级页签（dsh 的 `conversation.view` 方式） —— 落选：看板随会话，不符合"长周期项目、内容不随会话变"的目标。
   - 会话内子页签（参考图样式） —— 落选：Sati 无会话级页签栏，且与项目级目标不符。

6. **工具 domain 标注**
   - **不标注 domain（采用）** —— 看板是通用工作区能力，所有角色默认可见；需裁剪用 `hiddenDomains`。
   - 标注 `workspace`/`patent` 等 —— 落选：会按角色/子代理裁剪导致 agent 在某些场景看不到看板工具，增加噪音而非减少。

7. **卡片排序（已定：数组顺序）**
   - **`cards` 数组顺序即排序（采用）** —— 与 dsh 一致；跨列/列内重排 = 数组 splice，`toIndex` 指示插入位。无 position 字段，实现最简。
   - 整数 position 重排 —— 落选：JSON 文件里为保可读性省掉多余字段，数组顺序即可表达。
   - 浮点分数排序 —— 落选：无必要，碎片化。

8. **模型可见渲染分离（`output.render`）**
   - **沿用 Sati 现状：返回值即模型可见 prose（采用）** —— 改动最小，与既有工具（`workspace_note` 等）一致。
   - 补 `output.render` 纯函数（与 dsh 一致） —— 落选为本期：Sati 工具无此机制，引入需改动工具链；列作后续增强。

9. **卡片 checklist（子任务）去留**
   - **v1 不实现 checklist（采用）** —— dsh 参考实现的卡片无 checklist 字段；为保持本期最小可用、数据模型与 UI 一致，v1 卡片仅含标题/备注/优先级/标签/颜色/截止日期。如需子任务，可在 `note` 中用 Markdown 列表人工表达，或在 v2 引入显式 `checklist: { id, text, done }[]` 字段。
   - 在 v1 数据模型中加入 checklist —— 落选：会扩大数据模型、工具 inputSchema/outputSchema、UI 弹层和测试范围，延迟 Phase 1 落地。

---

## 10. 分阶段实施计划（TDD）

> 每阶段：先写测试 → 实现 → `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`（核心模块必附测试）。

### Phase 1 · 数据层（`src/board/storage/`）
- `BoardStore.ts`：每项目 JSON 文件读写（`{projectRoot}/kanban-board.json`）+ 原子写 + 缺卡/损坏重建默认三列 + CRUD + 数组 splice 重排 + `seq` 递增 + 项目隔离。
- 测试：`tests/board/board-store.spec.ts`（读写/原子写/重建/CRUD/重排/隔离）。

### Phase 2 · 领域运行时（`src/board/runtime/`）
- `BoardRuntime.ts`：业务规则（add/update/move/archive/duplicate/moveToProject/undo）+ 项目解析 + 溯源字段注入（`source.{sessionKey,turnId}`）+ 事件发射回调。
- `BoardRuntime` 与 gateway/工具解耦（注入 emit 回调），便于单测。
- 测试：`tests/board/board-runtime.spec.ts`。

### Phase 3 · Gateway 协议
- `frames.ts` 增 `kanban_*` 方法；`types.ts` 增 `kanban_updated` 事件；`version.ts` 升 1.5 + 变更表；server 端 handler（含 `projectRoot` 反查）接线到 `BoardRuntime`。
- `pnpm gen:event-matrix` 重生成 + `pnpm check:event-matrix` green。
- 测试：gateway 协议 handler 测试（含项目隔离、feature-detect）。

### Phase 4 · Agent 工具
- `src/tool/builtin/kanban*.ts` 工具（`outputSchema` + domain 决策，含 `kanban_add_card` 自动注入 `source`）+ 注册进 `createBuiltinRegistry`。
- 重录 llm-replay fixture（`pnpm record:replay`）。
- 测试：工具级测试（mock 外部网络，LLM 回路走重放 seam）。

### Phase 5 · UI（`ui/src/components/kanban/`）
- dnd-kit 拖拽看板 + shadcn 渲染 + 乐观更新 + WebSocket `kanban_updated` 重建 + 移动工作区选择器。
- Vitest 组件测试（`boardPosition.ts` 纯函数 + 拖拽落位逻辑 + 状态 reconcile）。
- 浏览器端到端验证：建卡→拖拽换列→跨端一致→移动到其他工作区；桌面 + 移动布局。

---

## 11. 风险与决策点

| 风险/决策 | 等级 | 说明与缓解 |
|---|---|---|
| **定位**：看板为**项目级**、内容不随会话变 | 高 | 已定（用户拍板）；确保工具/网关按当前项目解析看板文件，避免误混会话 |
| 桌面/CLI 多进程对该 JSON 的并发写 | 中 | 单机单用户基本无并发；`BoardStore` 内存缓存 + 原子写，进程内串行；跨进程共享同一文件不在支持范围 |
| UI 工作量最大 | 中 | Phase 5 独立成阶段；先落地数据+协议+工具（后端先行），UI 可后置 |
| 事件面/重放失配 | 低 | §8 已列处置：重生成事件矩阵 + 重录 fixture |
| 拖拽库选型 | 低 | 已定 dnd-kit；规避 react-beautiful-dnd |

---

## 12. 验收标准

- [ ] `BoardStore` 读/写/原子写/缺卡重建/CRUD/数组重排/项目隔离单测全绿。
- [ ] `BoardRuntime` 业务规则单测全绿；加卡后 `source.{sessionKey,turnId}` 正确。
- [ ] Gateway 升 1.5，`pnpm gen:event-matrix` 重生成、`pnpm check:event-matrix` green；旧客户端 feature-detect。
- [ ] agent 用 `kanban_add_card`/`kanban_move_card` 建卡/换列，落盘 `{projectRoot}/kanban-board.json` 可查；`outputSchema` 校验失败 fail-loud；llm-replay fixture 重录后 `pnpm test` 全绿。
- [ ] UI "看板"项目级 tab 拖拽换列/列内排序/乐观更新回滚/`kanban_updated` WS 重建一致；浏览器端到端通过；桌面+移动布局正常。
- [ ] 不同项目看板互不可见（隔离测试）；换会话再打开看板内容不变（项目级）。
- [ ] 卡片可溯源（点击卡片可回链源会话）。

---

## 附：本设计引用的源码锚点

- 项目根/工作区解析先例：`src/session/workspace/`、`src/session/workspace/WorkspaceLedgerStore.ts`（取项目目录）
- JSON 文件原子写先例：`src/tool/builtin/filesystem/observation.ts`、`src/session/storage/ToolResultsCleanup.ts`（`{projectRoot}/.sati/` 落盘与治理）、`src/session/filesystem/FileHistoryStore.ts`
- 协议方法/事件：`src/gateway/protocol/frames.ts` / `src/gateway/protocol/types.ts` / `src/gateway/protocol/version.ts`
- 工具注册与 outputSchema：`src/tool/registry/createBuiltinRegistry.ts`
- 会话级待办（对比项）：`src/tool/builtin/todoWrite.ts`（scope: `session`）
- 既有看板占位（对比项）：`ui/src/components/task-master/types.ts`（`TaskBoardView`/`TaskKanbanColumn`）、`ui/src/components/main-content-v2/TasksV2.tsx`
- dsh 参考实现（用户已验证）：`dsh-project-kanban`（MIT）——宿主端 `index.js`（14 个 `kanban_*` 工具 + `/api/kanban` 数据层 + `kanban-board-<workspaceId>.json` 按工作区持久化 + 原生拖拽），浏览器端 `lib/client.js`（`conversation.view` slot 注册 `id:'kanban', order:20, label:'看板'`）。安装于 `~/.dsh/profiles/<profile>/node_modules/dsh-project-kanban/`
