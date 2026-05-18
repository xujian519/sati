# Session Sidebar — 定稿方案

> 状态：定稿，可按此实现  
> 日期：2026-05-18  
> 键绑定决策：Ctrl+E 打开 sidebar / Esc 只做关闭与中断（与 Claude Code 一致）

---

## 1. 用户看到什么变了

PilotDeck TUI 的 session 管理从"多种命令、多种密度状态"简化为**两个模式**：

- **聊天模式**：全宽聊天，专注当前对话。Header 右上角有 session 状态 badge。
- **导航模式**：左侧 sidebar 列出所有 session（按项目或状态分组，可折叠），右侧显示当前聊天内容（只读）。

按 `Ctrl+E` 打开 sidebar，按 `Esc` 关闭。`Esc` 在 agent 运行时中断 turn（与 Claude Code 语义一致）。

---

## 2. Before / After

### 进入 session 列表

```
Before: 4 种方式
  Esc（空输入）  →  全屏 Overlay
  Ctrl+D         →  切换 Strip（2 列图标柱）
  /switch        →  全屏 Overlay
  /dashboard     →  全屏 Overlay

After: 2 种方式
  Ctrl+E         →  Sidebar（终端 ≥ 70 列）或 Overlay（终端 < 70 列）
  /dashboard all →  全屏 Overlay（跨项目查看时）
```

### 密度状态

```
Before: hidden / strip / overlay（3 态 + Ctrl+D 循环）
After:  closed / sidebar / overlay（3 态，互斥，不循环）
```

### 快捷键

```
Before: Ctrl+D = 切换 strip（与 shell EOF 冲突）
        Esc（空输入）= 打开 overlay（"打开"语义不符合 Esc 惯例）
After:  Ctrl+D 删除
        Ctrl+E = 打开 sidebar（"E = Explore sessions"）
        Esc = 只做关闭/中断，从不打开任何面板
```

### Session 多了怎么办

```
Before: 平铺列表，滚动翻找
After:  按项目/状态分组，组可折叠
        ▾ PilotDeck (5)
          > ✻ Fix CI…
            ✽ Deploy…
        ▸ OtherProject (3)    ← 折叠，一行搞定
```

---

## 3. 状态模型

### 3.1 核心字段变更

```typescript
// 删除
dashboardDensity: DashboardDensity;   // "hidden" | "strip" → 删除
dashboardOpen: boolean;                // → 替换为 dashboardMode

// 新增
dashboardMode: "closed" | "sidebar" | "overlay";
sidebarCursorIndex: number;            // sidebar 内光标位置（含 header 行）
sidebarCollapsed: Set<string>;         // 折叠的组 key（projectKey 或 "status:xxx"）
```

### 3.2 向后兼容

所有原来检查 `state.dashboardOpen` 的地方改为：

| 原判断 | 新判断 |
|--------|--------|
| `state.dashboardOpen` | `state.dashboardMode !== "closed"` |
| `state.dashboardOpen`（在 overlay 键盘处理块内） | `state.dashboardMode === "overlay"` |
| `!state.dashboardOpen`（关闭面板相关） | `state.dashboardMode === "closed"` |

### 3.3 状态转换图

```
              Ctrl+E (cols≥70)       /dashboard all
    closed ──────────────────────► sidebar ◄──────────── (不经过,直接到overlay)
       ▲                              │
       │ Esc / Enter(切换session)     │ Esc
       │                              ▼
       │                           closed
       │
       │    Ctrl+E (cols<70)
       │    /dashboard all
       └────────────────────────► overlay
       ▲                              │
       │ Esc / Enter(切换session)     │
       └──────────────────────────────┘

    Ctrl+E (cols<70) → 直接到 overlay（降级）
    sidebar 打开时执行 /dashboard all → sidebar 关闭, overlay 打开（互斥）
    overlay 打开时按 Esc → overlay 关闭, 回 closed（不是回 sidebar）
```

