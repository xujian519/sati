# 团队活动面板重构设计：整页 tab → 右上角伴随浮层

> 日期：2026-08-20 ｜ 状态：已批准 ｜ 参照：dsh-agent-teams ActivityPanel + `docs/community-agent-teams-research.md` §4.1.7

## 背景与目标

M4 团队活动面板（`ui/src/components/team-panel/`，13 文件 1120 行）以侧边栏整页 tab 呈现，四段纵向堆叠（团队卡片网格 + 成员卡网格 + 任务行列表 + 事件流），一屏信息密度过大，且整页切换打断对话工作流。设计规范（`design-qa.md` compact 约定、`ui-beautification-plan.md` 令牌体系）要求面板与主界面共存。

参考 dsh-agent-teams 的伴随式活动面板，本次重构目标：**对话为主界面，团队监控作为右上角伴随浮层同屏展示**，按"队长摘要 + 总进度条 / 折叠成员树 / 任务 DAG（事件流并入）/ 收起浮标 + 活动自动展开"四手法重组信息。

## 形态决策

### 三态布局（复用 MainContent Files assistant 既有 docked/overlay 范式）

| 态 | 条件 | 表现 |
|---|---|---|
| Docked | chat 主界面 + 宽屏（非 Files / 非 dashboard 同屏 / 非 isNarrowWorkbench / 非 isMobile） | 右侧 380px 常驻列（`flex-shrink-0 border-l`），对话礼让 |
| Overlay | Files 模式 / 窄屏 <1040 / 移动端 / dashboard 同屏 | `absolute inset-y-0 right-0 z-40 shadow-2xl`，宽 `min(420px, 92vw)` |
| 浮标 | 面板收起 | 右上 `top-3 right-3` 药丸：团队数徽章 + 活动脉冲点 |

不采用 dsh 的 CSS data-attribute 让位机制——Sati 自为宿主，内联布局类即可。

### 面板内部结构（自上而下）

1. **TeamChips**：活动团队 chips（名称 + 任务数）+ 归档团队折叠区（"归档 (n)"）
2. **CaptainSummary**：队长卡（在线点 + "已派发 X 项任务给 N 名成员"）+ 分段进度条（每任务一段按状态着色）+ 图例 + 一句话摘要（"X/Y 已完成 · Z 进行中"）+ 归档按钮
3. **TaskDag**：依赖 DAG SVG——节点 92×30、列=依赖深度、行=taskId 字典序、贝塞尔连边、hover 180ms 高亮上下游（无关节点降透明）、点击固定；无依赖时自动并排网格（`isParallel`）；点击非终态节点内联转派 popover
4. **MemberTree**：默认折叠成员树——状态点（近 10s 有事件加脉冲环）+ 首字母圆头像 + memberId + 角色徽章 + 状态文本 + 当前任务（截断）+ done/total；底部保留添加成员表单
5. **最近动态**：底部一行最后 3 条事件徽章；事件同时驱动 DAG 节点/成员行脉冲指示

独立事件流大 section 删除。

## 关键机制

- **会话跟随**：自动选中 `captainSessionKey === sessionId` 的团队，chips 手动切换覆盖；归档团队仅 chips 折叠区可见
- **数据层不变**：5s 轮询快照保留；`PanelTask.dependencies: string[]` 已在契约中，DAG 投影为纯前端纯函数（`dag-model.ts`）；后端 `ui/server/routes/teams.js` 零改动
- **自动展开状态机**：`view: expanded | collapsed`；初始读 `localStorage["sati:team-panel-collapsed"]`；事件到达 + 挂载 >4s（settle 窗口防加载闪动）→ 自动展开一次；用户手动收起后 `userCollapsedRef` 置位，不再自动展开；ESC 关闭
- **watch 复用**：agent surface 恒挂载且 ChatInterfaceV2 已持有 useSessionWatch → 浮层不新建 watch（消除现状双 watch-session 重复）；事件流订阅能力迁入 `use-team-activity.ts`（50 条窗口 + 脏帧过滤 + 反向索引）
- **状态色单点维护**：`TASK_STATUS_FILL` 与既有 `TASK_STATUS_STYLE` 并列于 dag-model.ts，供 DAG 节点/进度条共用

## 文件影响

**新增**（`ui/src/components/team-panel/`）：
- `dag-model.ts` + `dag-model.test.ts`（纯函数投影）
- `hooks/use-team-activity.ts` + 测试（EventStream 订阅迁移）
- `floating-team-panel.tsx` + 测试（外壳：三态 + 状态机）
- `captain-summary.tsx`、`member-tree.tsx`、`task-dag.tsx`、`team-chips.tsx`

**删除**：`TeamPanel.tsx`、`TeamOverview.tsx`、`MemberGrid.tsx`、`TaskBoard.tsx`、`EventStream.tsx` + `TeamPanel.test.tsx`、`EventStream.test.tsx`

**保留**：`types.ts`（契约）、`hooks/useTeamPanel.ts` + 测试（轮询不变）、`FeedbackBanner.tsx`、`hooks/useActionFeedback.ts`

**接线改动**：
- `ui/src/types/app.ts`：AppTab 删 `"team"`（仅 4 处引用，无 URL 路由）
- `MainContent.tsx`：删 TeamPanel 分支，SplitBody 挂 FloatingTeamPanel（lazy）；props 增 `teamPanelOpen/onTeamPanelClose`
- `MainAreaV2.tsx`：DASHBOARD_TABS 删 team
- `AppShellV2.tsx`：`teamPanelOpen` state 接线
- `SidebarV2.tsx`：Team 按钮改浮层开关（`aria-pressed` + 激活态）
- `MainContent.test.tsx`：propsFor 工厂补齐

**i18n**（`teamPanel.json` en+zh-CN 同步）：删 `overview.title/memberCount/taskCount` 死键；新增 ~14 键（panel.* / captain.* / progress.legend / members.currentTask|expand|collapse / pill.* / events.recent）

## 错误处理与容错

- localStorage 读写全部 try/catch（现有惯例）
- 快照契约脏数据防御：DAG 忽略悬空/自依赖，DFS visiting 集防环
- 事件脏帧过滤（非 team_event / 非对象 / type 非 string 丢弃）
- 操作失败经 FeedbackBanner 双态反馈（沿用 useActionFeedback）

## 测试

- 新增：`dag-model.test.ts`（分层/菱形/环/悬空依赖/并行判定/确定性）、`use-team-activity.test.ts`（窗口/脏帧/取消订阅）、`floating-team-panel.test.tsx`（冒烟、建队失败 message、会话跟随选队、浮标徽章、4s 自动展开 + userCollapsed 语义、ESC 关闭）
- 保留：`useTeamPanel.test.tsx`；`MainContent.test.tsx` 补 props
- foreignObject：jsdom 不渲染，测试仅断言 `data-task-id` 属性与结构
- 验证：`cd ui && pnpm typecheck && pnpm test && pnpm lint`；根 `pnpm format:check`；手动 dev 清单（三态布局/自动展开/多团队/DAG/操作反馈/双语/暗色）

## 范围外

- 后端 teams.js / gateway 事件面零改动（不触发 event-matrix 门禁）
- 不做 dsh 的成员头像艺术（职业鲸鱼图）；用首字母圆头像
- 不做浮层可拖拽宽度（固定 380 docked / 420 overlay）
