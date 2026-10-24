# Agent Note: B3.1 SidebarV2 五簇拆分（#646）

Status: implemented

## Problem

`ui/src/components/app-shell/SidebarV2.tsx` 的 `SidebarV2` 是 **1014 行**的 props-only 组件
（文件 **1322 行**，≥800 行存量豁免 BF-12），把七类职责叠在同一个函数体里：

1. 纯数据模型：时间戳归一、项目/会话最近活动、会话 flat 列表与 fork 树构建、相对时间、
   处理中/未读状态；
2. 会话树缓存（每次 `projects` 引用变化重建的 `useMemo`）；
3. 侧栏宽度：localStorage 持久化、按帧合并的拖拽采样、阈值门控、双击复位；
4. 就地重命名：项目/会话共用 draft、输入框聚焦、Enter/Escape/IME；
5. 右键菜单：坐标钳制、打开来源、点击/滚动/Escape 关闭；
6. 项目组与会话行两块大 JSX（会话行还含递归 fork 子节点、乐观占位行、折叠/加载更多）；
7. 品牌头、分区切换、Projects/General 分区、底部 Team/Settings、拖拽手柄与遮罩。

计划 B3.1 判据：**renderSessionRows / renderProjectGroup / 右键菜单 / resize / rename 五簇外置；
`SidebarV2` ≤400 行**。

## Decision

按「纯模型 → 状态 hook → 渲染组件」三层外置，主函数只保留装配与选择/展开逻辑：

| 模块 | 行数 | 内容 |
|---|---|---|
| `sidebarV2Model.ts` | 169 | 时间戳/最近活动、排序读取、flat 会话与 fork 树、相对时间、状态判定、会话树缓存 |
| `useSidebarProjectSort.ts` | 20 | `sati-settings` 排序偏好订阅 |
| `useSidebarResize.ts` | 91 | 宽度持久化、拖拽阈值与按帧采样、双击复位 |
| `useSidebarRename.ts` | 93 | 重命名状态/draft/聚焦 effect、begin/commit/cancel/key |
| `useSidebarContextMenu.ts` | 100 | 菜单状态、坐标钳制、打开来源、全局关闭 effect |
| `SidebarSessionRows.tsx` | 272 | 会话行（含 fork 递归、乐观占位、折叠/加载更多） |
| `SidebarProjectGroup.tsx` | 119 | 项目折叠组 |
| `SidebarSessionStatusIndicator.tsx` | 43 | processing 转点 / unread 圆点 |
| `SidebarHeader.tsx` | 67 | 品牌头 + 收起按钮 |
| `SidebarSectionToggle.tsx` | 64 | Projects / General 分段切换 |
| `SidebarProjectsSection.tsx` | 82 | 项目列表分区 |
| `SidebarGeneralSection.tsx` | 48 | General 分区 |
| `SidebarFooter.tsx` | 61 | Team / Settings |
| `SidebarContextMenu.tsx` | 57 | Rename / Delete 浮层 |

结果：`SidebarV2` **1014 → 380 行**，文件 **1322 → 426 行**，判据 ≤400 达成；
脱离 §38.2 ≥800 清单，`architecture-baseline.json` 存量豁免 **35 → 34**（BF-12 脱表）。
380 行按 M2 口径（300–399）留在 god function 清单，本 note 即其必需的决策记录。

所有权约束：`expandedGroups` / `collapsedSessionProjects` / `draftSessionProjectName` /
`activeSection` 仍由主组件持有；重命名状态由 `useSidebarRename` 独享；右键菜单状态由
`useSidebarContextMenu` 独享；宽度状态由 `useSidebarResize` 独享。三者均无需第二份状态源。
`closeContextMenu` 等稳定回调只作为入参传递，不复制状态。

## Alternatives considered

1. **只把两块 render 函数换成组件，hooks 留在主函数** —— 主函数仍 ~650 行，达不到 ≤400；
   宽度/重命名/右键菜单三簇的状态与 effect 才是阅读跳跃的主因。
2. **把 60+ 个字段扁平传给 `SidebarSessionRows`**（本次仍保留 22 个显式 props）——
   再拆一层「controller 对象」会让组件内解构名与搬迁前不一致，token 证明与审阅成本上升；
   `t` / 回调 / 选中态分开传更利于后续 memo 化。
3. **把 ProjectGroup 里的会话行 JSX 内联复制进组件** —— 会产生第二份会话行实现；
   保留 `renderSessionRows` 回调，由主函数只构造一次 `<SidebarSessionRows>`。
4. **将 `expandedGroups` / `activeSection` 一并迁入选择 hook** —— 会触及路由同步 effect 与
   `ensureExpanded` 的写入路径，等价性证明面扩大到整个选择层；收益仅是少几行装配。
