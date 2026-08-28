# Agent Note: 「文件」视图与桌面侧栏互斥（快照/恢复语义）

Status: implemented

## Problem

`activeTab === "files"` 时，`AppShellV2` 里有一个 effect 会**强制展开**最左侧会话侧栏
（`setDesktopSidebarOpen(true)`）。用户点击顶栏「文件」按钮想进入文件工作视图时，侧栏反而
始终占着宽度，文件树 + 主工作区被挤压成三栏，与"文件视图 = 专注工作区"的预期相反。

## Decision

- 新增 `ui/src/hooks/useDesktopSidebarForFiles.ts` 统一承载该行为：进入 files tab 时**快照**
  当前桌面侧栏开合状态并自动收起；离开 files tab（无论去向 chat/kanban/选会话等）时**恢复**
  快照并清空。快照是会话级临时语义，不持久化。
- files 视图期间用户手动开合侧栏会**改写快照**——恢复时以用户最后的手动意图为准，而不是
  进入前的旧状态。
- 移动端完全不受影响（侧栏是抽屉，走独立的 `sidebarOpen`），`isMobile` 时整个 hook 逻辑
  no-op。
- 删除了原有的强制展开 effect；「文件」按钮本身（`MainAreaV2` 的 tab 切换）不改，行为
  全部收敛在侧栏状态层，因此其它进入/离开 files 的路径（看板按钮、选中会话、localStorage
  恢复的 activeTab 直落 files 等）语义一致。

## Alternatives considered

- **内联进「文件」按钮 onClick** — 只覆盖按钮这一条入口，选会话/看板/刷新直落 files 等
  路径行为不一致；且逻辑长在 760 行的 `AppShellV2` 里无法单测。落选。
- **快照持久化到 localStorage** — "进入前状态"只在本次会话内有意义，跨刷新恢复一个旧快照
  反而制造困惑；`activeTab` 本身的持久化已决定刷新直落 files 时以 mount 状态为快照，够用。
  落选。
- **复用 `useUiPreferences` 里闲置的 `sidebarVisible`** — 那是"用户偏好"语义（记住用户
  一般要不要侧栏），与本需求的"临时快照"语义不同，混用会让两个概念互相覆盖。该 hook 目前
  无消费者，保持闲置。落选。

## Consequences

- 换来：文件视图获得完整宽度（侧栏自动让位），退出时无感还原；行为集中在单一可单测的
  hook（6 个用例覆盖进入/退出/直落 mount/手动改写/kanban 出口/mobile no-op）。
- 付出：桌面侧栏状态多了一层"快照"间接性，排查侧栏开合问题时需要同时看 `activeTab`；
  依赖 ref 镜像避免 effect 依赖扩散，对不熟悉该模式的人有少量阅读成本。
