# Agent Note: `ui/server` 资源与延迟收敛（文件树跳过表 / `/commits` 单次聚合 / bridge 缓存上限）

Status: implemented

## Problem

`docs/open-issues-remediation-plan.md` §3.5 的 P5 批次，三条同属 `ui/server`（JS，vitest），文件不重叠、验证命令相同，合批省两次 CI 往返：

- **`#533`（TD-UISERVER-N11，层①）**：`GET /api/project-files` 经 `getFileTree(maxDepth=10)` 从项目根**急切遍历整棵树**，跳过表（`filesystem.js`）排除了 `node_modules`/`dist`/`.git` 等却**遗漏 `.pnpm-store`**。实测全树 **59,297 节点 / 621ms**，其中 `.pnpm-store` 占 **52,639 = 88.8%**（1.0G 的包管理器缓存）；跳过它只剩 **6,658 节点 / 67ms**。附带的 `showHidden` 是**死参**（声明并递归传递，函数体从不读），`project-files.js` 注释「showHidden=false」名不副实。

- **`#534`（TD-UISERVER-N04）**：`/commits` 在 `for` 循环里为每个 commit 串行 `spawnAsync("git", ["show","--stat",...])`，`limit` 上限 100 ⇒ 最多 100 次串行子进程。实测 10 条 **130ms**、100 条 **1,140ms**；单次 `git log --stat` 对应 **17ms / 43ms**。该路由**零测试覆盖**。

- **`#529`（TD-UISERVER-N02 残留半）**：`sati-bridge.js` 的 4 张 per-session 缓存（`_sessionTitleCache`/`_userQueriesCache`/`_toolSequenceCache`/`_subagentPromptCache`）**只增不减**。#413（PR #425）已给 `sessionState`/`pendingAgentToolCalls` 立了 `MAX_ACTIVE_SESSIONS = 500` + 逐出的先例，这 4 张是同型残留。

## Decision

### ① #533 — 跳过表补 `.pnpm-store`，判据抽成纯函数（层① only）

把内联跳过条件抽成**依赖自由的叶子模块** `ui/server/services/fileTreeSkip.js` 的纯函数 `shouldSkipEntry(name)`，`filesystem.js` 导入并在 `getFileTree` 里改用之、且再导出。**为什么单独一个叶子文件**：`filesystem.js` 的传递依赖链会经 `routes/projects.js` 拉到 `src/patent/...`，在 UI 的 vitest/jsdom 环境下 `import.meta.url` 解析失败（`The URL must be of scheme file`）而无法加载；把判据放进零依赖叶子模块即可**直测真函数**（而非像 `isSatiSessionKey.test.js` 那样手抄一份）。跳过集在原样保留旧行为（含 `.sati*` 与大小写不敏感的 `.sati_build.*` 束）基础上，新增 `.pnpm-store`、`__pycache__`，并加一条「点开头包管理器/构建缓存」通则（`.yarn`/`.cargo`/`.pnpm`/`.npm`/`.gradle`/`.m2`/`.venv`/`.tox`/`.*_cache`），避免逐个缓存目录重演本 issue。`showHidden` 死参**只更正注释、不改签名/行为**（改签名会波及调用点，超出还债范围）。

**只做层①**：issue 定义的债务是「跳过表遗漏 `.pnpm-store`」，层①（≈1 行判据 + 通则）即还清并拿掉 88.8% 节点。层②（首屏 `maxDepth=1` 懒加载，需新增 children 路由 + `FilesV2` 与 @ 提及两处客户端改造）是**跨端重构**而非还债，拆独立议题（不阻塞 #533 关闭）；层③（并发 stat）在层①后收益 <60ms 且抬高 fd 压力，不做。

### ② #534 — 合并为单次 `git log --stat`，按 header 正则切块

`/commits` 改为一次 `git log --pretty=format:%H|%an|%ae|%ad|%s --date=iso-strict --stat -n <limit>`，解析交给**依赖自由的叶子模块** `ui/server/utils/gitCommitLog.js` 的纯函数 `parseCommitLogWithStats(stdout)`（`git.js` 导入之）。**切块必须按 header 正则**（`/^[0-9a-f]{40,64}\|/`，兼容 SHA-1/SHA-256）**而非空行**：实测 merge commit 的 `--stat` 段**完全缺失且其后无空行**，按空行分块会把下一提交的 stat 串到 merge 上。块内取最后一个匹配 `/\d+ files? changed/` 的行为 `stats`，无匹配则 `""`——与旧实现对 merge / 取不到对象返回空串**等价**。`limit` 钳制逻辑（`Math.min(parsed,100)`，非法→10）一字未动。**为什么单独一个叶子文件**：与 ① 同理——`git.js` 顶部的 express + gateway bridge 依赖让它在 vitest 下加载昂贵，且 `git.js` 是 `architecture-baseline.json` 里的 file-size 存量豁免文件（基线 1529 行，棘轮「不得再增长」）；把解析器抽到零依赖叶子既让纯函数可直测，又让 `git.js` 净**减** 22 行（1529→1507）而非增行触棘轮。

