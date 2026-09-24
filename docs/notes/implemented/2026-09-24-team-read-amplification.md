# Agent Note: 团队编排热路径读放大收敛——TeamShare 实例缓存 + 面板退休集一次查回（#531）

Status: implemented

## Problem

`docs/open-issues-remediation-plan.md` §3.7 的 `#531`（`TD-TEAM-N09` + `TD-TEAM-N10(a)`）。
团队编排的两条热路径都在做「本可用增量/一次查询完成」的全量同步读，且随数据量单调增长：

**(a) TeamShare 无实例缓存**：`TeamShare` 构造即 `load()`（`team-share.ts:50-53`），`load()`
对整份黑板 JSONL `readFileSync` + 逐行 `JSON.parse`（`:138-160`）。三个生产点**每次新建**：
`teamShare.ts:112`（write，且写也是 O(n)：先全量 load 再 append 一行）、`:189`（read）、
`teamSubsystem.ts:166`（`readSharedBoardSummary`）。调度器在 `kickMember` 派发路径经
`readSharedBoardSummary`（`scheduler.ts:253`）注入黑板摘要 ⇒ **每次任务派发 = 一次全量同步读盘**，
而 `summary()` 语义上只需要「每 key 最新值 ≤10 条」。

**(b) 面板快照 O(团队×成员) + 每成员一次 SQL**：`teamPanel.ts:32-35` 取三张全量数组
（`listTeams` + `listMembers` + `teams.flatMap(listTasks)`），`:44-45` 在 `teams.map` 内对
`members`/`tasks` 两份全量数组**逐队 `filter`** ⇒ O(团队×成员) + O(团队×任务)；且每个成员经
`toMemberView` → `views.ts:38` `db.isRetired(member.sessionKey)` → `team-db.ts:418-423`
**一次同步预编译查询** ⇒ 退休判定是 O(成员) 次 SQL。UI 每 10s 轮询一次（`constants.ts:4`）。

当前数据量小尚未暴露，属「新增期扩张留下的一致性税」，收敛点清晰、爆炸半径小。

## Decision

### ① TeamShare 进程内**实例缓存**（`getTeamShare` / `writeTeamShare`），按 `(mtimeMs, size)` 失效

模块级 `Map<path, {mtimeMs, size, inst}>`（`team-share.ts`）：

- `getTeamShare(path)`：`statSync` 取签名，命中且 `(mtimeMs, size)` 未变 ⇒ 返回**同一实例**
  （不重新 `load`）；否则 `new TeamShare(path)` 重建并写缓存。读路径（`teamShare.ts` read、
  `teamSubsystem.readSharedBoardSummary`）用它。
- `writeTeamShare(path, entry)`：`getTeamShare` → `inst.write(entry)` → 用**写后** stat 刷新
  缓存签名（仅当缓存仍指向本实例时），让同进程后续读命中这个已含新条目的热实例。写路径
  （`teamShare.ts` write）用它。`write()` 幂等：重复条目不追加、文件不变，刷新签名是无害同值写。
- `clearTeamShareCache()`：测试隔离 / 长进程手动失效。

**为何 `(mtimeMs, size)` 而非内容哈希**：黑板不是安全边界（与 #538 的信任门不同），失效判据
只需「内容可能变了就重读」。追加写必改 `size`，故同进程/跨进程的追加都被下次访问捕获；
`mtimeMs` 兜住罕见的「同长度改写」。statSync 失败（文件被删）退回 `{0,0}`，与「不存在」同
签名 ⇒ 下次重建为空黑板，与 `load()` 的 `!existsSync` 早返回一致。

**为何不用 `src/shared/ttl-cache.ts`**：TTL 是**时间**窗失效，窗内即使文件已变也返回旧实例——
黑板要求「内容变了下次访问即见」，时间窗会引入可见性延迟。statSync 失效是**精确**的，且
statSync 本身远比 `readFileSync`+逐行 `JSON.parse` 便宜（只读 inode 元数据）。

### ② **不**用 issue 备选的「`summary()` 从文件尾部反向扫到 10 个 key 即止」（方案 §2.3 第 2 条）

反向扫有两个实证隐患，都会无声破坏既有契约：

1. `load()` 除 `entries` 还要重建 `seenDedup` **全集**（`write()` 的 `(key, writer, toolCallId)`
   幂等依赖它）。提前停会让重放/重试重复落条目，破坏 `team-share.spec.ts:43` 的既有去重断言。
2. `summary()` 的键序是**首次出现序**（`team-share.ts:111-115` 的 Map 保序）。反向扫会翻成
   **末次出现序**——内容相同但注入成员 turn 0 的 prompt 文本次序漂移，属难察觉的行为变更。

实例缓存保持「整份重建」语义**不变**，只把「每次新建」降为「内容变了才新建」，两条契约都不碰。

### ③ 面板退休判定：`listRetiredSessionKeys()` 一次查回建 Set + 成员/任务按 teamId 分组一次

- `team-db.ts` 新增 `listRetiredSessionKeys(): Set<string>`（一条 `SELECT session_key FROM
  retired_members`）。`toMemberView` 签名由 `(db, member)` 改为 `(member, retired: Set<string>)`，
  内部 `retired.has(member.sessionKey)` 替代 `db.isRetired(...)`。两个调用方（`teamPanel.ts`、
  `teamStatus.ts`）各在映射前**一次**查回 Set ⇒ 退休判定 SQL 由 O(成员) 降为 1。