5. **`beginRename*` 内部继续调用 `setContextMenu(null)`** —— 需要给 rename hook 注入 context
   hook 的关闭函数，两个 hook 相互依赖；改为在唯一调用点 `handleContextRename` 关闭菜单，
   行为等价且依赖单向（rename → 无，context → rename 状态）。

## Verification

- **逐 token 证明 34 段全绿，合计 5231 token**（基线 `366408140`，AST 定位 + scanner，脚本
  `/tmp/b31-token-proof.mjs`）：
  - 纯模型 11 段 + 会话树缓存 1 段；状态指示器 2 段；resize 2 段；rename 1 段；
    右键菜单 5 段；会话行 1 段（1187）；项目组 1 段（397）；八个渲染块 8 段；
    拖拽手柄/遮罩 2 段；容器骨架 2 段。
- 声明式改写（逐条）：
  1. 被搬移的纯函数与常量补 `export`；
  2. 会话树缓存 `safeProjects` → 形参 `projects`；
  3. 会话行 `options.flat` → prop `flat`；
  4. `SessionStatusIndicator` → `SidebarSessionStatusIndicator`（组件改名 + JSX 标签）；
  5. `beginRename*` 移除 `setContextMenu(null)`（移交 `handleContextRename`）；
  6. 依赖数组格式化尾逗号（biome，`[]` → `[],`）；
  7. 右键菜单组件 props `onRename` / `onDelete` 对应原 `handleContextRename` / `handleContextDelete`；
  8. 拖拽手柄 `onDoubleClick` 内联 lambda → 稳定回调 `resetSidebarWidth`；
  9. `isGeneral` 由函数体首条语句改为 props 解构。
- **hook 序列**：effect 注册顺序 **EQUAL**（宽度清理 → 重命名聚焦 → 菜单关闭 → 展开 →
  draft 复位 → 分区同步 → 排序订阅）；hook 多重集除 `useCallback 22 → 24` 外一致，
  新增两个稳定回调（`closeContextMenu`、`resetSidebarWidth`），替代原先的
  `setContextMenu(null)` 内联调用与双击内联 lambda。
- **负控制**（每次恢复后复跑证明全绿 + 测试全绿）：
  - C1：`hiddenLoadedCount` 去掉 `- COLLAPSED_SESSION_LIMIT` → **1F/23P**（折叠计数用例）；
  - C2：`isForkChildSession` 的 `knownSessionIds.has(...)` 取反 → **1F/23P**（fork 嵌套用例）；
  - C3：仅把品牌头 `h-16` 改为 `h-17` → 测试 **24/24 绿**、token 证明 S8 红（firstDiff=4）。
- 新增 `SidebarV2.sessions.test.tsx` **14 例**（拆分前实现上先绿）：会话行 6、右键/重命名 5、
  排序与分区 2、宽度持久化 1；与既有 `SidebarV2.test.tsx` 10 例合计 24 例。
- **双视口 A/B**（branch `5373` vs main worktree `5374`，1440×900 / 390×844，系统 Chrome）：
  - 桌面 welcome：侧栏根盒 248×900、两个分区 tab 盒与选中态、前 6 个项目标签、滚动容器盒、
    Settings 入口、composer slot、无横向溢出、无 pageerror —— 8 组；
  - 桌面打开既有会话后：侧栏根盒、滚动容器、composer 停靠 —— 3 组；
  - 移动 welcome：侧栏/标签/列表/入口/溢出/错误 —— 8 组；
  - 合计 **19/19**。
  - **有意未验证**：移动端打开会话后的侧栏（折叠态需先驱动「项目 → 会话」两级导航）；
    真实拖拽 resize 的像素变化（jsdom 已覆盖阈值/遮罩/落盘，A/B 未重复驱动鼠标拖拽）。
- 门禁：`pnpm typecheck`、UI typecheck、UI lint、`format:check`、13 个 `check:*` 全部 EXIT=0；
  `pnpm check` 聚合 **EXIT=1 仅因两条与本分支无关的本地 eslint 告警**
  （`tests/patent/graph/citation-check.spec.ts:4`、`tests/tool/builtin/patentPipelineTools.spec.ts:19`
  的 `import-x/order`，已在 origin/main 的干净 worktree 复现——本地 eslint 9.39.4 / biome 2.5.15
  高于仓库 schema 2.5.8 的工具链漂移；CI 侧以远端版本为准）。
  UI `vitest run` **205 文件 / 1608 用例全绿**；根 `pnpm test` **5996 / 0 fail / 5 skip**
  （既有环境依赖：本地法律库、非 CI graphviz 门槛、`patent_drafting_v1` fixture 未录制）；
  `pnpm test:pr-tooling` **208/208**；提交后 metrics / architecture / token 证明复跑通过。