### 3.4 Esc 语义统一表

`Esc` **只做关闭和中断，从不打开任何东西**（与 Claude Code 一致）：

| 当前状态 | Esc 效果 |
|---------|---------|
| agent 运行中（isRunning） | 中断 turn（soft abort，不退出程序） |
| sidebar 打开 | 关闭 sidebar → closed |
| overlay 打开 + filter 有内容 | 清除 filter |
| overlay 打开 + filter 为空 | 关闭 overlay → closed |
| peek 打开 | 关闭 peek |
| help 打开 | 关闭 help |
| 空闲 + 有输入 | 清除 scrollOffset / focusedIndex |
| 空闲 + 空输入 | 无操作 |

### 3.5 互斥规则

- `sidebar` 和 `overlay` 永远不能同时存在
- 进入 `sidebar` 时如果 `overlay` 是开的，先关 `overlay`
- 进入 `overlay` 时如果 `sidebar` 是开的，先关 `sidebar`
- `dashboardMode = "closed"` 时 sidebar 相关键盘处理全部跳过

---

## 4. 完整键盘映射表

### 4.1 聊天模式（`dashboardMode === "closed"`）

| 按键 | 条件 | 效果 |
|------|------|------|
| `Ctrl+E` | cols ≥ 70 | fetch data → `dashboardMode = "sidebar"` |
| `Ctrl+E` | cols < 70 | fetch data → `dashboardMode = "overlay"`（降级） |
| `Esc` | isRunning | 中断 turn（soft abort） |
| `Esc` | helpOpen | 关闭 help |
| `Esc` | 有输入 | 清除 scrollOffset / focusedIndex |
| `Esc` | 空输入 + 空闲 | 无操作 |
| `Tab` | 空输入 | tool output 焦点循环（现有行为，不变） |
| `Shift+Tab` | 空输入 | tool output 反向循环（现有行为，不变） |
| `Ctrl+C` | isRunning | abort turn |
| `Ctrl+C` | !isRunning | exit |
| `PageUp` / `Shift+↑` | — | 向上滚动 |
| `PageDown` / `Shift+↓` | — | 向下滚动 |
| `Enter` | — | 提交输入 |

### 4.2 Sidebar 模式（`dashboardMode === "sidebar"`）

| 按键 | 条件 | 效果 |
|------|------|------|
| `↑` | — | 光标上移（跳过折叠组的 session 行） |
| `↓` | — | 光标下移 |
| `Enter` | 光标在 session | resumeSession → 切换 → `dashboardMode = "closed"` |
| `Enter` | 光标在 group header | 切换折叠/展开 |
| `→` | 光标在 session | 同 Enter（切换 session） |
| `→` | 光标在 collapsed header | 展开该组 |
| `→` | 光标在 expanded header | no-op |
| `←` | 光标在 session | 光标跳到所属 group header |
| `←` | 光标在 expanded header | 折叠该组 |
| `←` | 光标在 collapsed header | no-op |
| `Esc` | — | `dashboardMode = "closed"` |
| `Ctrl+E` | — | `dashboardMode = "closed"`（再按一次 = 关闭） |
| `/` | — | 进入 filter 编辑模式（复用 dashboardFilterEditing） |
| `Ctrl+S` | — | 切换 groupBy: project ↔ status |
| `Ctrl+C` | — | `dashboardMode = "closed"` |

### 4.3 Overlay 模式（`dashboardMode === "overlay"`）

**完全保持现有行为不变。** 包括 ↑↓ 选择、Enter/→ 切换、Space peek、/ filter、Esc 关闭。

### 4.4 不变的按键

| 功能 | 按键 | 说明 |
|------|------|------|
| Permission 响应 | y/a/n | pendingPermissions 时生效，不受模式影响 |
| Viewer | j/k/q/g/G | viewerContent 时生效 |
| 输入历史 | ↑/↓（聊天模式时由 PromptInput 消费） | 不变 |