- `teamPanel.ts` 新增 `groupByTeam` 助手，把 `members`/`tasks` 各按 `teamId` 分组**一次**
  （`Map<teamId, row[]>`，保序：桶内顺序 = 原数组顺序，与逐队 `filter` 等价），替代 `teams.map`
  内对两份全量数组的逐队 `filter` ⇒ O(团队×成员) 降为 O(团队+成员)。
- **不改**面板快照的授权面行为（`presence.isActive` 仍逐队、T6 评审的刻意取舍）；`isRetired`
  单成员方法保留（scheduler / waker / scanner / 各 team 工具的单点判定仍在用，那些不是放大循环）。

## Alternatives considered

- **`summary()` 反向扫尾部取 10 key（issue 备选）** — **否决**。见 Decision ②：破坏 `seenDedup`
  幂等全集与 `summary()` 首次出现键序两条既有契约。
- **TTL 缓存（`src/shared/ttl-cache.ts`）** — 落选。见 Decision ①：时间窗失效引入可见性延迟，
  不如 statSync 精确。
- **内容哈希失效（如 #538 信任门）** — 落选。黑板非安全边界，算内容哈希就把「省掉的 readFileSync」
  又花回去了，得不偿失；`(mtimeMs, size)` 足够。
- **给 `TeamShare` 内部加缓存（而非外层工厂）** — 落选。缓存是「按路径复用实例」，属构造层职责；
  放进类内会让每个实例自持一份全局缓存，语义混乱。外层工厂 `getTeamShare` 单点持有 Map 更清晰，
  且既有 `new TeamShare(path)` 直接构造的测试/用法不受影响。
- **`toMemberView` 保留 `db` 形参、内部改调 `listRetiredSessionKeys`** — 否决。那样每个成员仍触发
  一次全表查询（比 `isRetired` 更糟）。必须由调用方一次查回、传 Set 进映射。

## Consequences

- **正向**：① 同一路径连续派发/读取 ⇒ `load()` 只跑一次（缓存命中，实例复用）；写后读命中热实例。
  ② 面板快照退休判定 SQL 由 O(成员) 降为 1；成员/任务分组由 O(团队×成员) 降为 O(团队+成员)。
- **行为边界（刻意）**：黑板「整份重建」语义不变——`seenDedup` 幂等全集与 `summary()` 首次出现
  键序逐字保持。面板授权面（在线态判定）不变。`isRetired` 单点判定方法保留。
- **内存**：实例缓存每个团队路径持一个 `TeamShare`（条目随黑板自然增长，与文件同阶），团队数有界；
  跨进程变更由下次 statSync 失配捕获，不会长期钉死陈旧实例。
- **护栏（测试，node --test）**：
  - `tests/agent/team/storage/team-share.spec.ts` 新增 4 例：`(mtime,size)` 未变 → 同一实例
    （引用相等，**内建负控制**：退回每次 new 则红）；size 变化 → 失效重建读回新内容；
    `writeTeamShare` 写后刷新签名 → 后续读命中热实例且键序首次出现序；去重写入不改文件 → size 不增。
  - `tests/gateway/teamPanel.spec.ts` 新增 1 例：3 成员 + 1 退休，spy 计数断言
    `listRetiredSessionKeys` 调 1 次、`isRetired` 调 **0** 次（**负控制**：改回逐成员一查则 = 3 > 0 红），
    且退休态判定正确（m2 `retired:true`、m1/m3 `false`——证明是「少查且查对」而非「漏查」）。
  - 回归：team-share / teamPanel / team-db / teamStatus 四 spec 共 25 例全绿。
- **门禁联动**：`team_share_updated` 发出点由 `teamShare.ts:114` 移至 `:115`（写路径改
  `writeTeamShare` + 注释）⇒ 已 `pnpm gen:event-matrix` 回填。行数变动跑 `pnpm measure:update`
  （src TS 181193 → 181303；无注释无参 catch 棘轮维持 15——新增的 `statSignature` catch 带意图注释，
  计入「已带注释」）。不触协议版本（无 gateway method/result 形状变更）、不触 i18n、不触 llm-replay
  （未改任何工具 `inputSchema`）。

## 相关

- 议题：`#531`（`TD-TEAM-N09` + `TD-TEAM-N10(a)`）。
- 代码：`src/agent/team/storage/team-share.ts`（`getTeamShare`/`writeTeamShare`/`clearTeamShareCache`
  + `statSignature`）· `src/agent/team/index.ts`（导出）· `src/tool/builtin/team/teamShare.ts`（写/读
  两生产点）· `src/cli/teamSubsystem.ts`（`readSharedBoardSummary`）· `src/agent/team/storage/team-db.ts`
  （`listRetiredSessionKeys`）· `src/agent/team/views.ts`（`toMemberView` 签名）·
  `src/gateway/teamPanel.ts`（`groupByTeam` + 退休集一次查回）· `src/tool/builtin/team/teamStatus.ts`（调用方）。
- 证据点：`scheduler.ts:253`（派发路径调 `readSharedBoardSummary`）· `team-share.ts:111-115`（summary
  首次出现键序）/`:138-160`（load 重建 seenDedup 全集）· `team-db.ts:418-423`（isRetired 单查）。
- 方案：`docs/open-issues-remediation-plan.md` §3.7 · §2.3 第 2 条（反向扫的两个实证隐患）。
