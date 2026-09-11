# Agent Note: C42 终审——指标口径统一到度量工具

Status: implemented

## Problem

保守档精炼（42 张日卡）收尾时暴露一个比「某指标达没达标」更前置的问题：**度量工具与文档是两套口径**。

- `scripts/measure-techdebt.mjs` 的 `measure()` 把 `[...srcTs, ...srcJs]` 喂给**全部**指标，于是 console / unsafe / catch / todos 一律只扫 `src/`；而 `docs/code-refinement-plan.md` §六 基线表声明的是 `src + ui/server`（console）、`src + ui/src`（any、catch）、`src + ui + ui/server + tests`（TODO）。
- 后果已经在两张卡上兑现两次：C41 量到无参 catch 403（工具）vs 518（基线表），C40 的 any 同理，两张卡都只能**先自建一次性扫描重建口径**再定目标；C41 的 note 把这条债显式登记给了 C42。
- 同一批指标里还有两处语义缺陷：`any` 用裸正则匹配，**既高估**（注释/字符串里的英文单词 "any"）**又低估**（泛型位 `Record<string, any>` 的文本是 `, any>`，不含 `: any`）；`catchSilent` 定义为「体仅注释/空白」，把**已由函数 JSDoc 说明意图的防御式**与**真无任何说明的静默回退**混计——`docs/technical-debt/README.md` 据此写下「真实隐患 151 处」的结论，而 C41 独立核实后该数字站不住。

不先解决这些，终审报告里的「达标/未达标」就是不可复现的断言。

## Decision

1. **指标作用域按基线表对齐并显式化**。`measure()` 为每个指标构造独立文件集（console 含 `ui/server`、unsafe 含 `ui/src`、catch 限定产品代码、todos 含 `tests`），并输出 `scopes` 字段；`metrics.md` 顶部自动带「指标口径」表。口径变化不再靠人记，而是随产物一起发布。
2. **`any` 改 TS AST 精确统计**（`scanTypeEscapes`：类型位 `AnyKeyword` 节点 + `@ts-(expect-error|ignore)` 指令）。脚本本就依赖 `typescript`（`godFunctions` 已有 AST 机制），无新增依赖。结果 **3**，恰为 C40 逐处 `SAFETY` 登记的保留清单——机器指标与人工清单互为交叉验证。
3. **废弃 `catchSilent`，改为「无注释的无参 catch」**（`scanNoParamCatch`）。判定「有注释」认三种形态：catch 行内、catch 上一行、体内（独立注释行或**代码行尾注释**）。落地的扫描器以 C41 的独立验证分类做等价性校验，得 `518 / 无注释 37 / 已注释 481`，**逐数相同**。
4. **console 保留「上界 + 豁免清单」**：正则仍会计入注释里的同名文本，故只豁免两处 C39 刻意建立的收束入口（`ui/server/utils/consoleLogger.js`、`ui/src/utils/logging.ts`——它们体内就是转发，计入即定义性错误），并在文档里明说 158 是上界、真实裸调用为 143。
5. **终审报告改为「快照」，事实源交给活账本**。`docs/code-refinement-report.md` 整篇重写为 42/42 终态；同时在报告与 `docs/technical-debt-report.md` 顶部声明二者的历史快照**退出事实源地位**，持续维护以 `docs/technical-debt/backlog.md` + `metrics.md` 为准。
6. **口径断点显式标注**：`metrics.md` 按新口径重新生成，其跨 2026-09-11 的同比在 README、终审报告、技术债注记三处均标注「须按同一口径重算」。

## Alternatives considered

- **只改报告、不改工具（把口径债继续往后留给下一轮）** — 落选：C41 的 note 已把这条债登记给 C42；且报告若不同时修工具，其数字无法用 `node scripts/measure-techdebt.mjs --json` 复现，等于换一种方式继续写不可验证的断言。
- **给现有指标打补丁（保留 `catchSilent`，另加一个 `catchUndocumented`）** — 落选：保留一个语义混淆的指标会持续被误读——README 的「真实隐患 151 处」正是它产出的结论。指标的价值在于能被信任，不在于向后兼容。
- **用去注释的方式消除正则误报（console/unsafe 通用解法）** — 落选：正则剥注释要在字符串、模板字面量、正则字面量上同时正确，写错的方向是**低估**（把真隐患抹掉），对危险指标而言是失败模式最差的一侧。改用「上界 + 显式豁免」：宁可多报也不漏报。而 `any` 有现成 AST 可用，故只对 `any` 走到精确口径。
- **把 C41 的临时扫描器单独建成 `scripts/measure-catch-hygiene.mjs`** — 落选：会分裂出两个指标入口，季度刷新（`--update metrics.md`）必然漏跑一个；catch 的计数与注释卫生天然同源，应同处一个脚本。
- **重算 2026-08-27 的 `metrics.md` 快照以维持同比连续** — 落选：旧快照的口径本身是错的，按错口径重算没有意义；正确做法是承认断点并在三处文档显式标注，让下一轮用同一口径建立新的趋势基线。
- **把 `metrics.md` 的重生成留给季度刷新** — 落选：不重生成则该文档仍印着已废弃的 `catchSilent` 行，与同 PR 改写的 README 口径说明自相矛盾，读者无从判断哪份是当前口径。
- **console 指标也纳入 `ui/src`**（与 any/catch 同作用域）— 落选：基线表与 C39 的收束记录都按 `src + ui/server` 定义该指标，且 ui/src 已收束至 0，纳入只增加噪声不改变结论。

## Consequences

**换来**：

- 指标单一事实源——工具的 `scopes`、`metrics.md` 的「指标口径」表、计划 §六 基线表、README 口径说明四处一致，下一轮取卡可直接用 `--json` 的数字定目标，不必再自建扫描。
- `any` 首次有了**可复现且与人工登记完全一致**的精确值（3）；三处注释假阳性（`SnipEngine.ts:64`、`continuationRequest.ts:22`、`ui/src/utils/unknown.ts:5`）与一处正则漏报（`ToolRenderer.tsx:111`）被同时暴露并修正。
- catch 的治理目标（无注释隐患类）可被 `node scripts/measure-techdebt.mjs --json` 直接读出，C41 补注释的成效（125 → 37）可复现。
- 终审报告的任何数字都能用 §八 的复现命令重跑验证。

**付出**：

- `metrics.md` 出现一次跨版本断点（0.1.12 前后不可直接相减），已在三处文档标注为「须按同一口径重算」；真正的连续趋势要等下一轮在同口径下刷新。
- 度量脚本增约 140 行、单次运行约 2.3s（TS AST 遍历全仓）；`godFunctions` 已是同量级开销，未造成新的量级变化。
- console 指标仍是上界而非精确值（158 vs 143），存在已知且已声明的偏差；这是为避开「去注释正则可能低估」而有意付出的代价。