---

## 5. Sidebar 视觉规格

### 5.1 布局

```
┌──────────────────────────────────────────────────────┐
│ PilotDeck ↗  v0.1.0                       2⚠ 1✽    │  ← Header（不变）
│ model · default · ~/project · local in-process       │
├─────────────────────┬────────────────────────────────┤
│  Sessions        /  │  [当前聊天内容]                  │
│ ▾ PilotDeck (5)     │  assistant: 好的，我来...       │
│   > ✻ Fix CI…  2m   │  tool: ✓ bash                   │
│     ✽ Deploy…  5m   │  assistant: 已经完成...          │
│     ∙ Refact…  1h   │                                 │
│     ✓ Old mi…  2d   │                                 │
│     ✓ Setup…   3d   │                                 │
│ ▸ Other (3)         │                                 │
│ ▸ Side (1)          │                                 │
│                     │                                 │
│ ↑↓ nav  Enter go    │                                 │
│ ←→ fold  Esc back   │                                 │
├─────────────────────┴────────────────────────────────┤
│  > _                                                  │  ← PromptInput（失焦）
└──────────────────────────────────────────────────────┘
```

### 5.2 尺寸

```
SIDEBAR_WIDTH = 30  （固定列数，不随终端伸缩）
最小终端宽度 = 70   （sidebar 30 + 分隔 1 + 聊天区 39）
终端 < 70 列时 → Ctrl+E 直接打开 overlay，不走 sidebar
```

### 5.3 Sidebar 内每行格式

**Group header（展开）：**
```
▾ ProjectName (N)
```

**Group header（折叠）：**
```
▸ ProjectName (N)
```

**Session 行：**
```
  [>] icon title…  time
```

- `>` = 当前光标所在行（选中）
- `icon` = statusIcon（✻/✽/∙/✓/✗/■/✢）
- `title` = 截断到可用宽度
- `time` = relativeTime（2m, 1h, 3d）
- 当前活跃 session 的 icon 显示为 brandAccent 色 + bold

### 5.4 底部快捷键提示

Sidebar 底部固定一行灰色提示：
```
↑↓ nav  Enter go  ←→ fold  Esc back
```
占 1 行高度。

---

## 6. 折叠逻辑

### 6.1 智能默认

Sidebar 打开时自动计算初始折叠状态：

```
for each group:
  if group 包含 activeSessionKey → 展开
  else → 折叠
if 只有一个 group → 不显示 header，直接平铺 session
```

### 6.2 手动操作

- **Enter on header** / **→ on collapsed header** / **← on expanded header** → 切换折叠
- 折叠一个组时，如果光标在该组的某个 session 上 → 光标跳到该组 header
- 展开一个组时，光标停在 header 不动

### 6.3 切换 groupBy 时

`Ctrl+S` 切换 project ↔ status 时：
- `sidebarCollapsed` 清空（因为 group key 变了）
- 重新应用智能默认
- `sidebarCursorIndex` 重置为 0

### 6.4 状态存储

```typescript
sidebarCollapsed: Set<string>
// key = ProjectDashboardGroup.projectKey
// 例如 "/Users/da/ws/PilotDeck" 或 "status:working"
```

---

## 7. 数据流

### 7.1 Sidebar 打开时

```
用户按 Ctrl+E
  → 调用 fetchDashboardGroupsForTuiScoped(gateway, projectKey, "current")
  → 返回 ProjectDashboardGroup[]
  → setState: dashboardMode = "sidebar", dashboardGroups = groups
  → 计算智能默认折叠 → sidebarCollapsed = Set<string>
  → sidebarCursorIndex = 0
```

和 overlay 共用同一个 `openDashboard()` 函数，只是 mode 不同。

### 7.2 实时更新

```typescript
// 当前代码（dashboard-notification-actions.ts 第 45 行）：
if (!state.dashboardOpen) return state;

// 改为：
if (state.dashboardMode === "closed") return state;
```