### ③ #529 — `setBounded` FIFO 上限，复用 `MAX_ACTIVE_SESSIONS`

新增**依赖自由的叶子模块** `ui/server/utils/boundedMap.js` 的纯函数 `setBounded(map, key, value, limit)`（Map 插入序 FIFO；重设已有 key 先删后插以刷新新近度；超限逐出最旧；返回同一 map 以便链式）。`sati-bridge.js` 导入之并套用到 4 处 `set`，**每处显式传入 `MAX_ACTIVE_SESSIONS`**（叶子不带默认值——上限是调用方的策略、不是容器的语义），与 `sessionState` **同构复用同一个 500 常量**。抽叶子的理由同 ①②：`sati-bridge.js` 是最大的 file-size 存量豁免文件（基线 2347 行），把 31 行的 helper 移出后该文件对本特性的净增长只剩 **1 行 import**（2347→2348），已用 `--update-baseline` 显式追认并在本 note/PR 说明。

**修法方向修正**：issue 建议的「或按 mtime 失效时顺带删除已消失会话的键」**不可行**——实测这 4 张缓存的唯一调用方是 `getRouterDashboardData()`（← `routes/system.js`），其 `sessionId` 取自**落盘 router stats 里的历史会话**，因此**不存在「会话结束」钩子**（`cleanupSessionBookkeeping` 只清另三张 live-turn map），且标题缓存**无 mtime 校验**。⇒ FIFO 容量上限是唯一可行落点，而非会话生命周期钩子。

## Alternatives considered

- **#533 把 `shouldSkipEntry` 留在 `filesystem.js` 内并手抄进测试** — 落选。手抄副本会与实现漂移（正是 `isSatiSessionKey.test.js` 的既有妥协）；抽到零依赖叶子模块能直测真函数，且让「跳过判据」成为一个有名字、可复用的概念。
- **#533 顺手做层②（首屏懒加载）** — 落选（见上：跨端重构，会把一个 S 的卫生工作变成 L 的功能开发，回滚粒度失真）。拆独立议题。
- **#533 删除 `showHidden` 死参** — 落选。它是行为中性的签名清理，但会波及 `getFileTree` 的所有调用点与递归传递，超出「还清跳过表债」的范围；本批只更正误导性注释。
- **#534 按空行分块解析** — **否决**。merge commit 的 `--stat` 段缺失且无尾随空行，空行分块会把下一提交的 stat 串到 merge 上（正是 issue 未点明、但实测会踩的解析边界）。按 header 正则切块对 merge 天然产出 `""`。
- **#534 保留 per-commit `git show` 但改并发** — 落选。并发 100 个子进程会瞬时抬高 fd/进程压力，且仍比单次 `git log --stat` 慢一个量级（43ms vs 并发 spawn 的调度开销）；单次聚合既快又简单。
- **#529 用真正的 LRU（带 TTL/访问序刷新）** — 落选（本批）。这 4 张缓存的 key 是历史会话、无访问局部性可言，FIFO 已足以封顶；引入 LRU/TTL 会增加语义与测试面而收益不明。FIFO 与既有 `sessionState` 逐出同构，认知成本最低。
- **#529 按 issue 原文「mtime 失效时顺带删键」** — **不可行**（见 Decision ③：无会话结束钩子、标题缓存无 mtime）。
- **#534/#529 把 `parseCommitLogWithStats`/`setBounded` 直接留在 `git.js`/`sati-bridge.js` 内（不抽叶子）** — 落选。这两个文件都是 `architecture-baseline.json` 的 file-size **存量豁免**文件，棘轮规则是「豁免文件不得再增长」；就地新增 helper 会让 `git.js` +29、`sati-bridge.js` +32 双双越线，只能 `--update-baseline` 追认两个最大文件的增长——与棘轮「压制大文件膨胀」的意图相悖。抽到零依赖叶子后：`git.js` 反而**净减 22 行**（1529→1507，解析器移出 > import 移入），`sati-bridge.js` 净增仅 **1 行 import**（2347→2348，已追认），且两个纯函数都获得**可直测**的叶子测试（不必再经 express/bridge 加载）。`--update-baseline` 只用于承认这 1 行 import，而非承认 32 行就地膨胀。

## Consequences

