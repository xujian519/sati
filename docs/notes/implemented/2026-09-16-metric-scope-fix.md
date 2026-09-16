# Agent Note: 债务指标口径修正（catch 纳入 ui/server、vendored 子包单列）

Status: implemented

## Problem

`scripts/measure-techdebt.mjs` 是债务排期的**唯一数字来源**（`pnpm measure:update` 生成
`metrics.md`；`pnpm lint` 链尾的 `check:techdebt-metrics` 保证它不静默失真）。它有两处口径
缺口，都会让排期建立在假数字上。

**一、catch 口径漏掉整个 `ui/server`**（105 文件 / 31,483 行的独立后端）。

`metrics.md` 长期报「空 `catch {}` = **0**」，而 `ui/server/utils/plugin-loader.js:299` 实有
一处（临时目录 `rmSync` 清理失败静默）。同为「错误 & 可观测」类的 `console`（158 处里
`ui/server` 占 5）与 `todos` 早已含 `ui/server`，**catch 独缺**——同一份报表里两套口径
自相矛盾。

核账更正：issue #341 引用的「catch 口径 = `src + ui/src` 产品代码」是**如实声明**
（`docs/code-refinement-plan.md` §六 基线表的口径），故这不是「实现与文档不一致」，而是
**口径本身就选错了**——它声称描述「本项目维护的代码」，却把 105 文件、31K 行的本仓后端排除
在外。这条更正决定了处置方向：不该去改文档迁就口径，而该改口径。

**二、`edgeclaw-memory-core` 污染文件级排名。**

它是从外部项目整体搬入的记忆内核（自带 `package.json` / `tsconfig` / 独立 `build`·`test`，
本仓不参与其演进），却占 `src` 的 **9.0% 行数**（49 个 `.ts` / 16,682 行），并在
「Top 大文件」与「God function」两张**排期表**里各占 3 席：

- Top 大文件：`sqlite.ts` 1711 / `llm-extraction.ts` 1624 / `file-memory.ts` 1139
- God function：`run` 524 / `retrieve` 484 / `runHeartbeat` 477

这两张表的用途是「挑下一个要拆的文件 / 函数」，混入非本仓维护的代码直接误导排期（读表的人会
以为 `sqlite.ts` 是待拆候选）。

核账更正第二处：issue 把 `lib/`（编译产物）与 `ui-source/app.js`（2324 行，`/memory-dashboard`
资产）也列为污染源，实测**两者自脚本首版起就由 `EXCLUDE_DIRS` 的目录名豁免覆盖**
（`ui-source/app.js` 从未进过 Top-30，`ui-source` 出现在脚本首版提交 `4d83bda7f`）。真正在
污染的只有 `src/` 与 `tests/` 下那 49 个 `.ts`。

## Decision

`scripts/measure-techdebt.mjs`：

1. **catch 口径纳入 `ui/server`**。`productCatchFiles` 由 `[...src, ...ui/src]` 改为
   `[...src, ...ui/src, ...uiServerScan]`，`SCOPE_DOC.catch` 同步改写并标注变更日期。
   `catchEmpty` 与 `catchNoParam` 由**同一个** `productCatchFiles` 喂入——两者要么一起含
   `ui/server`、要么一起漏，这正是本次要消除的自相矛盾。
2. **vendored 子包按路径前缀整体移出文件级指标，并单列**。新增导出常量
   `VENDORED_SUBTREES = ["src/context/memory/edgeclaw-memory-core"]` 与导出纯函数
   `isVendored(relPath)`；`measure()` 里 `src/` 先取全量再分流为「受管」与「vendored」两组，
   后者进入新的 `vendored` 分组并由 `renderMarkdown` 渲染成独立一节。

两条实现要点：

- **`isVendored` 按「路径段」而非「字符串前缀」匹配**（`relPath === p || relPath.startsWith(p + "/")`）。
  字符串前缀匹配会把 `edgeclaw-memory-core-extra/` 这类同前缀兄弟目录判为子包内文件，从而把
  真实本仓文件从排期表里**静默抹掉**。
- **「单列」而不是「删除」**。`vendored` 分组报出该子包的规模（文件数 / 行数）、自身 Top 5
  大文件与 ≥300 行函数数——「已单列」与「该目录被删了」必须在输出上可区分，否则口径变更会
  静默退化成数据丢失。

顺带的机械整理：把 God function 扫描从 `main()` 移进 `measure()`。此前 `--json` / `--check` /
`--update` 三条路径都要先在 `main()` 里补算一次 `m.godFunctions`，且它与「Top 大文件」的
文件集各自写了一遍（一个在 `measure()` 里、一个在 `main()` 里）。移入后两条路径拿到同一份
结果，函数级与文件级指标不可能各自漂移。

## Alternatives considered

- **只补 `catchEmpty` 口径、不动 `catchNoParam`** — 落选：两者由 `measure()` 里**同一个**
  `productCatchFiles` 喂入，拆开就得复制一份文件集常量，而重复的文件集正是下一处漂移点；
  且「无注释的无参 catch」才是真正的治理目标（`TD-CATCH-001` / #353），漏掉 `ui/server`
  会让该目标低估 84 处。
