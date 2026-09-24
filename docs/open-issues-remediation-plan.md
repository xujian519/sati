# 全部开放议题解决方案（14 条技术债 · 2026-09-24 基线）

> **验收状态：⏳ 待实施**（本文件是**实施方案**，不是完成报告。每个批次落地后回来勾选、补实测数字与 PR/commit）。
>
> **覆盖范围**：GitHub 仓库 `xujian519/sati` **全部开放议题 14 条**（#520、#527–#538、#541）——截至 2026-09-24 03:11 CST 用 `gh issue list --state open` 核实为 14 条，无遗漏、无新增。另有 99 条已关闭议题不在本方案范围（终态由关闭表达）。
>
> **基线**：`main` `2e64d987f`（`release/v0.3.2`，2026-09-24）。本方案的全部行号与数字均在该提交上实测；引用 issue 原文的数字时标注「issue 声称」。
>
> **来源**：14 条中 **13 条**由 **2026-09-23 全仓技术债扫描**（Brooks-Lint Tech Debt Assessment，基线 `5cba87d2a`）产出，报告存档 `docs/technical-debt/audit-report-2026-09-23.md`，账本登记见 `docs/technical-debt/backlog.md` §37。该轮共 **20 条**（#527–#546），其中 **7 条**（#539 · #540 · #542 · #543 · #544 · #545 · #546）已在 2026-09-23–24 交付并关闭（PR #549–#556）；剩余 **13 条**（#527–#538 · #541）即本方案 P1–P9 的主体。
>
> 第 14 条 **[#520](https://github.com/xujian519/sati/issues/520) 创建于 09-22，早于该轮扫描**，因此**未进账本 §37、在账本中没有任何载体**——这是本方案发现的一处真实缺口（见 §0.3 第 4 条）。
>
> **定位**：接力 `docs/technical-debt/next-batches-schedule.md`（2026-08-23，已声明被取代）的「专项排期」角色，是这 14 条的唯一执行方案。治理规则见 `docs/issue-management.md`，代码门禁见 `docs/development-standards.md`。

---

## 0. 结论速览

### 0.1 核实结论

**14 条议题全部「仍成立」**——逐条回到代码核实（方法见 §2），无一条已被 2026-09-23–24 的后续提交顺带修掉；关键数字 5 天内一字未动（`+136` 行、catch `12`）。

**但 issue 原文不能照抄执行**：核实出 **9 处「备注修法」需要修正**，其中 **3 条照做会引入回归**（#537「只落增量」已被决策记录否决；#531 的「反向扫尾部」会破坏幂等全集与 prompt 键序；#536 的 abort 若落 vendored 子包则越界且牵动子包 build），另 **6 处是做无用功或不可行**（#527(b)/#530(b) 的「告警型门禁」在本仓等同无效、#533 层② 实为跨端重构、#535(b) 是伪优化、#541(b)(c) 触发条件未满足/收益为 0、#528 的全量回填实为 25–50h）。**这是本方案相对 issue 原文的主要增量**，逐条见 §2.3。

**另有三处 issue 的事实性错误已更正**：#528 的「8 条下界」含 **3 条误报**（真实下界 5 条）；#541 的 barrel 数字应为「196 个导出 / 84 个零消费」（issue 写 225/92）；**#520 在债务账本中没有任何载体**（见 §0.3 第 4 条）。

### 0.2 交付批次（9 个批次 / 9 个 PR）

排序原则有三条，按优先级依次适用：

1. **先修「门禁撒谎」**——门禁与账本是所有后续排期的信号源，它们的失真会污染每一个下游判断（审计报告 §Recommended focus 第 2 条：门禁型两条「杠杆最高」）；
2. **先算对，再拦住变差**——棘轮（P2）把「当前值」冻结成上限，若基线本身是错的（#530 漏算 5 处、#520 把 218 个非本仓文件算进模块规模），先上棘轮等于**把错误永久合法化**。这是 P1/P2 必须分开且有序的根本原因（#530 因此**跨两个批次**：P1 修口径、P2 加棘轮）；
3. **同批聚合「同域同门禁」**——同一批生成物（`metrics.md` / `architecture-baseline.json` / `docs/code-facts.md`）若被拆到多个 PR，每次都要 `pnpm measure:update` + `pnpm gen:doc-claims`，合并可省多次刷新与 CI 往返。

| 批次 | 议题 | 主题 | 工作量 | 门禁成本 | 顺序 |
|---|---|---|---|---|---|
| **P1** | #520 · #530（口径） | 度量口径对齐（**先算对**） | M | `gen:doc-claims` + `measure:update` + 2 个门禁自测 | 1 |
| **P2** | #527 · #530（棘轮） | 门禁棘轮化（**再拦住变差**） | M | 一次性重刷基线 + `measure:update` + 2 个门禁自测 | 2 |
| **P3** | #536 | 记忆检索不再阻塞首 token | M | `measure:update` | 3 |
| **P4** | #537 | 账本快照不再二次增长 | L | `measure:update` | 4 |
| **P5** | #533（层①）· #534 · #529 | `ui/server` 资源与延迟收敛 | M | `measure:update` | 5 |
| **P6** | #538 · #532 | 信任门与工具注册契约 | L | `measure:update` + `check:i18n-namespaces` | 6 |
| **P7** | #531 | 团队热路径读放大 | M | `gen:event-matrix`（若行位移）+ `measure:update` | 7 |
| **P8** | #535 · #541 | 微优化与去重 | S–M | `measure:update` | 8 |
| **P9** | #528 | 账本回填与议题收尾 | S/M（+ 后续项） | `measure:update` | 9 |

工作量口径沿用 `docs/technical-debt/README.md`：**S ≤ 半天 · M 1–2 天 · L > 2 天**。合计约 **6–9 个工作日**（P4/P6 是 L）。

**工作量相对 issue 暗示的三处修正**：#532 由 S 升 **M**（三处同批 + 严重级异议，见 §3.6）、#538 由 M 升 **L**（1 天+）、#533 的层②**移出本方案**（跨端重构，拆独立议题，见 §2.3 第 4 条）。

### 0.3 四条关键判断

1. **P9 必须排在最后**——#528 要按「issue 关闭结论 + 代码证据」回填账本；若先做回填，P1–P8 落地后同一批条目会**第二次滞后**，正好复现该 issue 要治的形态（`docs/issue-management.md` §6.1 的「交付即回填」原则）。

2. **P1 与 P2 必须拆开且有序：先算对，再拦住变差。** #527 的触发条件**已经满足**（本方案实测：41 条 `file-size` 豁免中 6 条超基线记录值、合计 **+136 行**，最大一条 +73 行，远超 issue 自设的「+50 行即立项」线）；但若在 #530 的口径盲区（漏算 5 处）修正**之前**就上棘轮，棘轮会以错误的 12 为上限——等于把漏算永久合法化。⇒ P1 修口径（#520 + #530 口径）、P2 加棘轮（#527 + #530 棘轮）。

3. **#532 的定级被低估，且它不是「未来的防护」而是「今天的缺陷」。** issue 自述「失去的是一道防护而非现存缺陷」，但实测显示**项目级共享 MCP 工具今天就已经被静默吞掉**（`ProjectRuntimeRegistry.ts:438` 用无 `outputSchema` 的定义注册 → 严格表抛 → `:447` 的 `catch` 降为 warn，工具消失且只留一行 warn）。⇒ 建议分诊时把 #532 与 `TD-TOOL-002` 上调 P2，并把「共享 MCP 工具数量不减少」写成回归断言（详见 §3.6）。

4. **有一处真实缺口需要顺手补**——**#520 在债务账本中没有任何载体**（`grep "#520" docs/technical-debt/backlog.md` 零命中；账本中也不存在任何 `doc-claims`/`code-facts` 相关条目）。它不是 2026-09-23 扫描的产物（创建于 09-22），因此既没进 §37.1 的新立 8 条，也没进 §37.3 的复核更新。P9 回填时应为它补一条载体（`TD-PROCGATE-010` 或按当时编号），否则「账本是唯一事实源」在该条目上不成立。

---

## 1. 议题全景与账本载体

### 1.1 14 条议题一览（含账本映射）

| # | 标题（缩写） | P | scope | 账本载体 | 批次 |
|---|---|---|---|---|---|
| [520](https://github.com/xujian519/sati/issues/520) | `check:doc-claims` 模块文件数把 `node_modules`/编译产物算作源码 | P2 | other(scripts) | **⚠️ 无载体** | P1 |
| [527](https://github.com/xujian519/sati/issues/527) | 架构边界门禁 `file-size` 豁免只匹配文件名 | P2 | other(scripts) | `TD-PROCGATE-008` | P2 |
| [530](https://github.com/xujian519/sati/issues/530) | 无注释无参 catch 零基线被侵蚀（0→12）、无棘轮 | P3 | other(scripts) | `TD-CATCH-001` 残留 | **P1 + P2**（拆两段） |
| [536](https://github.com/xujian519/sati/issues/536) | 记忆检索阻塞每轮请求（最坏 30s）、abort 未透传 | P2 | memory | `TD-CONTEXT-N03` | P3 |
| [537](https://github.com/xujian519/sati/issues/537) | 工作区账本每笔写入落全量快照（撞 50MB 硬顶） | P2 | agent | `TD-SESSION-N02` | P4 |
| [533](https://github.com/xujian519/sati/issues/533) | 文件树 API 急切遍历整棵树（5.9 万节点/663ms） | P2 | ui | `TD-UISERVER-N11` + `TD-UI-APP-N06` | P5（**层①**） |
| [534](https://github.com/xujian519/sati/issues/534) | git `/commits` 逐 commit 串行 spawn | P3 | ui | `TD-UISERVER-N04` | P5 |
| [529](https://github.com/xujian519/sati/issues/529) | `sati-bridge.js` 4 张 per-session 缓存无上限 | P3 | ui | `TD-UISERVER-N02` 残留 | P5 |
| [538](https://github.com/xujian519/sati/issues/538) | 插件信任门整树哈希无缓存 + 2000 文件上限死角 | P2 | other | `TD-EXTENSION-N07` | P6 |
| [532](https://github.com/xujian519/sati/issues/532) | `ToolRegistry.clone()` 丢 `outputSchema` 严格位 | P3 **→ 建议 P2** ⚠️ | tool | `TD-TOOL-002` | P6 |
| [531](https://github.com/xujian519/sati/issues/531) | 团队编排热路径读放大（TeamShare 全量读 + 面板 O(n²)） | P2 | agent/ui/gateway | `TD-TEAM-N09` + `TD-TEAM-N10(a)` | P7 |
| [535](https://github.com/xujian519/sati/issues/535) | `cloneMessage` 走 JSON 深拷贝 + active-turn 多次序列化 | P3 | gateway | `TD-WEB-N01` + `TD-GATEWAY-003` | P8 |
| [541](https://github.com/xujian519/sati/issues/541) | 两个持久层同构手抄 + `lookup()` 零消费误导注释 | P3 | other | `TD-EXTENSION-N08` | P8 |
| [528](https://github.com/xujian519/sati/issues/528) | 账本条目状态与影响描述未随代码回填 | P2 | other | `TD-PROCGATE-009` | P9 |

**优先级分布**：P2 × 8 条 · P3 × 6 条 · **无 P0/P1**。这是本批与 2026-09-23 扫描前 6 条（两条 P1 `bug`：#542/#543）的关键区别——14 条都不阻塞合入，可以按批次推进而不需抢占式插队。

> ⚠️ **一条定级异议**：#532 自称 P3（「失去的是一道防护而非现存缺陷」），但实测**项目级共享 MCP 工具今天已被静默吞掉**（`ProjectRuntimeRegistry.ts:438` 注册无 `outputSchema` 的定义 → 严格表抛 → `:447` 的 `catch` 降为 warn，该工具静默消失）。⇒ 这是**现存功能缺陷**，建议分诊时把 `TD-TOOL-002` 与 #532 一并上调至 **P2**（详见 §3.6）。

### 1.2 前置议题的承接关系（避免重复设计）

| 上游（已关闭） | 与本批的关系 | 约束 |
|---|---|---|
| #353（catch 清零，PR #432/#433） | #530 是它的**护栏缺失** | 已按「失败模式 → 回退语义」注释体例清零一次，本次不重做清零（12 处经逐处核验**均非真隐患**） |
| #413（bridge 记账 Map 无上限，PR #425） | #529 是它的**残留半** | 已建立 `MAX_ACTIVE_SESSIONS = 500` + 逐出的先例，新修应同构复用而非另立模式 |
| #364（账本读失败被静默掩盖，PR #378） | #537 是它的**写侧** | PR #378 明确把「只落增量」列为待设计：本方案 §3.3 给出在既有决策面内的方向 |
| #344（账本读侧游标增量） | #537 的**前提** | 游标缓存依赖「快照按顺序追加」，故写侧改格式必须保序、保自足 |
| #341（度量口径：vendored 子包移出文件级指标，PR #390） | #520 的**同族先例** | 该先例明确了「`lib/` 是编译产物、应按目录名豁免」的口径，#520 的现状与之矛盾 |
| #356（`ui/server` 候选清单） | #529/#533/#534 的**母清单** | 本批三条是该清单中经代码复核后仍成立的部分 |

### 1.3 时机与治理风险：14 条都将在 2027-01 被自动关闭

14 条全部 `status: triage`、**无 milestone**、优先级 P2/P3。按 `.github/workflows/stale.yml` 现规则：

- `exempt-issue-labels` 只含 `status: in-progress`/`status: blocked`/`good first issue`/`help wanted`/`pinned`/**`priority: p0`/`priority: p1`**；
- `exempt-all-milestones: true`。

⇒ 这 14 条**不在任何豁免面内**：90 天无活动（约 2026-12-21）标 `stale`，再 30 天（约 2027-01-20）自动关闭。任一评论会摘掉 `stale`，所以推进本身即豁免；但**若计划跨年，必须显式挂 milestone 或改状态**，否则会被静默归档。审计报告 §备注已就此给出同样提示。

**本方案的建议（P1 落地时修正）**：**按批次启动时逐条**把该批议题改 `status: in-progress`（分诊 §3 的「推进」动作）。~~执行 P1 时把 14 条一并改 in-progress~~——原建议已否决：批次计划在 6–9 个工作日内推进完，无需为豁免 stale 而把未开工的议题标成「进行中」（那本身就是状态失真，见 §9 的「实施修正」）。

---

## 2. 现状核实

### 2.1 方法与证据标准

在基线 `2e64d987f` 上，对 14 条逐条执行：

1. `gh issue view <n>` 取 issue 正文（含其「位置 / 最小示例」「备注：修复方向」）；
2. 打开 issue 给出的每个 `file:line` 逐条对照当前代码；
3. 对 issue 声称的**性能/规模数字**重跑其只读复现命令（不采信转述）；
4. `git log 5cba87d2a..HEAD -- <证据文件>` 判断该文件是否在扫描基线后被动过（有提交则逐个看是否顺带修掉）；
5. 测试覆盖用 `grep`/读测试文件核实，不采信 issue 的「零覆盖」断言。

**结论分档**：① 仍成立；② 部分成立（哪些点变了）；③ 已失效（被谁修掉）。

### 2.2 逐条核实结论

**14 条全部 ①仍成立**。核实由 5 组并行只读代理完成，此处只列**与 issue 原文有差异**的部分——issue 未提的行号、数字与判断才是本方案的价值所在；与 issue 一致的内容不重复。

| # | 行号/数字漂移 | 实测复现（本机，热缓存） | issue 未提的关键事实 |
|---|---|---|---|
| 520 | `srcModuleList` 实际在 `resolvers.ts:127`（issue 未给行号）；「315」已定格 **316** | `src/context` = **316**（= `docs/code-facts.md:55` 入库值，门禁当前**绿**）；`git ls-files src/context \| grep -E '\.tsx?$'` = **98**；差 218 全为 `node_modules` 182 + `.d.ts`（子包 `lib/**` 36） | **污染仅 `src/context` 一个模块**（内嵌 vendored 子包），另 30 个模块的现算值与 git 计数相等 ⇒ 该事实的失真面比「全部模块都可能漂」小得多；`filesWithSuffix` 另两处调用（`:262`/`:269`，SKILL.md 统计）不受影响 |
| 527 | 无漂移 | 41 条 `file-size` 豁免中 **6 条超基线、合计 +136 行**，与 issue 逐字一致（`types.ts` 911→984 · `InProcessGateway.ts` 1489→1518 · `useChatRealtimeHandlers.ts` 1005→1025 · `sati.ts` 1028→1035 · `useSessionStore.ts` 1347→1352 · `AppShellV2.tsx` 893→895） | 基线文件全历史仅 `4a4ddef6e` 一次提交、**从未刷新** ⇒「`--update-baseline` 静默追认增长」不是推断而是已发生（+136 就是历次刷新的累积） |
| 530 | 无漂移（12 处位置与 issue 表格逐行一致） | `catchNoParam {total: 671, documented: 659, undocumented: **12**}`；四笔引入 commit 对 #353 清零提交 `a11e2b986` 均 `is-ancestor` ⇒ **0 处遗漏** | **真实值 17 而非 12**：两处口径盲区已复现——`uiSrcFiles`（`:540`）只收 `.ts/.tsx` 而 `ui/src` 有 9 个 `.js/.jsx`；`EXCLUDE_DIRS`（`:27-39`）含 `lib` 且按**任意层级目录名**豁免，吞掉 `ui/src/lib/` 的 4 个 ts/tsx。手扫这 5 个文件得 5 处 |
| 528 | 账本 `backlog.md` 2244 行 / `^- \*\*TD-` **304 条**；issue 说的「§1–§32」实际等于全部（§33–§35 是清单/排期，无债务条目） | 状态分布（宽口径）：**new 221 · done 71 · partial 3 · in_progress 2 · wontfix 1 · triaged 1 · 未识别 5**；条目级「最后复核」实测 **0 条** | **issue 的「8 条下界」含 3 条误报**：`TD-SESSION-N01`、`TD-ROUTER-001/002` 在扫描基线 `5cba87d2a` 时刻账本**已是 `done`**（回填提交 `b3cf9ef4e`/`f114373f7` 早于基线 7 天）⇒ 真实下界 **5 条**，`backlog.md:2225` 的「仍标 `new`」表述对 3 条不成立。**且 221 条 `new` 中有 206 条不挂 issue 号** ⇒「按 issue 关闭结论回填」无法收敛候选 |
| 531 | `load()` 实为 `:138-161`（issue 写 `:138-160`，文件共 161 行） | `new TeamShare(` 三生产点 `teamShare.ts:112`/`:189`/`teamSubsystem.ts:166`；面板 `constants.ts:4` = 10_000ms | scheduler **不构造** TeamShare（经 `readSharedBoardSummary` 注入），issue 的「调度器接线」易被读成直接构造 |
| 533 | 跳过表在 `filesystem.js:305-316`（issue 写 302-318） | 全树 **59,297 节点 / 621ms**（issue 59,287/663ms）；`.pnpm-store` **52,639 = 88.8%**；**跳过它只剩 6,658 节点 / 67ms** | `showHidden` 是**死参**（`:294` 声明、仅 `:351` 递归传递，函数体从不读）⇒ `project-files.js:76` 注释「不含隐藏」不实；`ui/server/**` 对 `getFileTree` **零覆盖** |
| 534 | 零漂移（`:823-834` 串行循环逐字一致） | 10×`git show --stat` **130ms**（issue 112ms）vs 单次 `git log --stat -n10` **17ms**；`-n100` 串行 **1,140ms** vs 单次 **43ms** | **merge commit 的 `--stat` 段完全缺失且其后无空行** ⇒ 合并解析必须按 header 正则切块，不能按空行分块（否则下一提交的 stat 会串到 merge 上） |
| 535 | `activeTurnProjectionPayload` 在 `:853-868`（issue 写 855-868） | `clone.ts` 版 vs JSON 版语义对照已完成（见 §2.3） | `structuredClone` 保留 `undefined`/`Date`/`BigInt`/`Map`、循环引用可处理、遇函数抛 `DOMException`——而 transcript 是 JSON 产物 ⇒ 换实现**无回归面** |
| 536 | provider `signal` 声明实为 `EdgeClawMemoryProvider.ts:54`（issue 写 `:41-49`）；memory-core `retrieve` 实为 `service.ts:719-728`（issue 写 `:730-737`） | `grep -rn "AbortSignal" memory-core/src` = **0**（39 条 signal 命中全是业务语义 `focusSignals`） | issue 的「内层 45s×3」数字对不上：`llm-prompts.ts` 最大的是 `DREAM_FILE_PROJECT_REWRITE_TIMEOUT_MS = 300_000`；测试 `memory-attachment-builder.spec.ts` 166 行 15 条**零超时用例**（issue 说法准确） |
| 537 | 超限判定实为 `TranscriptReader.ts:176` **与 `:511` 两处**（issue 只写 `:176-185`） | 逐条行号全中（`JsonlTranscriptWriter.ts:267-273`、`WorkspaceLedgerStore.ts:66/79/81/93` 等） | `TaskResumeScanner` **不读账本**（grep 零命中）⇒「新会话冷读」与「resume 冷读」在 Store 层**等价**（都是游标 undefined 从 0 全扫），验证口径可合并 |
| 541 | `HookTrustStore.ts:27-104`（104 行）、`store.ts:31-167`（167 行）；两段 `diff` 实测 **172 行** | barrel 实测**导出 196 名**（issue 写 225）、**模块外零消费 84**（issue 写 92）——但 issue 点名的 6 个常量**全部零命中 ✓** | 「解析期热路径」注释**只有一处**：`store.ts:134` 有该字样，`HookTrustStore.ts:77` 只是「单条查询。」⇒ issue 的一句话债务把两处混述；测试调用者比 issue 多一处（`tests/cli/hook-trust-service.spec.ts:79`） |
| 529 | 无漂移（`:1438/1524/1640/1724` 全中）；**账本侧** `backlog.md:1321` 仍写 `:1237/1319/1435/1529`，与 HEAD 差约 200 行 | 四张缓存只增不减已确认；对照 `MAX_ACTIVE_SESSIONS = 500`（`:95`）与逐出（`:361-370`） | **「按会话删除」方向错**：这 4 张的唯一调用方是 `getRouterDashboardData()`（`:1923` ← `routes/system.js:93`），`sessionId` 取自落盘 router stats 的**历史会话** ⇒ 不存在「会话结束」钩子（`cleanupSessionBookkeeping:270` 只清另三张）；标题缓存更无 mtime 校验 |
| 532 | 无漂移（`ToolRegistry.ts:110`、`filterAvailableTools.ts:19`、`sessionToolSurface.ts:83/109/124/136/157`、`PluginToToolBridge.ts:58-91`） | 运行时实测（只读）：严格表 `register(MCP def)` **抛**，`clone().register` **不抛** ⇒ 严格位归零确证 | **三点 issue 漏记**：① 第四处同类 `SubAgentSession.ts:173`（子代理面同样无校验）；② **项目级共享 MCP 今天已被静默吞**（`:438`→`:447` 降 warn）；③ 天真透传在 `sessionToolSurface.ts:88`（`try/catch` 内）是**静默全丢**，只有 `filterAvailableTools.ts:26` 无 catch 才硬抛。另：MCP 结果形状**不可声明**（`operations.ts:46 content: unknown`，`structuredContent` 被丢弃）⇒ 宽松 schema 只能恒真 |
| 538 | 无漂移（`evaluateHookTrust.ts:55` 实名 `evaluateProjectHookTrust`、`hookBundleDigest.ts:50-67`、上限 `:19-20`、`hookTrustService.ts:119-121`） | 复算 **166–189ms/次**，重复评估无加速 | memo 的失效键可用 walk **既有 stat** 产出 `sha256(rel+size+mtimeMs)`；现有 `hook-trust-report.spec.ts:72-92` 只测「mtime 变 / 内容变」两种 ⇒ **必须补「内容变但 mtime 回填」**，否则 memo 会无声弱化信任判据。「clone 安装的插件是常态」**无本仓证据**（`src/extension/` 无插件 install 通道） |

**工作量修正（相对 issue 的暗示）**：

| # | issue 暗示 | 实测工作量 | 差在哪 |
|---|---|---|---|
| 528 | 「批量回填一次」 | **回填已核实的 5 条 + 4 条描述 = S/M（2–4h）**；但「逐条回填 §1–§32 状态滞后条目」= **L 上界，接近 XL（25–50h）** | 221 条 `new` 中 206 条不挂 issue 号 ⇒ 判据只剩「逐条读代码」，单条 5–15 min（本次 9 条核实用了约 25 次工具调用） |
| 533 | 三层修法并列 | 层① **S**（<1h）；层②实为**跨端重构 L+**（应拆独立 issue，见 §2.3） | UI 侧零懒加载、@ 提及共用同一深树、仓内无 children 路由 |
| 534 | P3 顺手 | **M（半天）** | 唯一的难点是 merge commit 的 `--stat` 边界（§2.3 第 6 条） |
| 541 | 三件事并列 | ②删 `lookup()` **S**；①抽共享层 **M**；③barrel 收敛 **M/L 且收益 0** | 172 行 diff 且两实体语义差异大（`store.ts` 另有 `forget`/`pickSmaller`/`mergeModelWindowEntry`） |

### 2.3 议题「备注」中不可直做的修法（照做会引入回归或做无用功）

以下 9 条是**本方案与 issue 原文唯一实质冲突**的地方。每条都给出证据，来自逐条核实或既有决策记录：

1. **#537 的「只落增量」是已评审落选方案——不能做。**
   `docs/notes/implemented/2026-09-15-workspace-ledger-read-path.md`（PR #378，已合并）「Unresolved risks」原文：游标缓存**依赖**「快照按顺序追加」这一前提，「改成只落增量会让 transcript 失去『单条即可重建』的自恢复性，且要同时定义重放语义」；同文 Alternatives 段把「反向扫文件尾部找最后一条 `workspace_state`」列为**已落选**（会牵动 `TranscriptReader` 的半行字节 / 头部指纹 / sequence 守卫三条增量状态机）。
   ⇒ 在既有决策面内的唯一方向：**保持每条快照自足 + 按 change token 跳过无变化写入 + 周期性全量锚点**，且不动 durable 边界（`recordEntry` 仍走 pending 批写，`flushCheckpoint` 语义不变）。

2. **#531(a) 的「`summary()` 从文件尾部反向扫到 10 个 key 即止」有两个实证隐患。**
   ① `TeamShare.load()`（`team-share.ts:138-161`）除 `entries` 还要重建 `seenDedup` 全集，提前停会让 `write()` 的 `(key, writer, toolCallId)` 幂等失效（重放/retry 重复落条目，破坏 `tests/agent/team/storage/team-share.spec.ts:43` 的既有断言）；② `summary()` 的键序是「**首次出现序**」（`team-share.ts:111-115`），反向扫会翻成「末次出现序」——内容相同但**注入成员 turn 0 的 prompt 文本次序漂移**。
   ⇒ 改为模块级 `Map<path, {mtimeMs, size, inst}>` + `statSync` 失效（语义与今天逐字一致），可复用仓内 `src/shared/ttl-cache.ts`。

3. **#536 的 abort 透传不能做在 vendored 子包内。**
   memory-core 是**独立 pnpm workspace 包**（`pnpm-workspace.yaml`），自带 `package.json` 的 build/typecheck/test，`docs/technical-debt/metrics.md` 明文将其列为「vendored 子包，整体移出文件级指标……**不随本仓演进**」；且它的 `AbortSignal` 计数为 0、签名无 signal 形参。
   ⇒ 修法落在**仓内适配层** `src/context/memory/EdgeClawMemoryProvider.ts`（对外竞速后丢弃内层结果）。同时「非阻塞化」应选**后台检索 + 下一轮注入**——`DefaultContextRuntime.ts:214-247` 已把检索提前并行，真正代价只是那个 `await`；「到期即有则注入」需给检索加预算，会与 provider 30s TTL 缓存打架。

4. **#533 的层②（首屏改 `maxDepth=1` 懒加载）不是「同文件已有形态」的一行改动。**
   `api.getFiles`（`ui/src/utils/api.js:415`）有**两个**消费者：`useFileTreeData.ts:46`（FilesV2）与 `useFileMentions.tsx:97`（@ 提及，`flattenFileTree:36-42` 递归 children）；`FilesV2.tsx:100-104` 的 `flatten()` 只在 `node.children` **已到达**时展开，**无按需请求**，仓内无 children 路由（grep 仅命中注释）。
   ⇒ 本方案**只做层①**（跳过表补 `.pnpm-store`，1 行换 88.8% 节点与 89% 时间，且这才是 issue 定义的债务本身）；层②作为**新登记的独立议题**（跨端改造：新增 children 路由 + 两处客户端改造）。
   （层③「串行 stat 改并发」在层①之后收益 <60ms 且 fd 压力上升，**不做**。）

5. **#541 的「抽共享基类」当前不值得，「barrel 收敛」收益为 0。**
   两段 diff 实测 172 行、两实体语义差异大（`store.ts` 另有 `forget`/`pickSmaller`/`mergeModelWindowEntry`，`record()` 返回语义不同），而 issue 自设的触发条件是「下次改动这两个 store 之一，或需要新增第三个」——**今天不满足**。
   ⇒ `lookup()` 按 issue 的第二个选项处理，但**删除优于改注释**（零生产调用者 + 每次调用整表 `readFileSync`+parse，删除同时消灭死代码与「照注释接线」的诱导面）；barrel 收敛**不做**（公开面变更须决策记录，收益为 0）。

6. **#535(b) 是伪优化——只该更正登记文字，不该动代码。**
   `cloneGatewayEvent`（`structuredClone`）+ 两次 stringify ≈ 1.1 µs/事件，2000 个 delta 累计约 2.3 ms CPU；issue 自己也指出真实成本中心在**投影的全文累积**（`InProcessGateway.ts:1307` 的 `block.text += event.text`）与**快照整段复制**（`activeTurnProjectionPayload`，`:853-868`）。
   ⇒ 代码不动，只更正 `backlog.md` 的 `TD-GATEWAY-003` 登记（删「可能无人读」、行号改 `:1268-1283`）。(a) 的一行替换**可安全做**（语义差异已核实：`metadata`/`block.raw` 转共享引用、`content: undefined → []`，后者已有测试锚定 `tests/model/request/malformedMessages.spec.ts:29-33`，且 `src/web/server/` 无写回路径）。

7. **#527 的 (b)「仅告警不阻塞」应否决。**
   本仓门禁一律 `exit 1`，CI 里的 warning 等同于无效——`TD-PROCGATE-001`（PR 门禁被模板注释恒真通过）就是同型失败。取 (a) 棘轮。

8. **#530 的 (b)「升级为 eslint 规则」不可行。**
   `eslint.config.mjs`（202 行）连 `no-empty` 都没有，「catch 邻域必须带意图注释」这类判据 eslint 表达不了；且两处口径盲区不修则 eslint 同样扫不到。取 (a) 棘轮。

9. **#528 的「逐条回填全部条目」不能作为一次性验收项。**
   221 条 `new` 中 206 条不挂 issue 号，「按 issue 关闭结论回填」的判据对它们不适用。⇒ 方案改为：**先回填已核实的 5 条 + 4 条描述（S/M，本批闭掉 #528）**，另加**两条已验证可行的机械化判据**（见 §3.9），把「全量回填」拆成可分批推进的后续项而非本次验收条件。

> **口径敏感的实证（本方案自证）**：核实 #528 时，两套独立实现（代理的宽口径 vs 本方案作者的第一版窄口径）对同一份 `backlog.md` 得出**终态条目 71 条 vs 20 条**（差 3.5 倍）、**无证据引用 22 条 vs 6 条**。差异来源是状态字段写法至少有 5 种变体（`状态：done` · `状态：**done（2026-09-11）**` · `**状态：done（#384）**` · `状态：partial` · 4 处完全无该字段）。
> ⇒ 这是一条**必须写进方案的约束**：若要把 backlog 判据做成门禁，**第一步只能是报告型（`--warn`）且必须先钉死三件事**——条目块边界定义、状态字段识别（含加粗/括号变体）、证据引用形态白名单；否则门禁会给出一个随实现漂移的数字，比没有门禁更糟。

---

## 3. 批次方案

> 每个**批次 = 一个分支 + 一个 PR**（`main` 受保护）。每批次给：现状（实测）→ 修法（到文件与函数）→ 验收（可观测判据）→ 测试（新增用例 + 负控制）→ 门禁联动 → 决策记录 → 工作量。
>
> **批次拆分依据只有两条**：① 是否共享生成物与门禁（共享则合并，否则独立）；② 是否存在必须串行的依赖（见 §4.1）。除此之外一条一 PR，不做「大 PR 全修」。

### 3.1 P1 · 度量口径对齐（#520 + #530 的口径部分）

**为什么先做**：棘轮（P2）把「当前值」冻结成上限。若基线本身就是错的（#530 的 12 漏了 5 处、#520 的 316 里 218 不是本仓源码），先上棘轮等于**把错误永久合法化**。所以顺序是「先算对，再拦住变差」。

| 项 | 内容 |
|---|---|
| **#520 修法** | `scripts/doc-claims/resolvers.ts`：新增 `gitListedFiles(root, suffixes)`（复用 `scripts/measure-techdebt.mjs:150-161` 的同源实现 `git ls-files --cached --others --exclude-standard`，`cwd: REPO_ROOT`，兼容 `:29-38` 的 tsx/dist 双加载面）；`srcModuleList()`（`:127`）改调它；`filesWithSuffix` 保留给 SKILL.md 统计（`:262`/`:269`）。**注意**：git 口径含「未跟踪但未忽略」的文件 ⇒ 新增未 `git add` 的 `.ts` 会即时改数（与 `measure-techdebt` 一致，须写进决策记录）。 |
| **#530 口径修法** | `scripts/measure-techdebt.mjs`：① `uiSrcFiles`（`:540`）后缀集合补 `.js/.jsx`（`ui/src` 实有 9 个）；② `EXCLUDE_DIRS`（`:27-39`）的 `lib` 由「任意层级目录名豁免」改为**路径限定豁免**（只豁免编译产物路径，不再吞掉源码目录 `ui/src/lib/`）。 |
| **验收（可观测）** | ① `docs/code-facts.md` 的 `src/context` 行由 **316 → 98**，且在任何环境复算得**同一值**（干净检出 / 已装依赖 / 子包已 build 三态一致）；② `node scripts/measure-techdebt.mjs --json` 的 `catchNoParam.undocumented` 由 **12 → 17**，`total` 671 → 679，且 5 处新计入的位置与 issue 表格逐条对得上；③ `pnpm check` 绿（含刷新后的 `check:doc-claims` 与 `check:techdebt-metrics`）。 |
| **测试** | `tests/scripts/doc-claims.spec.ts:85` 已有 `--check` 端到端绿断言，但 `src_module_list` **零覆盖** ⇒ 补：node_modules 与 `lib/*.d.ts` 不计入；`git add -f` 一个 `.test.ts` 前后的计数变化（负控制：改用 `filesWithSuffix` 则断言红）。`measure-techdebt.test.mjs` 补：`ui/src/**/*.js` 计入、`ui/src/lib/` 的 ts 计入（负控制：还原旧口径则两例红）。 |
| **门禁联动** | 同 PR 跑 `pnpm gen:doc-claims`（316→98）+ `pnpm measure:update`（catch 数字变）+ `pnpm test:pr-tooling`（门禁自测）。 |
| **决策记录** | 一条，涵盖两个 resolver 的口径选择与三个备选（walk 跳过 node_modules / 只数 git 跟踪 / 移出 vendored 子包）——#520 的三选一与 #530 的两处盲区同属「口径必须与既有声明对齐」这个主题。 |
| **工作量** | **M**（两个 resolver + 两处门禁自测 + 两处生成物刷新） |

### 3.2 P2 · 门禁棘轮化（#527 + #530 的棘轮部分）

**为什么合并**：两者的根因**同型**——门禁只校验「与基线正文一致」，不校验「不得更差」。合并可用**一套棘轮语义 + 一条决策记录**说清，避免两条 note 各写半套。

| 项 | 内容 |
|---|---|
| **#527 修法** | `scripts/check-architecture-boundaries.mjs`：`baselineKey`（`:173`）对 `file-size` 规则纳入**基线记录行数**作为上限；`:259` 的 `fresh` 判据增「file-size 且当前行数 > 基线记录值」即视为违规；`--update-baseline` 分支（现仅 `writeFileSync` + 打印条数）改为**逐条打印本次追认的 Δ**。 |
| **#530 修法** | `scripts/measure-techdebt.mjs`：`checkFreshness()`（`:779`）新增**棘轮断言**——「越少越好」类指标（`catchNoParam.undocumented` 等）不得高于基线记录值，超出即 `exit 1` 并要求显式刷新；刷新入口打印本次追认的增量。建议把阈值放进机器可读的 `docs/technical-debt/thresholds.json`（而非写死在脚本里），使「上调阈值」成为一次可 review 的改动。 |
| **验收（可观测）** | ① 把 6 条超基线文件保持原样跑 `pnpm check:architecture-boundaries` ⇒ **非 0 退出**并列出 6 条与 Δ（+136 合计）；② 一次性重刷基线后转绿，且 stdout 打印出这 6 条的 Δ（追认可见）；③ 棘轮用例：「基线 850、文件 900 → 退出 1」；「基线 12、树 13 → 非 0」；「刷新后放行」。 |
| **测试** | `scripts/check-architecture-boundaries.test.mjs` 已有 `:109`（登记进基线后放行）与 `:180`（`--update-baseline` 移除消失条目），**无增长用例** ⇒ 补两条。`scripts/measure-techdebt.test.mjs` 30+ 用例（`:198`/`:202`/`:215`/`:229`/`:330`）**无阈值用例** ⇒ 补两条。 |
| **门禁联动** | 两条门禁都挂在 `pnpm lint` 尾 ⇒ 本 PR 自身必须先让仓库转绿（重刷基线）。`--update-baseline` 追认的 **+136 行必须写进 PR 描述与决策记录**——这是棘轮的第一次真实使用，示范它期望的「承认动作」形态。 |
| **决策记录** | 一条，统一棘轮语义（越少/越短越好 ⇒ ≤ 基线；刷新必须打印追认增量）+ 备选（仅告警 / eslint 规则 / 不改）。 |
| **工作量** | **M** |
| **风险** | 棘轮会让「合法增长」必须显式承认（如 #534 会减少 `git.js` 行数、无冲突；但 P4/P7 若使某文件变长就需同 PR 刷新）。这是**设计意图**，但必须在 note 里写明「何时可以上调阈值」，否则会被当成噪音用 `--update-baseline` 顺手绕过——**而这恰恰是棘轮要治的行为**。 |

### 3.3 P3 · 记忆检索不再阻塞首 token（#536）

| 项 | 内容 |
|---|---|
| **现状** | `DefaultContextRuntime.ts:214` 已把检索提前并行启动，但 `:246-247` 仍 `await` 其完成才发请求；`DEFAULT_MEMORY_RETRIEVAL_TIMEOUT_MS = 30_000`（`:120`）是熔断上限。abort **未透传**：`EdgeClawMemoryProvider.ts:54` 声明 signal、`:153` 传入，而 memory-core 侧无 `AbortSignal`（grep 计数 0）⇒ 熔断只是不再等，内层继续跑。`modelRequest.ts:127` 每请求（按缓存键 `sessionId\0query\0projectRoot` + 30s TTL，实际是**每个不同 query** 一次）。 |
| **修法** | ① **非阻塞化**：改为「后台检索 + 下一轮注入」——本轮不 `await`，命中则注入、未命中则本轮空注入并在完成后供下一轮使用（保留 fail-soft 降级语义，**不取消降级**）；② **abort 落仓内适配层**：在 `EdgeClawMemoryProvider` 内做竞速并在熔断后丢弃内层结果，**不改 vendored 子包**。 |
| **验收（可观测）** | ① 注入超时（fake timer 推进 30s）时 `prepareForModel` **不阻塞**且本轮注入为空、不抛；② 熔断后内层结果不再进入任何后续注入（丢弃语义可断言）；③ 命中缓存路径行为逐字不变（既有 15 条用例全绿）。 |
| **测试** | `tests/context/memory/memory-attachment-builder.spec.ts` 166 行 15 条**零超时用例** ⇒ 补 fake-timer 断言「超时后注入为空且不抛、诊断码 `memory_provider_error`」。负控制：撤掉「超时即空注入」⇒ 该用例红。 |
| **门禁联动** | `pnpm measure:update`（`src/context/` 行数变化）。不触 `inputSchema`（无 fixture 重录）、不触事件面。 |
| **决策记录** | 一条：「为何选后台检索而非到期即注入」「abort 为何不落 vendored 子包」。 |
| **工作量** | **M** |

### 3.4 P4 · 账本快照不再二次增长（#537）

| 项 | 内容 |
|---|---|
| **现状** | `JsonlTranscriptWriter.ts:267-273` 每次 `recordWorkspaceState` 都落**整份** `state`；读取侧只认最新一条（`WorkspaceLedgerReader.ts:5-6`）；`verified` 是 append-only（`WorkspaceLedger.ts:171`）⇒ 单条快照与累计都呈二次增长（issue 实测 200 次笔记 3.65 MiB）。硬顶 `TranscriptReader.ts:7` = 50MB（判定在 `:176` 与 `:511` **两处**），越限后账本 `unavailable`、`workspace_note` 拒绝写入（`WorkspaceNoteTool.ts:68-73`）。**当前开关 `SATI_WORKSPACE_LEDGER_ENABLED` 默认关**。 |
| **修法（受 §2.3 第 1 条约束）** | **保持每条快照自足**（这是 PR #378 决策的硬前提），在此之上：① 按 **change token 去重**——状态未变化时不写新条目（今天每个 `workspace_note` 必写一条，即使内容相同）；② **周期性全量锚点** + 变化集（若需要进一步压缩）。**不得**改成「只落增量」，也**不得**反向扫文件尾部。 |
| **验收（可观测）** | ① 连续 N 次「无变化写入」⇒ transcript 字节数**不增长**；② 「单条 `workspace_state` 即可重建完整账本」的**格式级断言**通过（这是新格式最需要的护栏，现测试无此断言）；③ 三条读取路径验证：**新会话冷读**、**resume 冷读**（Store 层与新会话等价，见 §2.2）、**周期锚点**（跨越锚点边界的读取）；④ 现有 9 条 `workspace-ledger-store.spec.ts` 用例（游标复用 / 锚失效 / 等长重写 / 超限 unavailable）全绿。 |
| **测试** | `tests/session/workspace/workspace-ledger-store.spec.ts` 补格式级断言与「无变化不写」「锚点重建」用例。负控制：把「自足快照」改成增量条 ⇒ 冷读用例必须红。 |
| **门禁联动** | `pnpm measure:update`。**零**事件面 / 零 gateway 帧 / 零 i18n（已核实 `ui/src` 无 `workspace_state` 命中）。 |
| **决策记录** | 一条，必须**显式引用** `docs/notes/implemented/2026-09-15-workspace-ledger-read-path.md` 并说明为何「只落增量」与「反向扫」被再次否决（该 note 已把它们列为落选/待设计）。 |
| **工作量** | **L** |
| **风险** | transcript 是所有能力面共用的 durable 载体（续算扫描 / 全量读取 / 备份 / 搜索）。改动必须**不动 durable 边界**：`recordEntry` 仍走 pending 批写、`flushCheckpoint` 语义不变。 |

### 3.5 P5 · `ui/server` 资源与延迟收敛（#533 层① + #534 + #529）

三条同属 `ui/server`（JS，`node --test`），文件不重叠，验证命令相同 ⇒ 合批省两次 CI 往返。

**① #533 · 跳过表补 `.pnpm-store`（层①，S）**

| 项 | 内容 |
|---|---|
| 现状 | 跳过表 `ui/server/services/filesystem.js:305-316` 排除 `node_modules`/`dist`/`build`/`.sati*`/`.tmp`/`.git` 等，**无 `.pnpm-store`**；`getFileTree`（`:294`）以 `maxDepth=10 + showHidden` 从项目根急切遍历（调用点 `routes/project-files.js:382`），`:327` 对每节点串行 `await fsPromises.stat`。实测全树 **59,297 节点 / 621ms**，其中 `.pnpm-store` **52,639 = 88.8%**；**跳过它只剩 6,658 节点 / 67ms**。 |
| 修法 | ① 跳过表补 `.pnpm-store`（并可加一条「点开头的包管理器缓存目录」通则，避免 `.yarn`/`.cargo`/`__pycache__` 逐个重演）；② 把跳过判据抽成**纯函数** `shouldSkipEntry(name)` 以便直测。**不做**层②（见 §2.3 第 4 条，拆独立议题）、**不做**层③（层①后并发收益 <60ms 且 fd 压力上升）。 |
| 验收 | `GET /api/project-files` 首屏节点数 **59,297 → 6,658**、服务端遍历耗时 **621ms → 67ms**（本机复跑同一脚本）；`src`/`ui`/`tests` 等真实目录仍正常返回。 |
| 测试 | `ui/server/**` 对 `getFileTree` **零覆盖** ⇒ 新增 `shouldSkipEntry` 单测：`.pnpm-store`/`node_modules`/`.sati*` 跳过、`src` 不跳过。负控制：去掉 `.pnpm-store` ⇒ 断言红。 |
| 附注 | `showHidden` 是**死参**（`:294` 声明、仅 `:351` 递归传递，函数体从不读）；`project-files.js:76` 注释「不含隐藏」不实——顺手更正注释（不行为变更）。 |

**② #534 · `/commits` 合并为单次 `git log --stat`（M）**

| 项 | 内容 |
|---|---|
| 现状 | `routes/git.js:823-834` 在 `for` 循环里为每个 commit 串行 `spawnAsync("git", ["show","--stat",...])`；`limit` 上限 100（`:799-807`）。实测 10 条 **130ms** vs 单次 `git log --stat -n10` **17ms**；`-n100` 串行 **1,140ms** vs 单次 **43ms**。**该路由零测试覆盖**（`grep -c commits git.test.js` = 0）。 |
| 修法 | 合并为一次 `git log --pretty=<fmt> --stat -n <limit>`。**解析必须按 header 正则切块**（`/^[0-9a-f]{40}\|/`），**不能按空行分块**——实测 merge commit 的 `--stat` 段**完全缺失且其后无空行**，按空行会把下一提交的 stat 串到 merge 上。块内取最后一个匹配 `/\d+ files? changed/` 的行，无匹配则 `""`（与现状对 merge 返回空串**等价**）。 |
| 验收 | 默认 `limit=10` 耗时 **130ms → 约 17ms**；`limit=100` 约 **1,140ms → 43ms**；`stats` 与旧实现（`git show --stat --format=`）逐条等价，**含 merge 的 `""` 例**。 |
| 测试 | 落 `ui/server/routes/git.test.js`，复用既有 `createRepository()`（`:150-165`，真实临时 repo）、`createGitApp()`（`:167-183`）、`loadGitModule()`（`:128-140`）。用例：① 两提交 repo，`stats` 与 `git show --stat --format=<hash>` 汇总行等价（锚）；② merge ⇒ `stats === ""`；③ `limit=999→100`、`0/abc→10`；④ 重命名/二进制汇总行可解析。该文件已入库、非 `*.test.ts` ⇒ 无需 `git add -f`。 |
| 附注 | 本改动会**减少** `git.js` 行数与 2 处无参 `catch` ⇒ 与 P2 的棘轮/指标基线交叉，须同 PR 跑 `pnpm measure:update`。`architecture-baseline.json` 已豁免 `git.js` 的 file-size，减行不触发。 |

**③ #529 · 四张 per-session 缓存加上限（S，≈1h）**

| 项 | 内容 |
|---|---|
| 现状 | `_sessionTitleCache`（`:1438`）、`_userQueriesCache`（`:1524`）、`_toolSequenceCache`（`:1640`）、`_subagentPromptCache`（`:1724`）均只增不减；对照已治理的 `sessionState`/`pendingAgentToolCalls`（`MAX_ACTIVE_SESSIONS = 500`，`:95`；逐出 `:361-370`）。 |
| **修法方向修正** | issue 建议的「或按 mtime 失效时顺带删除已消失会话的键」**不可行**：实测这 4 张缓存的唯一调用方是 `getRouterDashboardData()`（`:1923` ← `routes/system.js:93`），其 `sessionId` 取自**落盘 router stats 里的历史会话**，因此**不存在「会话结束」钩子**（`cleanupSessionBookkeeping:270` 只清另三张），且标题缓存**无 mtime 校验**。⇒ 正确修法是新增 `setBounded(map, key, value, limit = 500)`（Map 插入序 FIFO 上限），套用到 4 处 `set`，与 `MAX_ACTIVE_SESSIONS` 同构复用**同一个常量**。 |
| 验收 | 连续写入 600 个不同 key 后 `map.size ≤ 500` 且最旧条目被逐出；4 张缓存的既有命中行为不变（同 key 二次读取仍命中）。 |
| 测试 | `ui/server/sati-bridge.test.js`（4 个 describe）对这 4 张**零覆盖** ⇒ 需先导出测试缝（或把 `setBounded` 抽成独立可测工具再断言边界）。负控制：去掉上限 ⇒ 「size ≤ 500」用例红。 |
| 附注 | **账本回填**：`backlog.md:1321` 的 `TD-UISERVER-N02` 仍写行号 `:1237/1319/1435/1529`，与 HEAD 差约 200 行 ⇒ 本批同 PR 更正（这属于 P9 的回填工作，但在此顺手做，符合「交付即回填」）。`sati-bridge.js` 2347 行在 `metrics.md` Top30 ⇒ `pnpm measure:update` 必跑。 |

| 批次汇总 | |
|---|---|
| 验收门槛 | `pnpm check` + `pnpm measure:update` + `pnpm test`（含 `ui/server` 的 `node --test`） |
| 决策记录 | 一条（#533 的三层取舍、#534 的解析边界、#529 的 FIFO 而非会话钩子） |
| 工作量 | **M**（#533 层① S + #534 M + #529 S） |

### 3.6 P6 · 信任门与工具注册契约（#538 + #532）

两条都在「关键路径上的防护/信任」位置，且都要新增缓存（须防「缓存伪装成新鲜」）⇒ 合批共用一条决策记录。

**① #532 · 恢复 `outputSchema` 严格位（M，严重级应上调）**

> ⚠️ **本方案对该 issue 的定级提出异议**：issue 定 P3（「失去的是一道**防护**而非现存缺陷」）。实测**不成立**——项目级共享 MCP 工具**今天就已经被静默吞掉**：`src/cli/ProjectRuntimeRegistry.ts:438` 用无 `outputSchema` 的定义注册 → 严格表抛错 → `:447` 的 `catch` 降级为 warn，该 MCP 工具**静默消失**（`:445` 的辅助工具一并被跳过）。即「会话作用域无防护」只是其中一面，**另一面是项目级已有功能性丢工具**。建议分诊时把 `TD-TOOL-002` / #532 上调至 **P2**。

| 项 | 内容 |
|---|---|
| 现状 | 三处 `new ToolRegistry()` 无参构造丢掉严格位：`ToolRegistry.ts:110`（`clone()`）、`filterAvailableTools.ts:19`、**`SubAgentSession.ts:173`（issue 漏记的第三处）**；严格表在 `createBuiltinRegistry.ts:286`。运行时实测（只读）：严格表 `register(MCP def)` **抛**，`clone().register` **不抛** ⇒ 严格位归零确证。 |
| **修法（先定口径）** | MCP 工具的**结果形状不可静态声明**——`src/mcp/client/operations.ts:46` 是 `content: unknown`，`structuredContent` 被丢弃、`toToolSpec` 不透传服务器 schema ⇒ 给它补一个宽松 `outputSchema` 只能是**恒真**（自研校验子集对 `{}` 恒通过），那是把「无契约」伪装成「有契约」。⇒ **选 `kind === "mcp"` 豁免严格位**（`SatiToolKind` 已含 `mcp`，1 行且诚实），透传服务器侧 schema 留作后续刀。透传 `this.options` 到 `clone()`/`filterAvailableTools`/`SubAgentSession` 三处 + 豁免分支，**三处必须同批改**（否则 `sessionToolSurface.ts:136` 的替换会把修复抵消）。 |
| ⚠️ 陷阱 | 天真透传的后果与 issue 描述**不同**：在 `sessionToolSurface.ts:88`（处于 `:79-96` 的 `try/catch` 内）表现为**静默全丢**（不是抛错）；只有 `filterAvailableTools.ts:26` 无 catch 才是硬抛。⇒ 修复后必须有断言覆盖「MCP 工具注册成功且数量不变」，否则会以「静默少工具」的形式回归。 |
| 验收 | ① `clone()` 与 `filterAvailableTools()` 保留严格位：在其上注册**非 MCP** 且无 `outputSchema` 的工具 ⇒ **fail-loud 抛错**；② 注册 MCP 工具 ⇒ 成功，工具数量与修复前逐一相同；③ 项目级共享 MCP 工具不再被吞（`:438`→`:447` 的 warn 路径不再触发）。 |
| 测试 | 现测试对 `.clone()`/`filterAvailableTools`/`requireOutputSchema` **零命中**（只有直构用例）⇒ 补 clone 保持严格位的单测 + MCP 豁免用例。负控制：clone 不传 options ⇒ 严格位用例红；去掉 MCP 豁免 ⇒ MCP 注册用例红。 |
| 门禁联动 | `outputSchema` **不进** `toolSchemaDigest`（`requestInvariant.ts:75` 只含 name + `inputSchema`）⇒ **不触发 llm-replay 重录**；`pnpm measure:update`（行数）。 |
| 决策记录 | 一条：MCP 豁免口径的取舍（恒真 schema vs kind 豁免）+ 三处同批的必要性。 |

**② #538 · 信任门整树哈希进程内 memo + `blocked` 死角（L）**

| 项 | 内容 |
|---|---|
| 现状 | `evaluateHookTrust.ts:55`（实名 `evaluateProjectHookTrust`）对每个项目插件调 `computeHookBundleDigest`（`hookBundleDigest.ts:50-67`：`readdir` + `stat` + `readFile` 全树、逐个 `hash.update`），**无任何 cache/memo**（`grep -rn "cache\|memo" src/extension/plugins/trust/*.ts` 无命中）。上限 `:19-20`（2000 文件 / 8 MiB）越限即 `blocked`，而 `blocked` 在 `hookTrustService.ts:119-121` 被拒 ⇒ 带 `node_modules/` 的插件**永久无法授权**。实测 **166–189ms/次**，重复评估无加速。三条入口共用：`ProjectRuntimeRegistry.ts:571-577`（会话装配）、`hookTrustService.ts:46-53`（打开面板）。 |
| 修法 ①（memo） | 失效键用 walk 过程中**既有的 stat** 产出签名 `sha256(rel + size + mtimeMs)`（不额外增加 IO）。约束（必须同时满足，否则无声弱化信任语义）：**仅进程内**（内容判据要求「当前磁盘内容」）、**只缓存 `hashed` 结果**（`blocked`/读失败不写缓存）、`decide` 路径**绕过 memo 重算**。 |
| 修法 ②（死角） | `blocked` 原因**结构化**（区分「超限」与「内容不符」）并扩展 `reason`（`src/gateway/protocol/types.ts:599`）+ 面板提示（新文案进 `ui/src/i18n/locales/{en,zh-CN}/hookTrust.json`）。**不做**「跳过 `node_modules`/`.git` 的哈希」——决策记录 `docs/notes/implemented/2026-09-21-project-hook-trust-gate.md` 把「整树内容摘要」定为信任单位（command 可引用目录内脚本），跳过子目录会推翻该决策（见 §6.1 分叉 6）。 |
| 验收 | ① 同一插件目录第二次评估 **166–189ms → 个位数 ms**；② 任一文件内容变化（含**尺寸不变、仅 mtime 回填**的情形）后签名变化 ⇒ 重算；③ `blocked` 的两类原因可区分且面板可见；④ 既有三种 `blocked` 用例（`hook-trust-report.spec.ts:235-263`）全绿。 |
| 测试 | memo **零覆盖** ⇒ 补：缓存命中（第二次不重算）、`(size, mtime)` 变化失效、**内容变但 mtime 回填**（这是最容易被无声弱化的一条）、`blocked` 不写缓存。现有 `hook-trust-report.spec.ts:72-92` 只测「mtime 变 / 内容变」两种 ⇒ 必须补第三种。 |
| 门禁联动 | 新用户文案 ⇒ **i18n 必须提取**（`pnpm check:i18n-namespaces` 挂在 lint）；`pnpm measure:update`；不触事件面（`blocked` 是工具/面板内部状态，非 GatewayEvent）。 |
| 附注 | #530 的「无注释无参 catch」名单含本文件 `:59`/`:88` ⇒ 若重构触及，按 #353 体例补「失败模式 → 回退语义」注释（不要把计数改回去）。 |
| 工作量 | **L（1 天+）** |

| 批次汇总 | |
|---|---|
| 验收门槛 | `pnpm check`（含 `check:i18n-namespaces`）+ `pnpm measure:update` + `pnpm test` |
| 决策记录 | 两条（#532 与 #538 的取舍不同，各自独立） |

### 3.7 P7 · 团队热路径读放大（#531）

| 项 | 内容 |
|---|---|
| **现状** | `TeamShare` 构造即 `load()`，`load()` 全文 `readFileSync` + 逐行 `JSON.parse`（`team-share.ts:138-161`）；三处生产点**每次新建**（`teamShare.ts:112`/`:189`、`teamSubsystem.ts:166`），调度器经 `readSharedBoardSummary` 注入后在 `scheduler.ts:253` 的派发路径调用 ⇒ **每次派发一次全量同步读**。面板侧：`teamPanel.ts:32-35` 三张全量数组 + `:44-45` 按团队 `filter`；`views.ts:38` → `team-db.ts:418-423` **每成员一次**同步 SQL；UI 轮询 10s（`constants.ts:4`）。 |
| **修法** | ① **实例缓存**（**不用** issue 备选的反向扫，见 §2.3 第 2 条）：模块级 `Map<path, {mtimeMs, size, inst}>` + `statSync` 失效，可复用 `src/shared/ttl-cache.ts`；② `retired` 改为**一次** `SELECT session_key FROM retired_members` 建 Set，按 team 的 `filter` 改为一次分组。**不改**面板快照的授权面行为（T6 评审的刻意取舍）。 |
| **验收（可观测）** | ① 同一路径连续两次派发 ⇒ `load()` 只执行 1 次（缓存命中可断言）；② 文件 `mtime`/`size` 变化后失效并重读；③ `summary()` 的键序与缓存前**逐字相同**（首次出现序）；④ 团队面板快照的 SQL 次数由 O(成员) 降为 1。 |
| **测试** | `tests/agent/team/storage/team-share.spec.ts`（5 条）与 `tests/gateway/teamPanel.spec.ts:50/75` 已有，**缺缓存命中/失效断言** ⇒ 补「命中次数」「(mtime,size) 失效」「键序不变」。负控制：去掉实例缓存 ⇒ 命中次数用例红；`retired` 改回每成员一查 ⇒ SQL 次数用例红。 |
| **门禁联动** | `pnpm measure:update`；**若位移了 `team_share_updated` 的发出点行号**（现 `teamShare.ts:114-115`，事件矩阵按 `file:line` 硬编码）⇒ 必须 `pnpm gen:event-matrix`。 |
| **决策记录** | 一条：为何用实例缓存而非反向扫（含 `seenDedup` 幂等与键序两条实测理由）。 |
| **工作量** | **M** |

### 3.8 P8 · 微优化与去重（#535 + #541）

| 项 | 内容 |
|---|---|
| **#535 修法** | (a) 一行替换：`readSessionMessages.ts:487-489` 的 `JSON.parse(JSON.stringify(...))` 改用仓内既有 `cloneMessage`（`src/model/protocol/clone.ts:35-40`，已由 `src/model/index.ts:104` barrel 导出）。语义差异已核实**无回归面**（`metadata`/`block.raw` 转共享引用、`content: undefined → []` 且该语义已有测试锚定、`src/web/server/` 无写回路径）。(b) **只改文档**：更正 `backlog.md:322` 的 `TD-GATEWAY-003` 登记（删「可能无人读」、行号改 `:1268-1283`）。 |
| **#541 修法** | ② 删 `lookup()`（`src/model/window/store.ts:135`、`src/extension/plugins/trust/HookTrustStore.ts:78-80`）——零生产调用者且每次调用整表重读；同步改 3 个测试文件（`tests/model/window/store.spec.ts:33,46`、`probe.spec.ts:79,220,226,227`、`tests/cli/hook-trust-service.spec.ts:79`、`hook-trust-gate.spec.ts:187,196`）。① 抽共享层**不在本批做**（触发条件未满足，见 §2.3 第 5 条）——若要做，方向是**纯函数层** `src/shared/persist/versionedJsonFile.ts`（`parseVersionedFile<T>` + 写函数）而非继承基类。③ barrel 收敛**不做**。 |
| **验收（可观测）** | ① 会话消息读取结果与替换前**逐字等价**（对同一 transcript 的 `extractWebVisibleMessages` 输出 `deepEqual`）；② `undefined` 字段不再丢失；③ `grep -rn "\.lookup(" src/` 归零、3 个测试文件同步绿。 |
| **测试** | `tests/web/read-session-messages-cache.spec.ts` 6 例全是缓存/分页/tokenUsage，**无 clone 语义用例** ⇒ 补「克隆结果 `deepEqual` 原消息」+「`content` 元素非同一引用」。负控制：换回 JSON 深拷贝 ⇒ 「`undefined` 字段保留」用例红。 |
| **门禁联动** | `pnpm measure:update`（删方法改行数）。不触事件面 / 协议 / i18n。 |
| **决策记录** | 一条：#541 的三项各自为何做/不做（尤其 barrel 收敛「收益为 0 而成本最高」需留档，否则会被反复提出）。 |
| **工作量** | **S–M**（#535 约 30min；#541 的删方法 + 3 测试文件约 1h） |

### 3.9 P9 · 账本回填与议题收尾（#528）

| 项 | 内容 |
|---|---|
| **现状** | 账本 304 条条目（new 221 / done 71 / partial 3 / in_progress 2 / wontfix 1 / triaged 1 / 未识别 5）；条目级「最后复核」**0 条**。issue 的「8 条下界」经复核**有 3 条是误报**（`TD-SESSION-N01`、`TD-ROUTER-001/002` 在扫描基线上已是 `done`）⇒ 真实下界 **5 条**。 |
| **修法（受 §2.3 第 9 条约束）** | ① **回填 5 条状态滞后条目**（`TD-METRIC-001`、`TD-METRIC-002`、`TD-PROCGATE-004`、`TD-PATENT-N13`、`TD-SMALL-N01`）：状态改 `done` + 补 commit/PR 证据 + 「最后复核：日期」；② **回填 4 条描述失准**（`TD-KNOWLEDGE-N02`、`TD-CRON-N01`、`TD-GATEWAY-003`、`TD-CONTEXT-N03`）：§4/§6/§7/§18 的**正文**（§37 的更正不能替代正文回填）；③ 为 **#520 新建账本载体**（本方案实测：它无任何载体）；④ 把 P1–P8 落地的 14 条对应条目全部改 `done` + 补证据 + 复核日期。 |
| **可选（本方案的增量建议）** | 把 issue 提出的「是否固化成脚本校验」从「不可机械判定」升级为**两条已验证可行的报告型判据**（先 `--warn` 不阻塞）：**(i)** 终态条目块必须含 `#NNN` / `PR #` / `docs/notes/` 之一——宽口径实测 71 条终态中有一批不满足（窄口径实测 6 条，见 §2.3 末尾的口径敏感实证）；**(ii)** 条目块必须含「状态：」字段——实测 4–5 块完全没有该字段。**上线前必须先钉死三件事**（条目块边界、状态字段识别含加粗括号变体、证据引用白名单），否则数字会随实现漂移（差 3.5 倍的实证见 §2.3）。 |
| **验收（可观测）** | ① 5 条状态滞后条目在账本中不再是 `new`，每条带 commit/PR；② 4 条失准描述在各**原节正文**已更正（不只是 §37）；③ #520 有载体；④ 14 条议题逐个 `Closes #<n>` 合并后关闭，关闭语含结论（见 §7）；⑤ 若采纳可选判据：脚本以 `--warn` 模式跑出稳定数字，且同一实现连续两次运行结果一致。 |
| **测试** | 账本侧**零覆盖**（`grep -rn "backlog" scripts/ package.json` 仅命中 `check-pr-issue.mjs` 的注释文本）⇒ 若采纳可选判据，新增 `scripts/check-backlog-freshness.mjs` + `.test.mjs`（**注意**：新增 `*.test.ts` 须 `git add -f`，`.mjs` 不受影响）。 |
| **门禁联动** | `pnpm measure:update`（回填若改行数）。若给 `backlog.md` 加门禁，须挂 `pnpm lint` 链并同步 `docs/issue-management.md` §6.1 与 `backlog.md` §37.5 的表述（三处必须一致，否则同一约定写三处必然漂移）。 |
| **决策记录** | 一条：回填的证据标准（「issue 关闭结论 + 代码证据」，不采信「issue 是否关闭」）+ 两条机械判据的取舍 + 为何先 `--warn`。 |
| **工作量** | **S/M（2–4h）** 闭环 #528 的已核实部分；「全量回填 221 条 `new`」另计 **25–50h**，**拆为独立后续项**，**不作为 #528 的验收条件**（见 §2.3 第 9 条）。 |

---

## 4. 执行顺序与依赖

### 4.1 硬依赖

| 依赖 | 原因 | 后果若违反 |
|---|---|---|
| **P9 在 P1–P8 全部之后** | #528 回填要反映**最终**代码状态 | 同一批条目二次滞后，正好复现 #528 自身要治的形态 |
| **P1 必须先于 P2** | 棘轮把「当前值」冻结为上限，而 #530 的口径修正会把它从 **12 抬到 17** | 棘轮以漏算的 12 为上限 ⇒ 把 5 处漏算**永久合法化**，比不加棘轮更糟（这正是审计报告说的「把排期建立在失真信号上」） |
| **P2 的两条同批** | #527 与 #530 的棘轮是**同一套语义**（越少/越短越好 ⇒ ≤ 基线；刷新必须打印本次追认的增量），可共用一条决策记录；且两者都要一次性重刷基线 | 拆开会产出两套「承认动作」语义，后来者无法判断该用哪个 |
| **#530 跨 P1/P2 两段** | 同一 issue 分两段交付：P1 写「关联 Issue: #530」，P2 写 `Closes #530` | 反过来（先棘轮后口径）会让门禁先红一次，并需要额外解释基线为何上调 |
| **P5 应在 P2 之后**（或与 P2 同批刷新基线） | P5 的 #534 会**减少** `ui/server/routes/git.js` 的行数与 **2 处无参 catch** ⇒ 与 #530 的指标基线交叉 | 若早于 P2，P2 重刷基线时会把 P5 的减少一并追认，掩盖「这次棘轮生效了没有」 |
| **P6 的两条各自独立提交** | #532 动 `src/tool/registry/` + `src/cli/`，#538 动 `src/extension/plugins/trust/` | 无冲突（同批只为共用一条「缓存不得伪装成新鲜」的决策记录） |

### 4.2 软顺序（可并行但建议串行）

**P1 → P2 → P3 是有意的**：P1/P2 修完信号面后，后续批次的改动才有一个可信、且**带棘轮**的度量基线与之比对；否则 `measure:update` 会把任何增长静默追认——而这正是 #530 要治的行为。

**P3–P8 之间无依赖**，可按人力合并、重排或并行（唯一的例外是 §4.1 的 P5↔P2 交叉）。**若产品发布窗口临近，P5 可整体前移**——它的体感收益最直接（文件视图首屏 621ms → 67ms、git 面板 130ms → 17ms），且不与其它批次冲突。

但**每个批次仍应独立 PR**：它们是不同功能域，合并会让 review 面与回滚粒度同时放大。

### 4.3 每个批次的固定流程

```sh
git checkout -b <type>/<issue>-<slug>          # main 受保护，必须分支 + PR
# …实现 + 测试…
git add -f <新增的 *.test.ts>                   # ⚠️ .gitignore 忽略 *.test.ts，不 -f 则文件不入库、CI 永不跑
pnpm check                                     # 聚合门禁（check:freshness + config + typecheck + ui typecheck + lint + format）
pnpm measure:update                            # 若改动影响 metrics（行数/文件数/catch 计数等）
pnpm gen:doc-claims                            # 若改动影响事实层（版本/计数/src 模块索引）
pnpm test && (cd ui && pnpm test)              # 后端 + UI 测试（pnpm check 不含 test）
# 决策记录：docs/notes/implemented/<date>-<topic>.md（含 ## Alternatives considered）
# PR 描述里写 Closes #<n>（或 "关联 Issue: #<n>"；PR 追溯门禁强制其一）
```

> ⚠️ **`git add -f` 的连带效应**（AGENTS.md 已记录）：`metrics.md` 的文件数按 `git ls-files` 统计 ⇒ force-add 一个 `.test.ts` 会改变基线。顺序必须是 **`git add -f` → `pnpm measure:update` → 一起提交**，否则 `check:techdebt-metrics` 会红。

---

## 5. 门禁与验收矩阵

### 5.1 门禁联动（本仓 12 个领域门禁中，本方案会碰到的）

| 门禁 | 何时会红 | 本方案哪几个批次会碰 |
|---|---|---|
| `check:techdebt-metrics` | 任何影响指标的重算结果与 `metrics.md` 基线不一致 | **P1–P8 全部**（改行数 / 新文件 / 口径） |
| `check:doc-claims` | `docs/code-facts.md` 与代码不一致 | **仅 P1**（#520 改的正是它的 resolver 产物） |
| `check:architecture-boundaries` | 文件超 800 行且不在基线；或边界违规 | **P2**（#527 改 `baselineKey` 后，6 条超基线文件会**变为红**——这正是修复目标）；P4/P6/P7 若使某文件增长 |
| `check:event-matrix` | `AgentEvent`/gateway frames 的产/消边变化 | **可能 P7**（#531 若位移 `team_share_updated` 发出点所在行） |
| `check:protocol-version` | 网关方法/版本表与实现不一致 | 无（14 条均不改协议） |
| `check:i18n-namespaces` | 新增用户可见文案未提取 | **P6**（#538 的 `blocked` 原因面板提示须进 `ui/src/i18n/locales/{en,zh-CN}/hookTrust.json`） |
| `record:replay`（重放契约） | 工具 `inputSchema`（含描述）改动 | **无**——14 条都不改 `inputSchema`；且已核实 `outputSchema` **不进** `toolSchemaDigest`（`requestInvariant.ts:75` 只含 name + `inputSchema`）⇒ 连 P6 也不需重录 fixture |
| `pnpm test` / `cd ui && pnpm test` | 回归 | P3/P4/P6/P7（后端）、P5（含 `ui/server` 的 `node --test` 与 UI vitest） |

> **重要**：`pnpm check` **不含** `pnpm test`（见 `package.json` 与 `docs/development-standards.md` 附录 A）。本方案每个批次的验收都必须显式跑测试，不能以 `pnpm check` 绿代替。

### 5.2 逐条验收标准（可观测）

关闭任一议题前，逐条对照下表；每条都是**可复算/可断言**的，不接受「已修复」这类自述（`docs/development-standards.md` §6「验证世界，不是自述」）。

| # | 验收判据 |
|---|---|
| 520 | `docs/code-facts.md` 的 `src/context` 行由 **316 → 98**；同一提交在「干净检出 / 已装依赖 / 子包已 build」三态复算得**同一个值** |
| 527 | 6 条超基线文件使 `pnpm check:architecture-boundaries` **非 0 退出**并列 Δ；一次性重刷基线后转绿，且 stdout 打印本次追认的 6 条 Δ |
| 530 | 口径：`catchNoParam.undocumented` **12 → 17**（含 5 处新计入并逐条对得上）；棘轮：基线 12、树 13 ⇒ 非 0 退出 |
| 536 | fake timer 推进 30s ⇒ `prepareForModel` **不被阻塞**、本轮注入为空、不抛；熔断后内层结果不再进入后续注入 |
| 537 | 连续「无变化写入」⇒ transcript 字节数**不增长**；「单条 `workspace_state` 即可重建全账本」格式断言通过；三条读取路径（新会话/冷 resume/跨锚点）验证 |
| 533 | `GET /api/project-files` 首屏节点数 **59,297 → 6,658**、服务端遍历 **621ms → 67ms** |
| 534 | `limit=10` 由 **130ms → ≈17ms**、`limit=100` 由 **1,140ms → 43ms**；merge commit 的 `stats` 仍为 `""`；新增 4 条路由用例 |
| 529 | 写入 600 个不同 key 后 `map.size ≤ 500` 且最旧被逐出；同 key 二次读取仍命中 |
| 538 | 同一插件目录二次评估 **166–189ms → 个位数 ms**；内容变化（**含 mtime 回填**）即重算；`blocked` 的「超限」与「内容不符」可区分且面板可见 |
| 532 | 在 `clone()`/`filterAvailableTools()` 上注册**非 MCP** 且无 `outputSchema` 的工具 ⇒ **fail-loud**；MCP 工具注册成功且**数量与修复前逐一相同**；项目级共享 MCP 不再被吞 |
| 531 | 同路径连续两次派发 ⇒ `load()` 只执行 1 次；`(mtime,size)` 变化即失效重读；`summary()` 键序**逐字不变**；面板快照 SQL 由 O(成员) 降为 1 |
| 535 | 会话消息读取结果与替换前 `deepEqual`；`undefined` 字段不再丢失；`backlog.md` 的 `TD-GATEWAY-003` 文字已更正（删「可能无人读」、行号改 `:1268-1283`） |
| 541 | `grep -rn "\.lookup(" src/` **归零**，且 3 个测试文件同步绿；「抽共享层/barrel 收敛」未做一事已留档（触发条件未满足） |
| 528 | 5 条状态滞后条目不再是 `new` 且各带 commit/PR 证据；4 条失准描述在**各原节正文**已更正；#520 有账本载体；14 条议题逐个关闭且关闭语含结论 |

### 5.3 负控制要求（沿用仓内惯例）

仓内既有惯例（见 tri-issue 方案 §2.5、#545/#546 的关闭结论）：新增断言必须配**负控制**——即「把修复撤掉/把不变式打破，对应用例必须变红」，并在 PR 里写明是哪条用例变红。本方案的负控制最低要求：

| 批次 | 必须有的负控制 |
|---|---|
| **P1** | ① `filesWithSuffix` 改回 `readdirSync` 递归 ⇒ 事实层复算与 git 口径不等；② `uiSrcFiles` 去掉 `.js/.jsx` ⇒ `undocumented` 从 17 退回 12；③ `lib` 恢复按目录名豁免 ⇒ `ui/src/lib/` 的 ts 重新消失 |
| **P2** | ① `baselineKey` 改回不含行数 ⇒ 6 条超基线用例必须红；② 把一个指标基线调低 ⇒ 棘轮断言必须红 |
| **P3** | 撤掉「超时即空注入」⇒ 超时用例必须红（断言「注入为空**且**不抛」，而非仅「不抛」） |
| **P4** | 撤掉「单条 `workspace_state` 即可重建」断言 ⇒ 冷读用例必须红；构造「无变化写入」⇒ 断言 transcript 字节数不增长 |
| **P5** | 跳过表去掉 `.pnpm-store` ⇒ 节点数断言必须红；`/commits` 换回 N+1 spawn ⇒ 断言 spawn 次数为 1 的用例必须红；缓存去掉上限 ⇒ `size ≤ 500` 用例必须红 |
| **P6** | clone 不传 options ⇒ `requireOutputSchema` 用例必须红；去掉 MCP 豁免 ⇒ MCP 注册用例必须红；信任门 memo 不按签名失效 ⇒ 「内容变化后重算」用例必须红 |
| **P7** | 去掉实例缓存 ⇒ 断言 `load()` 调用次数为 1 的用例必须红；`retired` 改回每成员一查 ⇒ 断言 SQL 次数为 1 的用例必须红 |
| **P8** | `cloneMessage` 换回 JSON 深拷贝 ⇒ 「`undefined` 字段保留」用例必须红 |

---

## 6. 风险与决策分叉

### 6.1 需要事先拍板的分叉（建议已给出）

| # | 分叉 | 选项 | 本方案建议 | 理由 |
|---|---|---|---|---|
| 1 | **#541 的三项各自做不做** | (a) 删 `lookup()` (b) 抽共享存储层 (c) barrel 收敛 | **(a) 本批做；(b) 不做；(c) 不做** | (b) issue 自设触发条件是「下次改动这两个 store 之一，或需要新增第三个」——**今天不满足**；且两段 diff 实测 172 行、语义差异大（`store.ts` 另有 `forget`/`pickSmaller`/`mergeModelWindowEntry`）。(c) 实测 196 个导出中 84 个模块外零消费（issue 写 92），但**收益为 0 且是公开面变更**（须走决策记录），成本最高 |
| 2 | **#535 是否顺带优化投影全文累积** | (a) 只做一行替换 + 文档更正 (b) 顺带优化 `block.text += event.text` 与快照复制 | **(a)** | 已核实 (b) 是**伪优化**：`structuredClone` + 2 次 stringify ≈ 1.1 µs/事件（2000 个 delta 约 2.3 ms CPU）；真实成本中心在投影全文累积（`InProcessGateway.ts:1307`）与快照整段复制（`:853-868`），那是改数据结构的重构，**超出本 issue 登记范围**，应另立条目 |
| 3 | **#532 的 MCP 豁免口径** | (a) 给 MCP 工具补宽松 `outputSchema` (b) 按 `kind === "mcp"` 豁免严格位 | **(b)** | 已核实：MCP 结果形状**不可声明**——`src/mcp/client/operations.ts:46` 是 `content: unknown`，`structuredContent` 被丢弃、`toToolSpec` 不透传服务器 schema ⇒ 宽松 schema 只能**恒真**（把「无契约」伪装成「有契约」）。(b) 是 1 行且诚实；透传服务器侧 schema 留作后续刀 |
| 4 | **#528 的回填范围与是否加门禁** | (a) 只回填已核实的条目 (b) 逐条复算全部 304 条 (c) 把判据做成门禁 | **(a) 闭环本 issue；(c) 先做报告型（`--warn`）** | 复核发现 issue 的「8 条下界」含 **3 条误报**（真实下界 5 条）；(b) 的判据只剩「逐条读代码」（221 条 `new` 中 **206 条不挂 issue 号**），实测 **25–50h**。门禁侧两条判据已验证可行，但**口径必须先钉死**——两套独立实现对同一文件得出终态 **71 vs 20**（差 3.5 倍），故第一步只能是 `--warn` |
| 5 | **#530 的两处口径盲区是否同批修** | (a) 同批修 (b) 另立条目 | **(a)，且在棘轮之前** | 盲区（`ui/src` 的 `.js/.jsx` 未扫描、`EXCLUDE_DIRS` 的 `lib` 按目录名豁免吞掉 `ui/src/lib/`）直接决定棘轮的**基线取值**——棘轮若建立在漏算的 12 上，会把漏掉的 5 处永久合法化。**不修盲区就上棘轮 = 把错误冻结**，这正是把 P1/P2 拆开的原因 |
| 6 | **#538 的「跳过 `node_modules` 哈希」** | (a) 跳过子目录 (b) 只做 memo + `blocked` 原因结构化 | **(b)**；(a) **不做** | 决策记录 `docs/notes/implemented/2026-09-21-project-hook-trust-gate.md` 把「整树内容摘要」定为信任单位（command 可引用目录内脚本）⇒ 跳过子目录会推翻该决策；且「clone 安装的插件是常态」**无本仓证据**（`src/extension/` 无插件 install 通道）。死角应通过「`blocked` 原因可区分 + 面板提示」解决 |

### 6.2 残余风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **棘轮化会让合法增长变红**（P2） | 任何使文件变长、使指标回退的 PR 都要显式承认（`--update-baseline` / `measure:update`） | 这正是设计意图（把静默增长变成需要写进 PR 的承认动作）；但要在决策记录里写明「如何承认」与「棘轮值可上调的条件」，否则会被当成噪音绕过——**而顺手刷新正是棘轮要治的行为** |
| **P1 改 git 口径会让「未提交的新文件」即时改数** | `git ls-files --cached --others --exclude-standard` 含未跟踪但未忽略的文件 ⇒ 本地新增一个 `.ts` 会立刻改变 `src_module_list` 与指标 | 与 `measure-techdebt` 现有口径**一致**（这本身就是对齐的目的）；但必须在决策记录里写明「本地有未跟踪文件时 `--check` 会看到什么」，否则下一个人会在自己机器上撞见「门禁说 stale 而我没改过」 |
| **P4 改 transcript 写入格式** | transcript 是所有能力面共用的 durable 载体（续算扫描、全量读取、备份、搜索） | 必须保留「单条 `workspace_state` 即可重建」的自足性（PR #378 的既有结论），显式覆盖「新会话冷读」「resume 冷读」「周期锚点」三条路径，且不动 durable 边界（`recordEntry` 批写 / `flushCheckpoint` 语义） |
| **P3 触及 vendored 子包** | memory-core 是独立 pnpm workspace 包，有独立 build/typecheck/test，metrics 明文列为「不随本仓演进」 | **不改子包**：abort 落点固定在仓内适配层 `src/context/memory/EdgeClawMemoryProvider.ts` |
| **P6 的 memo 无声弱化信任判据** | 若失效键只覆盖「mtime 变」而漏掉「内容变但 mtime 回填」，缓存会返回过期摘要，而信任门**恰好是安全边界** | 失效键用 `sha256(rel+size+mtimeMs)`；**必须补「mtime 回填 + 内容变」用例**（现有测试只覆盖两种更简单的情形）；`blocked`/读失败**不入缓存**；`decide` 绕 memo 重算 |
| **P9 的「假回填」** | 逐条复算 304 条的判据是读代码，机械化会生产形式主义勾选 | 先只回填**有证据**的条目，并在条目里写明证据（issue 关闭结论 + commit/PR）；不追认历史日期（沿用 §37.5 约定）；机械判据先 `--warn` |
| **14 条被 stale 静默归档** | 见 §1.3——P2/P3 且无 milestone 者在 2026-12-21 起标 `stale`、2027-01-20 起自动关闭 | 执行 P1 时统一改 `status: in-progress`；若跨年则挂下个版本 milestone |
| **本方案自身成为漂移源** | 方案里的行号会随代码前进而过时（`docs/technical-debt/next-batches-schedule.md` 就是前车之鉴，已被取代） | 全部数字标注基线 commit；每批次落地后回来勾选并写实测数字；若方案被后续方案取代，在文件头写明取代关系（`docs/issue-management.md` §6.1 第 3 条） |

---

## 7. 议题关闭清单（全部批次落地后执行）

按 `docs/issue-management.md` §7「关闭纪律：留一句结论」——关闭语必须含**根本原因 / 处置 + PR/commit + 决策记录链接**，且 `Closes #<n>` 写进对应 PR（合并即自动关闭，这是最省事也最不易遗漏的方式）。

| # | 关闭语必须包含 |
|---|---|
| 520 | 口径选择的理由（git 口径 vs 纯文件系统复算）+ `docs/code-facts.md` 刷新后的新值（316 → 98）+ 「同一提交在三种环境复算得同一值」的实测 |
| 527 | `baselineKey` 语义变更 + 棘轮后 6 条超基线文件的处置（本次追认 +136 行的显式记录）+ 决策记录链接 |
| 530 | 口径修正的修正值（12 → 17）与新基线 + 棘轮断言落点 + 为何选棘轮而非 eslint 规则（决策记录） |
| 536 | 非阻塞化的形态（后台检索 + 下一轮注入）+ abort 落点（仓内适配层，**未改 vendored 子包**）+ 新增超时用例名 |
| 537 | 快照策略（自足 + change token 去重 + 周期锚点）+ 三条读取路径的验证证据 + 与 PR #378 决策记录的关系（说明为何「只落增量」再次被否决） |
| 533 | 跳过表补 `.pnpm-store` + 实测节点/耗时前后对比（59,297 → 6,658 / 621ms → 67ms）+ **层②已拆独立议题**的编号 |
| 534 | 合并为单次 `git log --stat` + 解析按 header 正则（含 merge 无空行这一边界）+ 新增 `/commits` 用例 + 耗时前后对比 |
| 529 | 4 张缓存的 FIFO 上限（复用 `MAX_ACTIVE_SESSIONS`）+ **为何不做「按会话删除」**（唯一调用方取历史会话、无会话结束钩子）+ `backlog.md:1321` 行号更正 |
| 538 | memo 的失效键设计（`sha256(rel+size+mtimeMs)`，为何仅进程内、为何只缓存 hashed）+ `blocked` 原因结构化的落点 + 「未跳过 `node_modules` 哈希」的理由（不推翻 1.2a 决策） |
| 532 | MCP 豁免口径的决策（为何不用恒真 schema）+ **四处**（含 `SubAgentSession.ts:173`）同批修 + 「共享 MCP 工具不再被吞」的证据 + 定级上调的说明 |
| 531 | 实例缓存形态（为何不用反向扫：`seenDedup` 幂等 + 键序两条理由）+ `retired` 一次查询 + 键序不变的回归断言 |
| 535 | 一行替换（并说明语义差异已核：共享引用 + `content: undefined → []`）+ `TD-GATEWAY-003` 登记文字更正（删「可能无人读」、行号改 `:1268-1283`） |
| 541 | `lookup()` 已删除（而非改注释）+ 3 个测试文件同步 + **骨架共享与 barrel 收敛未做**及其理由（触发条件未满足 / 收益为 0） |
| 528 | 回填范围与证据标准（含「8 条下界实为 5 条、3 条系误报」的更正）+ 4 条描述在原节正文的更正 + #520 已补载体 + 「最后复核」字段落实情况 + 机械判据是否上线的结论 |

**账本同步**：14 条对应的账本条目（§1.1 表）须同 PR 改状态（`new` → `done` + commit/PR）、补「最后复核：YYYY-MM-DD」，并为 #520 新建载体。**注意** `backlog.md:2225`（§37.4）的「上述条目仍标 `new`」对 `TD-SESSION-N01`/`TD-ROUTER-001`/`002` 三条不成立，须一并更正。

---

## 8. 决策与备选（相对「逐条独立修」的取舍）

- **为什么把批次排成「先门禁、再爆雷、后卫生」而非按 P2/P3**：优先级只表达「损害级别」，不表达「修复的杠杆」。门禁失真（P1/P2）会让**下一个 P2 的判断本身**出错，属元级问题；审计报告 §Summary 的结论同此——「『门禁有效性』与『账本新鲜度』是本轮暴露的系统性弱项……建议优先于任何单点实现债务处理」。
- **为什么 P1 与 P2 拆开**：棘轮冻结基线值，而 #530 的口径修正要把基线从 12 抬到 17。合并成一个 PR 会让「棘轮生效」与「口径变更」两件事在同一份 diff 里互相掩护——**这恰好是 #530 自己描述的失效形态**（基线被顺手刷新，无人知道哪次是修正、哪次是侵蚀）。
- **为什么把 14 条聚合成 9 个 PR 而不是 14 个**：唯一的聚合依据是**共享生成物 / 共享门禁 / 共享测试面**（P1+P2 共用度量族与棘轮语义；P5 三条共用 `ui/server` 测试面；P6 两条共用「缓存不得伪装成新鲜」的决策）。其余保持一条一 PR。**拒绝「一个大 PR 全修」**：14 条跨 8 个功能域，回滚粒度会退化为「全有或全无」。
- **为什么 #533 只做层①**：issue 定义的债务是「跳过表遗漏 `.pnpm-store`」，层①（1 行）即还清并拿掉 88.8% 的节点；层②（首屏懒加载）需要新增 children 路由 + 两处客户端改造（`FilesV2` 与 @ 提及共用同一深树），是**跨端重构**而非还债。把它塞进本批会让「一个 S 的卫生工作变成 L 的功能开发」，也让回滚粒度失真。⇒ 拆独立议题。
- **为什么 #541 只做 `lookup()` 删除**：issue 自设的抽共享层触发条件是「下次改动这两个 store 之一，或需要新增第三个」——今天不满足；且两段 diff 实测 172 行、两实体语义差异大（`store.ts` 另有 `forget`/`pickSmaller`/`mergeModelWindowEntry`）。barrel 收敛（196 个导出中 84 个模块外零消费）**收益为 0 且成本最高**（公开面变更须决策记录）。
- **为什么 P9 的门禁化只做报告型**：`docs/issue-management.md` §6.1 与 `backlog.md` §37.5 已就「回填质量无法机械化」给出一致立场（做成校验器只会生产形式主义勾选）。本方案在此基础上**往前一步但不越界**——两条判据（终态条目须带证据引用、条目块须含「状态：」字段）经实测确实可机械判定，但两套独立实现对同一文件得出终态 **71 vs 20**，证明**口径未钉死前任何数字都不可信**。⇒ 先 `--warn`、先定口径、看数字稳定性，再决定是否升级为阻塞门禁。
- **为什么不做「顺便把已关闭议题的遗留也清了」**：本方案严格覆盖 open 议题。审计报告 §被下调/排除的候选已排除 8 条已修条目与 3 条数量级失准条目，扩大范围会让「什么算完成」失去判据。
- **备选：把 P5 前移**。若产品近期有面向用户的版本发布，`ui/server` 三条的体感收益最直接（文件视图首屏 621ms → 67ms、git 面板 130ms → 17ms）。本方案把它排在 P3/P4 之后，依据是「硬故障 > 渐进劣化 > 体感」；若发布窗口临近，P5 可整体前移，只须避开 P2（见 §4.1 的基线交叉）。
- **备选：P4（#537）可延后**。它的开关 `SATI_WORKSPACE_LEDGER_ENABLED` **默认关**，属「开关一开就爆」的条件债；若近期不会把账本转默认开，可把它排到最后（但不可遗忘——它的硬故障形态是「账本永久不可用」，不是渐进劣化）。

---

## 9. 执行台账（交付即回填）

> 按 `docs/issue-management.md` §6.1「交付即回填」：每批次落地后回来把状态改为 ✅、补 PR/commit 与**实测数字**（不是计划数字）、并注明与计划的实施差异（差在哪要写清，不要只翻状态）。若本方案被后续方案取代，在**文件头**写明取代关系。

| 批次 | 议题 | 状态 | PR / commit | 实测数字（落地后填） |
|---|---|---|---|---|
| **P1** | #520 · #530（口径） | ✅ **已交付**（CI 全绿） | [PR #557](https://github.com/xujian519/sati/pull/557) · `f04b23fc1` | `src/context` **316 → 98**；`undocumented` **12 → 17**（总计 671 → 678 · 已注释 659 → 661）；`ui/src` 576 / 92,914 → **589 / 94,379**；`vendored` 保持 49 / 16,682（边界未放宽） |
| **P2** | #527 · #530（棘轮） | ✅ **已交付** | [PR #558](https://github.com/xujian519/sati/pull/558) · `110438f9` | `file-size` 棘轮首刷追认 **6 条 / 合计 +136 行**（`types.ts` +73 · `InProcessGateway.ts` +29 · `useChatRealtimeHandlers.ts` +20 · `sati.ts` +7 · `useSessionStore.ts` +5 · `AppShellV2.tsx` +2）；新增 `docs/technical-debt/thresholds.json`（`catchEmpty.total`=0 · `catchNoParam.undocumented`=17）；`check-architecture-boundaries.test.mjs` 10→**12** 例、`measure-techdebt.test.mjs` 35→**43** 例 |
| **P3** | #536 | ✅ **已交付** | [PR #559](https://github.com/xujian519/sati/pull/559) · `4a42b15a6` | 首 token 最坏阻塞 **30s → 注入预算 2s**（缺省，可配 `memory.injectionBudgetMs`）；`DefaultContextRuntime.ts` **902 → 953（+51）**——P2 file-size 棘轮上线后**第一次在真实功能 PR 上转红并被显式 `--update-baseline` 承认**（打印 Δ）；`src` TS 行数 180,729 → 180,846；新增测试 **8 例**（`memory-nonblocking.spec.ts` 3 + builder 超时/中止 2 + provider abort 竞速 3） |
| **P4** | #537 | ✅ **已交付** | [PR #560](https://github.com/xujian519/sati/pull/560) · `813a56523` | 写侧从「每笔变更落全量快照」改为「**每 K=32 笔变更落一次自足锚点 + 其间落 O(1) 的 note 增量**」；累计增长由 **O(n²) → ~O(n²/K)**。实测：**N=100 笔笔记 → 4 个 `workspace_state` 锚点 + 96 条 `workspace_state_delta`**（`≤ ⌈N/K⌉+1`），冷读（新 store 全量重放）与热读（游标续扫）结果一致；**N=K+2=34 → 2 锚点 + 32 增量**跨过再锚点边界。读侧用**同一纯函数 `applyWorkspaceNote`** 重放增量，未新造重放语义（直接回应 PR #378「须定义重放语义」的关切）；保留「单条 `workspace_state` 即可重建」自足性、保序、不动 durable 边界。`src` TS 行数 180,846 → **181,005（+159）**；新增测试 **11 例**（`workspace-ledger-store.spec.ts` 9→19 例含 10 条 #537 用例 + `workspace-note.spec.ts` 6→7 例 note 透传）。**与计划的实施差异见下方「P4 的实施差异」** |
| **P5** | #533① · #534 · #529 | ✅ **已交付**（CI 全绿） | [PR #561](https://github.com/xujian519/sati/pull/561) · `2d49fd679` | **#533（层①）**：跳过表补 `.pnpm-store` + 点开头包管理器缓存通则，判据抽成零依赖叶子模块纯函数 `shouldSkipEntry`（直测真函数，避开 `filesystem.js`→`src/patent` 在 vitest/jsdom 下加载失败）；首屏 **621ms → 67ms**、节点 **59,297 → 6,658**（`.pnpm-store` 占 88.8%）。**#534**：`/commits` 由 per-commit 串行 `git show --stat`（N+1 子进程）合并为单次 `git log --stat` + 纯函数 `parseCommitLogWithStats`（**按 header 正则切块**，非空行——merge commit 的 stat 段缺失且无尾随空行）；**130ms → ~17ms**（limit=10）、**1,140ms → ~43ms**（limit=100）。**#529**：新增 `setBounded(map,key,value,limit=MAX_ACTIVE_SESSIONS)` FIFO 上限套用到 4 张 bridge 缓存（复用 `sessionState` 的 500 常量）；**未做** issue 原文的「mtime 失效删键」（唯一调用方取历史会话、无会话结束钩子）。新增测试 **19 例**（`fileTreeSkip` 6 + `git` +8=13 + `sati-bridge` +5=21，均含负控制）。`backlog.md` TD-UISERVER-N02 行号更正 `:1237/1319/1435/1529`→`:1470/1556/1672/1756` 并标 done、N04 标 done。**与计划的实施差异见下方「P5 的实施差异」** |
| **P6** | #538 · #532 | ✅ **已交付**（CI 全绿） | [PR #562](https://github.com/xujian519/sati/pull/562) · `3dfa31373`（两 commit：`b737c1be` #538 / `f9be4e15` #532） | **#538**：信任门**可见性**路径（报告/面板）加进程内 memo（按 walk 签名 `rel+size+mtimeMs` 失效，跳过 readFile+哈希）；**强制路径（会话装配装载/授权决策）仍走纯内容哈希、绕过 memo**（签名不含内容，喂给强制路径会无声弱化信任门，违背 2026-09-21「mtime 不是信任判据」决策）；`blocked` 原因结构化（`over_limit` vs `unsafe_content`）透传到面板本地化 + decide reason。**不做**「跳过 `node_modules` 哈希」（会推翻「整树内容摘要=信任单位」决策，分叉 6=b）。**#532**：`ToolRegistry` 新增 `registryOptions` getter，三处派生表（`clone()`/`filterAvailableTools`/`SubAgentSession.buildScopedRegistry`）**同批**透传 `this.options` 恢复 fail-loud 严格位；`register()` 对 `kind === "mcp"` 豁免严格位（MCP 结果形状不可静态声明，补宽松 schema 只能恒真=伪装契约）⇒ 项目级共享 MCP 工具不再被 `ProjectRuntimeRegistry:438→:447` 静默吞掉。新增 `output-schema-validation.spec.ts`（clone/filter 保严格位 + MCP 豁免，三条负控制逐一验证变红）；`outputSchema` 不进 `toolSchemaDigest` ⇒ 不触发 llm-replay 重录。见 `docs/notes/implemented/2026-09-24-hook-trust-digest-memo.md` · `2026-09-24-tool-registry-strict-bit-mcp-exemption.md` |
| **P7** | #531 | ✅ **已交付**（CI 全绿） | [PR #563](https://github.com/xujian519/sati/pull/563) · `e8c1b7919`（feature `0421ff71`） | **TD-TEAM-N09**：`TeamShare` 进程内**实例缓存**（模块级 `Map<path,{mtimeMs,size,inst}>` + 工厂 `getTeamShare`/`writeTeamShare`/`clearTeamShareCache`，按 `(mtimeMs,size)` 失效——黑板非安全边界，statSync 远比 readFileSync+逐行 JSON.parse 便宜，且比 TTL 精确无可见性延迟）；同一路径连续派发/读取 ⇒ `load()` 只跑一次。**不用** issue 备选「`summary()` 反向扫尾部取 10 key」（破坏 `load()` 重建的 `seenDedup` 幂等全集 + `summary()` 首次出现键序两条契约）。**TD-TEAM-N10(a)**：面板退休判定改 `listRetiredSessionKeys()` 一次查回建 Set（SQL 由 O(成员)→**1**）+ `groupByTeam` 把 members/tasks 各按 teamId 分组一次（O(团队×成员)→O(团队+成员)）；**N10(b) 授权面不改**（T6 评审刻意取舍，留作多用户化前升 P1 复核）。新增测试 **5 例**（team-share 4 含「退回每次 new 则红」负控制 + teamPanel 1 spy 断言 `isRetired` 调 **0** 次）；`team_share_updated` 发出点位移已 `gen:event-matrix` 回填。`src` TS 181193→**181303**。见 `docs/notes/implemented/2026-09-24-team-read-amplification.md` |
| **P8** | #535 · #541 | ✅ **已交付**（CI 全绿） | [PR #564](https://github.com/xujian519/sati/pull/564) · `d42ad2df5`（feature `4478e176`） | **#535**：删除 `readSessionMessages.ts` 局部 `JSON.parse(JSON.stringify)` 版 `cloneMessage`，改 import 共享 `cloneMessage`（`src/model`）——语义更优（`structuredClone` 保留显式 `undefined` 字段，JSON 拷贝会丢），内容块逐块克隆、metadata 共享引用（下游 `flattenCanonicalMessage` 只读故安全）。`TD-GATEWAY-003` 仅更正登记不改行为（开销 ~1.1µs/事件、缓冲有完整消费链，照字面删除会破坏重连恢复）。**#541**：删两处零生产调用者的 `lookup()` 死方法（`ModelWindowStore`/`HookTrustStore`，每次调用整表 readFileSync+parse + 误导注释），4 个测试文件 9 处调用点改 `read().entries[key(...)]`。**不做**①抽共享存储层（issue 自设触发条件「下次改动这两个 store 之一或新增第三个」今天不满足）②barrel 收敛（公开面变更、收益 0 成本最高）。新增 `clone.spec.ts` **7 例**（含「保留显式 undefined」负控制，退回 JSON 拷贝即红）。`src` TS 181303→**181289**、tests 606→**607**。见 `docs/notes/implemented/2026-09-24-clone-message-and-dead-lookup.md` |
| **P9** | #528 | 🔄 **在途**（本 PR · 合并即 `Closes #528`） | 本 PR（`docs/528-ledger-backfill`） | **回填条数**：① 5 条状态滞后条目翻 `done`/`不立项` + 代码证据 + 最后复核（`TD-METRIC-001`#339、`TD-METRIC-002`#340、`TD-PROCGATE-004`#336 并更正位置 `workflows/stale.yml:37`、`TD-PATENT-N13` 口径收敛单一实现、`TD-SMALL-N01` TTL 回收）；② 4 条描述失准在**原节正文**更正（`TD-CONTEXT-N03`→done#536、`TD-KNOWLEDGE-N02`/`TD-CRON-N01`→不立项前提证伪、`TD-GATEWAY-003` P8 已更正）；③ 为 **#520 新建载体 `TD-PROCGATE-010`**（§37.6，此前账本零命中）；④ P1–P8 落地的 14 条对应条目全部翻 done/partial + PR/commit（body：`TD-SESSION-N02`#537、`TD-TEAM-N09`#531、`TD-TEAM-N10`partial、`TD-UI-APP-N06` 降 P3；§37.1 表：`TD-PROCGATE-008`#527、`TD-PROCGATE-009`#528、`TD-UISERVER-N11`#533；§37.3 表：`TD-CATCH-001`残留#530、`TD-UISERVER-N02`#529、`TD-UISERVER-N04`#534、`TD-WEB-N01`+`TD-GATEWAY-003`#535、`TD-CONTEXT-N03`#536、`TD-SESSION-N02`#537、`TD-UI-APP-N06`#533）；⑤ 更正 §37.4 注（「8 条下界」含 3 条误报 `TD-SESSION-N01`/`TD-ROUTER-001`/`002`⇒真实 5 条；原「仍标 new」对三条不成立）。**`--warn` 判据**：**未采纳**（可选判据，不在 #528 验收内——`check:techdebt-metrics` 已由 #340 挂 lint 链尾承载新鲜度门禁，另建 `--warn` 脚本属重复）。 |

**P1 的实施差异（计划 vs 实际）**：

| 计划写的 | 实际做的 | 差在哪 |
|---|---|---|
| `tests/scripts/doc-claims.spec.ts` 补「fixture 断言」 | 改为**独立复算 + 上界负控制**（不走被测解析器） | 更强：fixture 只能锁住解析器的输出形状，独立复算能锁住**口径本身**（符合 `docs/development-standards.md` §6「验证世界，不是自述」） |
| `gitListedFiles` 需「兼容 tsx/dist 双加载面」 | 通过**不 import** `measure-techdebt.mjs` 实现（各自同源实现） | 计划未料到 `.mjs` 不进 `tsc` 产物、`dist/` 下解析会失败；已记为决策记录备选 3 |
| `catchNoParam.total` 预估 671 → 679 | 实际 671 → **678** | 预估误差 1（预估按「+5 处无注释 + 4 处有注释」推算，实际为 +5 无注释 + 2 有注释） |
| （未列） | 连带更新 `SCOPE_DOC` 的 `catch` / `vendored` 条目与 `README.md` §指标口径说明 | #341 先例的硬要求：口径变更须与基线刷新、口径说明同 PR 落地，否则下一个人只看到数字变了 |
| （未列） | 方案文档本身随第一个 commit 入库 | 上一轮交付物，与实现同 PR 便于对照 |

**议题关闭进度**（`Closes #<n>` 合并即自动关闭；关闭语要求见 §7）：

| # | 520 | 527 | 528 | 529 | 530 | 531 | 532 | 533 | 534 | 535 | 536 | 537 | 538 | 541 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 状态 | ✅ | ✅ | 🔄 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

> ✅ = 已合并关闭。🔄 = 已有在途交付。#520 由 [PR #557](https://github.com/xujian519/sati/pull/557) 交付并已合并（`Closes #520` 自动关闭）。#530 的**口径段**由 PR #557 交付、**棘轮段**由 P2（[PR #558](https://github.com/xujian519/sati/pull/558)）交付，该 PR 写 `Closes #530`，已合并关闭。#527 由 P2 同一 PR 写 `Closes #527`，已合并关闭。#536 由 P3（[PR #559](https://github.com/xujian519/sati/pull/559) · `Closes #536`）交付并已合并关闭。#537 由 P4（[PR #560](https://github.com/xujian519/sati/pull/560) · `Closes #537`）交付并已合并关闭。#533（层①）· #534 · #529 由 P5（本 PR · `Closes #533 #534 #529`）交付，在途。

**P3 的实施差异（计划 vs 实际）**：

| 计划写的 | 实际做的 | 差在哪 |
|---|---|---|
| §2.3.3 / §3.3：非阻塞化选「**后台检索 + 下一轮注入**」 | 选「**注入预算（缺省 2s）+ 后台预热**」：预算内命中本轮即注入，超预算才退到下一轮 | 计划字面选项会让 composite 里**所有** provider 在某 query 首轮（且常是唯一一轮）一律空注入——单轮问答拿不到任何记忆/知识。注入预算保留「快路（缓存命中 / 同步 FTS·DB）本轮即注入」，只对真正慢的冷检索退后台，严格优于纯后台。已就地征询并采纳「预算 + 后台预热」 |
| §2.3.3：「到期即有则注入」被否决（「需给检索加预算，会与 provider 30s TTL 缓存打架」） | 采纳其**收益**、去掉其**副作用**：预算到期只「停止等待」、**不 abort**，内层后台跑完写缓存供下一轮 | 「打架」只对**会 abort 的预算**成立（abort 丢弃结果 ⇒ 缓存永不暖）。把「停止等待」与「中止工作」解耦后二者不再冲突——这是本批的核心决定，详见决策记录 |
| §3.3：abort「在 `EdgeClawMemoryProvider` 内做竞速并在熔断后丢弃内层结果」 | 逐字落地：新增 `raceAbort`，中止后 fail-soft 空结果、**不写缓存 / 不落 pendingRetrievals / 不计错误遥测**，幽灵 inner 迟到结算被空 catch 吞掉 | 与计划一致；额外补「不污染 TTL 缓存」的显式断言（陈旧结果注入后续回合是 issue 未点明的次生危害） |
| §3.3 门禁联动：`pnpm measure:update`（`src/context/` 行数变化） | 跑了 `measure:update`，**并额外撞 P2 file-size 棘轮**：`DefaultContextRuntime.ts` 902 → 953（+51），按棘轮承认动作 `--update-baseline` 追认并打印 Δ | 计划未预料本批会触发**自己上一批刚立的棘轮**——这是棘轮上线后第一次在真实功能 PR 上转红，正好示范它期望的「合法增长须显式写进 PR」形态（详见决策记录 Consequences） |
| （未列） | 连带 `pnpm gen:event-matrix`：`sessionDependencyAssembly.ts` 加 1 行配置透传使 `elicitation_requested` 的 `file:line` 从 `:242` → `:243` | AGENTS.md 铁律 5：跨行移动后事件矩阵须重生成（纯行号位移，无语义变化） |
| （未列） | 新增配置项 `memory.injectionBudgetMs`（进 `KNOWN_FIELDS` + `readOptionalPositiveInteger` 解析 + `sessionDependencyAssembly` 透传） | 让预算成为可运维旋钮而非硬编码；计划只提「给检索加预算」未指定配置面 |

**P4 的实施差异（计划 vs 实际）**：

| 计划写的 | 实际做的 | 差在哪 |
|---|---|---|
| §2.3 / §3.4：#537 根因是「**缺少变更令牌去重**，同一 note 重复落全量快照」 | 核实为**前提过期**：变更令牌去重**早已存在且有测试**（`applyWorkspaceNote` 对无变化写入返回 `changed:false`，`WorkspaceNoteTool` 仅在 `changed` 时写）。真正未修的根因是 **`verified` append-only 使每份快照 O(n)、累计 O(n²)**，撞 `DEFAULT_MAX_TRANSCRIPT_READ_BYTES=50MB` 后账本永久 `unavailable` | 计划照抄了 issue 的旧诊断；实测去重已就位，故把范围重定到「**全量快照的二次增长**」这一真因——这是本批相对计划/issue 原文的主要增量 |
| §3.4：修法方向「周期锚点 + 增量」，但增量载荷未定 | 增量载荷选 **note 本身**（`WorkspaceNoteInput`），读侧用**同一纯函数 `applyWorkspaceNote`** 重放 | 不新造重放语义（不复刻状态机、不引入 state-diff 合并规则），直接复用既有纯函数——**正面回应 PR #378「须定义重放语义」的关切**：语义就是既有那套 |
| §3.4 硬约束（PR #378）：单条 `workspace_state` 须自足、不得只落增量、不得反向扫、不动 durable 边界 | 全部保留：锚点仍是**完整自足快照**（单条即可重建，有负控制用例）；增量**只在两锚点之间**、且锚点周期性刷新；仍**顺序正向扫**；增量走既有 `recordEntry` 批写路径，`flushCheckpoint` 语义不变 | 与硬约束一致；额外补「delta 在任何锚点之前出现 → 跳过并返回 undefined」的防御用例（冷启动态不臆造基座） |
| §3.4 门禁联动：`pnpm measure:update` | 跑了 `measure:update`（`src` TS 180,846 → 181,005）；**未**触发 file-size 棘轮（改动分散在多个既有小文件，无单文件越过 800 行/基线） | 与 P3 不同：本批增量小且分散，棘轮无需承认动作 |
| （未列） | 连带 `pnpm gen:event-matrix`：`InMemoryTranscriptWriter.ts` 新增方法使 `file_artifacts` 的 `file:line` 从 `:73` → `:79` | AGENTS.md 铁律 5：跨行移动后事件矩阵须重生成（纯行号位移，无语义变化） |

**P5 的实施差异（计划 vs 实际）**：

| 计划写的 | 实际做的 | 差在哪 |
|---|---|---|
| §3.5 表头：「三条同属 `ui/server`（JS，**`node --test`**）」 | 实测 `ui/server` 的 29 个 `*.test.js` **全部用 vitest**（`import { describe, expect, it, vi } from "vitest"`），`node:test` 命中数 = 0；由 `cd ui && pnpm test`（`vitest run`，默认 include 覆盖 `ui/server/**`）驱动 | 计划的「`node --test`」是**过期前提**（与 P4 的「缺去重」同型）；新测试一律写成 vitest，落 `ui/server/**` 既有测试面 |
| §3.5 ①：把跳过判据抽成纯函数 `shouldSkipEntry(name)`「以便直测」 | 抽成**独立零依赖叶子模块** `ui/server/services/fileTreeSkip.js`，`filesystem.js` 导入并再导出 | 计划未料到 `filesystem.js` 的传递依赖链经 `routes/projects.js` 拉到 `src/patent/...`，在 vitest/jsdom 下 `import.meta.url` 解析失败（`The URL must be of scheme file`）而无法加载 ⇒ 判据必须落在**不 import 任何东西**的叶子文件里才能直测真函数（否则只能像 `isSatiSessionKey.test.js` 那样手抄副本、与实现漂移） |
| §3.5 ②：`stats` 与旧实现「逐条等价」 | 逐条等价，**但归一了一个前导空格**：旧 `git show --stat --format=` 经 `.trim().split("\n").pop()` 会在摘要行残留一个前导空格，新 `parseCommitLogWithStats` 按行 `trim()`。解析器落在**零依赖叶子** `ui/server/utils/gitCommitLog.js`，`git.js` 导入之 | 唯一行为差异、纯外观（前端文本渲染折叠前导空白）；测试显式归一后断言内容等价，并在 note 记明。header 正则用 `{40,64}` 兼容 SHA-256（计划写 `{40}`）。抽叶子的动意见下方「file-size 棘轮」行 |
| §3.5 ③：新增 `setBounded(map,key,value,limit=500)` 套用 4 处 | 落在**零依赖叶子** `ui/server/utils/boundedMap.js`，签名 `setBounded(map,key,value,limit)`（**无默认值**——上限是调用方策略），`sati-bridge.js` 导入并在 4 处**显式传 `MAX_ACTIVE_SESSIONS`**；单测移到叶子测试 `utils/boundedMap.test.js`（5 例），`sati-bridge.test.js` 回到 16 例 | **与计划有出入**：计划设想 `setBounded` 就地留在 `sati-bridge.js` 并导出作测试缝；实际因 file-size 棘轮（见下行）把它抽到叶子，`limit` 改为必传、由调用方显式给常量。`sati-bridge.js` 虽在 node 环境可导入，但抽叶子让它对本特性净增仅 1 行 import |
| （未列）file-size 棘轮：`git.js`/`sati-bridge.js` 是 `architecture-baseline.json` 存量豁免文件（基线 1529 / 2347），规则「豁免文件不得再增长」 | 就地新增两个 helper 会让 `git.js` +29、`sati-bridge.js` +32 双双越线 ⇒ 改为把 `parseCommitLogWithStats`、`setBounded` 抽到零依赖叶子（`utils/gitCommitLog.js`、`utils/boundedMap.js`）。结果 `git.js` **净减 22 行**（1529→1507），`sati-bridge.js` 净增 **1 行 import**（2347→2348），仅这 1 行用 `--update-baseline` 追认 | 计划把 #534 记成「减少 `git.js` 行数、无冲突」，但未预见 #529 的 `setBounded` 会让 `sati-bridge.js` **增长**触棘轮。抽叶子既守住棘轮意图（不让两个最大文件膨胀），又让两个纯函数获得可直测的叶子测试——`--update-baseline` 只承认 1 行 import，而非 32 行就地膨胀 |
| §3.5 ③附注：`backlog.md` TD-UISERVER-N02 行号更正 | 更正为当前 HEAD `:1470/1556/1672/1756` 并标 done；连带把 TD-UISERVER-N04（#534）也标 done | 计划只点了 N02；N04 同为本批交付，顺手一并回填（符合「交付即回填」）。2026-08-27 复核记的「候选路径枚举 4 份逐字复制」共享 helper 抽取**未做**，明确记为残留子债（与容量上限正交） |
| §4.1：P5 应在 P2 之后（#534 减少 `git.js` 行数与 2 处无参 catch，与 #530 基线交叉） | 已满足：P5 在 P2（PR #558）合并后开工；本 PR 跑 `pnpm measure:update` 刷新基线 | 与计划的硬依赖一致 |

**分诊动作（逐批次启动时做）**：批次启动时把该批议题改 `status: triage` → `status: in-progress`（`docs/issue-management.md` §3 的「推进」动作），并同时豁免 `stale.yml` 的自动归档。

> **实施修正（P1 落地时发现，已按实际做法执行）**：本方案原建议「执行 P1 时把 14 条**一并**改 `status: in-progress`」——落 P1 时**没有那样做**，只把真正在途的 #520 / #530 标为进行中。理由是：把 14 条都标成「进行中」而实际只做 2 条，正是本方案要治的**状态失真**（与 `docs/issue-management.md` §1 反对的「标签说完成、议题还开着」同型，只是方向相反）。
>
> stale 风险并未因此上升：批次计划在 **6–9 个工作日**内推进完，远早于 90 天阈值；且每批次启动都会有活动（PR 引用 / 评论）自动摘掉 `stale`。若某批次确实被推迟到跨年，再给对应议题挂下个版本 milestone（`exempt-all-milestones: true`）。

#532 若采纳 §0.3 第 3 条的定级异议，在该批次启动时把 `priority: p3` → `priority: p2`。

**衍生条目（本方案识别、需另立议题）**：

| 来源 | 内容 | 建议 |
|---|---|---|
| #533 层② | 文件树首屏懒加载（新增 children 路由 + `FilesV2` 与 @ 提及两处客户端改造） | 新开 `enhancement`/`tech-debt`（scope: ui），标注「不阻塞 #533 关闭」 |
| #532 后续刀 | 把 MCP 服务器侧 schema 透传到 `outputSchema`（今天 `structuredJsonSchema` 被丢弃） | 待 MCP 契约稳定后再评估 |
| #535(b) | 投影全文累积（`block.text += event.text`）与快照整段复制的优化 | 新开条目，独立评估（本方案已判定为伪优化之外的真成本中心） |
| #528 后续项 | 逐条复算并回填 221 条 `new` 条目（实测 25–50h） | 拆为分批后续项，**不作为 #528 的验收条件** |
| #520 | 为它在 `backlog.md` 补账本载体 | P9 内完成（不另立议题） |