```typescript
// 当前代码（TuiApp.tsx 第 262 行）：
if (!state.dashboardOpen) return undefined;

// 改为：
if (state.dashboardMode === "closed") return undefined;
```

这样 sidebar 和 overlay 都能收到实时推送。

### 7.3 `state.sessions` 的角色

`state.sessions`（`GatewaySessionInfo[]`）保持现状——启动时 fetch 一次，用于：
- Header badge 计算
- SessionHint 显示（聊天模式底部一行）
- 当作 sidebar/overlay 还没打开时的 fallback 数据

Sidebar/overlay 打开后，数据源切换到 `state.dashboardGroups`（更详细的 `SessionDashboardInfo[]`）。

---

## 8. 窄终端降级

| 终端宽度 | Ctrl+E 行为 | 说明 |
|---------|------------|------|
| ≥ 70 列 | 打开 sidebar | 正常体验 |
| < 70 列 | 打开 overlay | 全屏，无需 sidebar 空间 |
| < 40 列 | 打开 overlay（compact 模式） | DashboardView 已有 tier 适配 |

判断时机：在 Ctrl+E handler 内读取 `stdout.columns`，即时判断。不存状态。

---

## 9. Peek 行为

### 9.1 Sidebar 模式

**Sidebar 内不支持 Peek。** 原因：
- Sidebar 的价值是"快速看一眼、切换"，不是"深入检查"
- Peek 需要大面积显示内容，sidebar 右侧已经是 MessageList，再叠 Peek 布局复杂
- 用户想 Peek → `/dashboard` 进入 overlay，overlay 的 Peek 完整保留

### 9.2 Overlay 模式

**完全不变。** Space 打开 peek，Esc 关闭。现有全部 peek 功能保留。

---

## 10. 命令行为

| 命令 | 新行为 | 变化 |
|------|--------|------|
| `/switch`（无参数） | 等同于 Ctrl+E：开 sidebar（cols≥70）或 overlay（cols<70） | 原来直接开 overlay |
| `/switch N` | 直接切换到第 N 个 session | 不变 |
| `/switch <text>` | fuzzy match → 切换；未匹配 → 开 overlay+filter | 不变 |
| `/sessions` | 同 `/switch` | 不变 |
| `/dashboard` | 等同于 Ctrl+E：开 sidebar（cols≥70）或 overlay（cols<70） | 原来直接开 overlay |
| `/dashboard all` | 开 overlay（全项目） | 不变 |
| `/bg` | 后台化 + 开 sidebar（cols≥70）或 overlay（cols<70） | 原来开 overlay |

---

## 11. 删除清单

| 文件/代码 | 动作 |
|-----------|------|
| `SessionStrip.tsx` | **删除整个文件** |
| `STRIP_WIDTH` | 删除所有引用 |
| `DashboardDensity` 类型定义 | 删除 |
| `dashboardDensity` state 字段 | 删除，替换为 `dashboardMode` |
| `dashboardOpen` state 字段 | 删除，替换为 `dashboardMode` |
| `Ctrl+D` handler（TuiApp.tsx 623-636） | 删除 |
| `showStrip` 变量及条件渲染 | 删除 |
| HelpDialog 中 `Ctrl+D` 说明 | 删除 |
| Esc（空输入）打开 overlay 的逻辑（TuiApp.tsx 843-844） | 删除（Esc 不再打开任何东西） |

## 12. 新增清单

| 文件/代码 | 说明 |
|-----------|------|
| `SessionSidebar.tsx` | 新组件：分组列表 + 折叠 + 选中 + 底部提示 |
| `dashboardMode` 字段 | `"closed" \| "sidebar" \| "overlay"` |
| `sidebarCursorIndex` 字段 | sidebar 光标位置 |
| `sidebarCollapsed` 字段 | `Set<string>` 折叠状态 |
| `computeSmartCollapse()` | 辅助函数：根据 activeSessionKey 算默认折叠 |
| `flattenSidebarRows()` | 辅助函数：考虑折叠的 flatten |
| `Ctrl+E` handler | 打开 sidebar（或降级 overlay）|
| `Esc` 中断 turn 逻辑 | isRunning 时 soft abort（与 Claude Code 一致） |

