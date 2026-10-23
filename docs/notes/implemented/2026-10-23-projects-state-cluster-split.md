# Agent Note: B1.3 useProjectsState 三簇外置（#646）

Status: implemented

## Problem

`ui/src/hooks/useProjectsState.ts` 的 `useProjectsState` 是 **647 行**的 god hook，文件 **900 行**
（≥800 行存量豁免）。四类职责叠在同一闭包里：

1. 数据层：拉取项目、socket 增量合并、保留已加载会话视图；
2. 设置面板：`showSettings` / `settingsInitialTab` / `openSettings`；
3. 选择与分页：路由 `sessionId → selected*` 同步、项目/会话选择、新建、删除、deselect、
   `loadMoreSessions` 及其 loading 状态；
4. 乐观更新：提交消息时的会话置顶/占位，以及 `session_created` 占位替换、abort 回收。

计划 B1.3 判据：**openSettings / optimistic / selection 三簇外置，`useProjectsState` ≤400 行**。

## Decision

按职责外置为三个 hook + 一个纯函数模块，主 hook 保留数据层与装配：

| 模块 | 行数 | 内容 |
|---|---|---|
| `ui/src/hooks/useProjectSettingsPanel.ts` | 13 | `showSettings` / `settingsInitialTab` 状态 + `openSettings` |
| `ui/src/hooks/useProjectOptimisticUpdates.ts` | 143 | `applyProjectTransform` + `bumpSessionActivity` / `replaceOptimisticInProjects` / `dropOptimisticInProjects` / `handleResetProjectSessionPreview` |
| `ui/src/hooks/useProjectSelectionActions.ts` | 237 | `sessionId` 同步 effect；`handleProjectSelect` / `handleSessionSelect` / `handleNewSession` / `handleSessionDelete`；分页（`loadingMoreSessionsRef` / `loadingMoreProjectIds` / `setProjectLoading` / `loadMoreSessions`）；`handleProjectDelete` / `handleDeselectProject` |
| `ui/src/hooks/projectSessionUtils.ts` | 39 | `PROJECT_SESSION_PREVIEW_LIMIT`、`getProjectSessions`、`isTemporarySessionId`、`normalizeSessionId`、`resetProjectSessionPreview` |

结果：`useProjectsState` **647 → 367 行**，文件 **900 → 586 行**，脱离 §38.2 ≥800 清单，
`architecture-baseline.json` 存量豁免 **40 → 39**。

所有权约束：`projects` / `selectedProject` / `selectedSession` / `activeTab` / `sidebarOpen`
仍由主 hook 持有；selection hook 只通过入参读写，分页 loading 状态由 selection hook 独占并经
返回值暴露。未引入第二份状态源。

## Alternatives considered

1. **只把纯函数抽到 utils，hook 内保留 effect/handlers** —— `useProjectsState` 仍 >500 行，
   达不到 ≤400 判据；effect 与 handler 的闭包耦合才是可读性主因。
2. **把 `projects` / `selected*` 一并迁入 selection hook，主 hook 只做组装** —— 需要把
   `useState` 上下移动并把 setter 反向透传，触及 socket 合并与 `fetchProjects` 的写入路径，
   等价性证明面扩大到整个数据层；收益仅是少一层传参，风险不成比例。
3. **optimistic 并入 selection hook** —— 少一个文件，但把「乐观排序/占位」与「路由选择/分页」
   两类变更原因捆在一起；后续任一侧演进都要跨语义修改。
4. **继续单文件内以注释分区** —— 不改变 647 行的阅读与测试成本，也无法脱离 file-size 豁免。

## Verification

- **逐 token 证明 36/36**（基线 `0afced47c`，AST 定位 + scanner 逐 token）：
  未搬移模块声明 10、`projectSessionUtils` 4、settings 簇 3、optimistic 簇 5、selection 簇 11、
  主 hook 剩余 24 条语句、return **34 键顺序一致**、state/ref/effect 展开顺序一致。
  声明式改写仅有依赖数组：`applyProjectTransform` +`setProjects`/`setSelectedProject`；
  selection 各 callback +稳定 setters/`projectsRef`；`sidebarSharedProps` +`setShowSettings`
  （设置 setter 改由自定义 hook 提供后，exhaustive-deps 不再视其为内建稳定值）。函数体零 token 变化。
- **负控制**（正向恢复后复跑 36/36 + 25/25）：
  - C1：`replaceOptimisticInProjects` 去重分支翻为 `realExists = false` → 预期 1 红 / 24 绿；
  - C2：`handleSessionDelete` 的 total `-1` 改为 `+1` → 2 红 / 23 绿（两条断言 total 的用例）；
  - C3：仅改 `loadMoreSessions` 日志文案 → 逐 token 证明 35/36（仅该段红），测试 25/25 全绿。
- 新增 jsdom 测试 `useProjectsState.hooks.test.tsx` **19 例**（设置面板 2、optimistic 7、selection 10）。
- 门禁：`pnpm check` EXIT=0；UI `vitest run` 198 文件 / 1505 用例全绿；
  根 `pnpm test` 5968 用例（5963 pass / 0 fail / 5 skip，已知降级项）；
  `pnpm test:pr-tooling` 197/197。
- 类型判定为 **A（状态层重构）**：渲染路径未变，按 checklist §0 以 jsdom + token + 负控制为验收面，
  未做浏览器 A/B（有意未验证项）。