- **正向**：文件树首屏 **621ms → 67ms**、节点 **59,297 → 6,658**（层①）；`/commits` **130ms → ~17ms**（limit=10）、**1,140ms → ~43ms**（limit=100）、子进程 **N+1 → 1**；4 张 bridge 缓存封顶 500，长进程不再无界增长。
- **行为差异（唯一，且纯外观）**：#534 旧路径 `.trim().split("\n").pop()` 会在摘要行残留一个**前导空格**，新实现按行 `trim()` 归一。前端以文本渲染，HTML 折叠前导空白，无可见影响；测试对该差异显式归一后断言内容等价。
- **护栏（新增测试，全 vitest）**：
  - `services/fileTreeSkip.test.js`（6 例）：`.pnpm-store`/`node_modules`/`.sati*`/`.yarn` 等跳过、`src`/`ui`/`package.json` 不跳过、`.gitignore`/`.github`/`node_modules_backup` 不过度匹配。**负控制**：从跳过集去掉 `.pnpm-store` ⇒ 「skips .pnpm-store」用例红。
  - `utils/gitCommitLog.test.js` 未单设——`parseCommitLogWithStats` 的 5 例纯函数单测落在 `routes/git.test.js`（直接 `import` 叶子，不再经 `loadGitModule`）：header 正则切块、subject 内含 `|`、merge → `stats===""`、rename/binary 摘要行、空输出 → `[]`。同文件另有 3 例 `GET /api/git/commits` 集成（两/三提交 repo 的 `stats` 与旧 `git show --stat --format=` 摘要**逐条等价**、真实 merge commit → `""`、`limit` 钳制 2/0/abc/999）。`git.test.js` 共 13 例。**负控制**：换回空行分块 ⇒ merge 用例红。
  - `utils/boundedMap.test.js`（5 例，从 `sati-bridge.test.js` 移出以贴近叶子）：600 key → `size==500` 且最旧逐出、显式 500 上限、重设刷新新近度、缓存命中不变、小 limit 与链式返回。**负控制**：去掉上限 ⇒ `size<=500` 用例红。`sati-bridge.test.js` 因此**回到 16 例**（不再 import `setBounded`）。
- **棘轮/度量联动**：`#534` 把解析器抽到叶子使 `git.js` **净减 22 行**（1529→1507，file-size 存量豁免，减行不触棘轮）并减 2 处无参 `catch`（与 #530 指标基线交叉，故 P5 排在 P2 之后）；`#529` 把 `setBounded` 抽到叶子使 `sati-bridge.js` 对本特性净增仅 **1 行 import**（2347→2348），用 `node scripts/check-architecture-boundaries.mjs --update-baseline` 显式追认（打印 Δ：git.js −22 / sati-bridge.js +1，合计 −21），理由即本 note「Alternatives considered」末条。两文件均在 `metrics.md` Top30 ⇒ 已跑 `pnpm measure:update`（新增 3 个叶子文件计入 `ui/server` 文件数）。
- **账本回填（顺手，属 P9 但同 PR 做）**：`backlog.md` 的 `TD-UISERVER-N02` 行号从 `:1237/1319/1435/1529` 更正为当前 HEAD 的 `:1470/1556/1672/1756` 并标 done（#529）；`TD-UISERVER-N04` 标 done（#534）、「候选路径枚举 4 份逐字复制」的共享 helper 抽取记为**残留子债**（与容量上限正交，未在本批处理）。

## 相关

- 议题：`#533`（TD-UISERVER-N11，层①）· `#534`（TD-UISERVER-N04）· `#529`（TD-UISERVER-N02 残留半）。
- 先例：#413（PR #425）为 `sessionState`/`pendingAgentToolCalls` 立的 `MAX_ACTIVE_SESSIONS = 500` + 逐出——#529 同构复用。
- 代码：`ui/server/services/fileTreeSkip.js`（新叶子，`shouldSkipEntry`）· `ui/server/services/filesystem.js`（导入并再导出）· `ui/server/utils/gitCommitLog.js`（新叶子，`parseCommitLogWithStats`）· `ui/server/routes/git.js`（导入叶子）· `ui/server/utils/boundedMap.js`（新叶子，`setBounded`）· `ui/server/sati-bridge.js`（导入叶子，4 处显式传 `MAX_ACTIVE_SESSIONS`）· `ui/server/routes/project-files.js`（更正 `showHidden` 死参注释）。
- 方案：`docs/open-issues-remediation-plan.md` §2.3 第 4/6 条 · §3.5 · §4.1（P5↔P2 基线交叉）· §6.1 fork 1(a)/2(a)。
- 母清单：#356（`ui/server` 候选清单）；衍生条目：#533 层② 首屏懒加载（另立议题）。