---

## 13. 实现顺序

按依赖关系排序，每步完成后 `tsc --noEmit` 通过。

| 步骤 | 文件 | 内容 | 预计改动量 |
|------|------|------|-----------|
| **Step 1** | `types.ts` | 删 `DashboardDensity`，删 `dashboardOpen`/`dashboardDensity` 字段，加 `dashboardMode`/`sidebarCursorIndex`/`sidebarCollapsed` | ~15 行 |
| **Step 2** | `dashboard-reducer.ts` | `dashboard_open` action 接收 `mode: "sidebar" \| "overlay"` 参数；所有 `dashboardOpen` → `dashboardMode` | ~30 行 |
| **Step 3** | `dashboard-notification-actions.ts` | `dashboardOpen` → `dashboardMode !== "closed"` | ~3 行 |
| **Step 4** | `TuiApp.tsx` — 状态 | 初始值改为 `dashboardMode: "closed"`；删 strip 相关代码；`openDashboard()` 接收 mode 参数 | ~40 行 |
| **Step 5** | `TuiApp.tsx` — 键盘 | 删 `Ctrl+D`；加 `Ctrl+E` 开 sidebar/overlay；`Esc` 改为中断+关闭语义；加 sidebar 键盘块 | ~80 行 |
| **Step 6** | `SessionSidebar.tsx` | 新建：接收 groups/collapsed/cursor/activeKey/width/maxRows，渲染分组列表 | ~120 行 |
| **Step 7** | `TuiApp.tsx` — 渲染 | 删 strip 渲染；加 sidebar `flexDirection="row"` 布局 | ~20 行 |
| **Step 8** | `HelpDialog.tsx` | 删 Ctrl+D；加 "Ctrl+E = sidebar / Esc = close/interrupt / ←→ fold" | ~5 行 |
| **Step 9** | 删除 `SessionStrip.tsx` | 删文件 + 清理 import | ~3 行 |
| **Step 10** | `DashboardView.tsx` | `state.dashboardOpen` → `state.dashboardMode === "overlay"` 如有引用 | ~3 行 |
| **Step 11** | 类型检查 + lint | `tsc --noEmit`；修复剩余 | — |
| **Step 12** | 测试 | 更新 `session-switch.test.ts`、`dashboard.test.ts` 中 `dashboardOpen` 引用 | ~20 行 |

---

## 14. 验证清单

- [ ] `tsc --noEmit` 通过
- [ ] 80 列终端：Ctrl+E 打开 sidebar → ↑↓ 选择 → Enter 切换 → sidebar 关闭
- [ ] 60 列终端：Ctrl+E 打开 overlay（降级）
- [ ] 折叠：← 折叠组 → 组内 session 隐藏 → → 展开组
- [ ] 智能默认：当前 session 所在组自动展开，其他折叠
- [ ] `/dashboard all` 打开 overlay（不是 sidebar）
- [ ] `/switch 2` 直接切换（不开 sidebar）
- [ ] Header badge 在所有模式下正确
- [ ] Ctrl+D 不再有任何效果
- [ ] Tab 仍然是 tool focus 循环
- [ ] Esc 在 isRunning 时中断 turn
- [ ] Esc 在 sidebar/overlay 中关闭面板
- [ ] Esc 在空闲+空输入时无操作（不打开任何东西）
- [ ] Ctrl+E 在 sidebar 打开时关闭 sidebar（toggle）
- [ ] 现有 overlay 内 Peek 功能完整
- [ ] `tests/tui-e2e/session-switch.test.ts` 通过
- [ ] `tests/tui-e2e/dashboard.test.ts` 通过