- **口径不动，只在 `README.md` 里写明「catch 不含 `ui/server`」** — 落选：那是把 bug 转成
  说明书（同 #355 的判例——文档准确、行为错误时，要改的是行为）。写清楚口径并不能让
  「空 catch = 0」从假数字变成真数字。
- **`ui/server` 与 `src`/`ui/src` 分列成两行指标，不合并** — 落选：分列不回答「总数是多少」，
  读者仍要自己相加；`console`/`todos` 都是合并单行口径，再加一种呈现形态只会让口径表更难读。
- **vendored 子包整体删除（不进任何指标、也不单列）** — 落选：那是数据丢失。该子包 16,682 行
  的体量与 3 个 god function 对「记忆内核要不要重构」仍有参考价值，单列节保留了这份可见度。
- **只把 vendored 从两张排名表移出，按处计数指标（catch / console / any / todos）保持含它**
  — 落选：文件级过滤只需一处，全部文件级指标自然一致；只改两张表会造出第三套口径，而
  per-module 热点榜（`topModules` 取前三）同样用于排期——`context` 模块的数字混着子包内外
  两部分代码，读不出该先动谁。
- **用启发式（`package.json` 存在性 / 目录名特征）自动识别 vendored** — 落选：本仓只有一棵
  这样的子树，显式清单比启发式规则更可预测、新增时也更容易被看见；启发式在将来引入真正的
  本仓子包（monorepo 化）时会误判。
- **顺带把 God function / Top 大文件的口径也改成「产品代码」（排除 `*.spec.*` / `*.test.*`）**
  — 落选（本次不做）：两张表当前都含测试文件（God function 3 项匿名箭头函数 842 / 409 / 384；
  Top 30 里 `MessagesPaneV2.render.test.tsx` 1013 行），确有同型的「排期对象混入」问题，但测试
  文件属于本仓、只是不在排期范围内，与 #341 的两点不是同一件事。合并进来会让本 PR 同时承担
  两类口径变更、掩盖主题；已登记 `TD-METRIC-004` 另行立项。
- **保留 `godFunctions` 在 `main()` 中计算** — 落选：三条 CLI 路径都在 `main()` 里补算，
  意味着 `measure()` 的返回值本身**不是**完整度量，函数级指标与文件级指标各有一份文件集
  （`allSrcAndUi` vs `measure()` 内部），是下一条口径漂移的温床。而且测试无法对
  `m.godFunctions` 下判据，只能 spawn CLI。

## Consequences

**换来**：口径与本仓维护的代码一致；「空 `catch {}`」不再是假 0；两张排期表不再被外部子包
挤占；`--json` / `metrics.md` 由同一份 `measure()` 结果产出。

**付出（一次性跳变，跨此日期的同比须按同口径重算）**：

| 指标 | 旧口径 | 新口径 | 差值来源 |
|---|---|---|---|
| 空 `catch {}` | 0 | **1** | +1 `ui/server` |
| 无参 `catch {`（总计） | 517 | **684** | +175 `ui/server` − 8 vendored |
| ↳ 无注释（隐患类） | 40 | **124** | +84 `ui/server`（vendored 8 处均已带注释） |
| ↳ 已带意图注释 | 477 | **560** | +91 `ui/server` − 8 vendored |
| `as unknown as` | 27 | **26** | −1 vendored |
| src TS 文件 / 行数 | 1078 / 186146 | **1029 / 169464** | −49 / −16682 vendored |
| Top 30 大文件 / God function 席位数 | 各含 3 项 vendored | 各 **0** 项 | vendored 单列 |

**连锁影响**：#353（37 → 0 的无注释无参 catch 治理）的目标数按新口径为 **124**（其中
`ui/server` 84 处），其「回升超过 45 即立项专项」的触发条件随之满足——已在该 issue 上留结论
评论说明。这是**口径变更而非新增债务**。

**仍未覆盖（已登记）**：

- `TD-METRIC-004`：God function 与 Top 大文件两张表含测试文件（God function 3 项匿名箭头
  函数、Top 30 里 `MessagesPaneV2.render.test.tsx` 1013 行）——同型的「排期对象混入」，但测试
  文件属于本仓，是另一件事。
- `ui/src` 的 `.js` / `.jsx`（`main.jsx`、`TaskSettingsContext.jsx` 等）仍未进入任何文件级
  扫描——C39 收束时已记录，本次未变。

## 相关

- issue #341 · 台账 `docs/technical-debt/backlog.md` §32 · `TD-METRIC-003`（本 note 关闭该条）
- 口径说明：`docs/technical-debt/README.md` §指标口径说明（新增 2026-09-16 段）
- 基线：`docs/technical-debt/metrics.md`（按新口径重新生成，含新增「vendored 子包」节）
- 相邻条目：`TD-CATCH-001` / #353（目标数随本次口径变更上调至 124）、`TD-METRIC-004`（新增）
