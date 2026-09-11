# Agent Note: C41 —— 无参 catch 意图注释治理与 TODO/FIXME 核实

Status: implemented

## Problem

日卡 C41 的目标是把「无参 `catch {`（src + ui/src）」这一指标显著降下来，并把 `TODO/FIXME` 存量核实到 ≤5。执行前必须先回答三个前提，否则任何改动都缺少判据：

1. **哪一类 catch 才是隐患。** 基线表把该指标描述为「含防御式（有注释）与隐患（无注释）两类」，但仓内没有任何可复现的分类口径。`scripts/measure-techdebt.mjs` 的 `catchNoParam` 只扫 `src/`（与基线表声明的 `src + ui/src` 不一致），`catchSilent`（体仅注释/空白）又把**已在函数 JSDoc 里说明过意图**的防御式与**真正没有任何说明**的静默吞错混在一处——按它治理是在治一个假目标。
2. **指标能不能靠行为不变的手段降下来。** `catch {` 的计数只有在**删除** try/catch、或把 `catch {` 改成 `catch (e) {`（纯为凑数，代码更差）时才会下降。前者只在「try 体可证不抛」时成立，而本仓这些 catch 体几乎全是 `JSON.parse` / `fs.*` / `new URL` —— 都是会抛的操作。因此「显著下降」在保守档里不可能按字面完成；真正可完成、也真正有风险价值的是**消灭「无注释」这一隐患类**。
3. **TODO 指标被什么污染。** 全仓（排除 `node_modules/dist/vendor`）`TODO|FIXME|HACK` 命中 83 处，其中 66 处在 `docs/`（规范文档本身在讲 TODO 约定）、5 处在 `scripts/`（检测 TODO 的工具自身）、其余多为**字符串字面量/正则/占位符里的同名文本**（提示词里的 `'TODO' wording`、JSDoc 示例里的 `base64,XXX`、`DEFAULT_FUZZY_TODOS` 正则）。按纯 grep 计数会把它们全算成待办。

## Decision

**分类口径固定为三层，以「是否静默」为分界线。**

一个无参 catch 被判为**需补注释**，当且仅当：体内既无 `throw`、也无日志/遥测调用（即它是静默的），且其回退语义无法从**紧邻的函数级 JSDoc** 读出、也无法由**体内自述式告警信息**（如 `warnings.push({ message: "规则目录不存在" })`）读出。

按此口径实测（`src + ui/src` 产品代码，排除同目录 `*.spec/*.test`）：

| 分类 | 数量 |
|---|---|
| 无参 `catch {` 总计 | 518 |
| 已带意图注释（体内/行尾/行内） | 374 |
| 无注释 | 144 |
| ├ 错误转译（体含 `throw`，自身即说明） | 11 |
| ├ 体内有日志/遥测 | 8 |
| └ **真静默吞错** | **125** |
| 　 ├ 已在函数级 JSDoc 或自述式告警中说明 | 18（登记不重复注释） |
| 　 └ **本卡补体内意图注释** | **107** |

**已落地的改动**：为 107 处真静默吞错各补一行体内注释，统一写成「失败模式 → 回退语义」的形态（如 `// 凭据文件缺失或损坏 → 视为未配置（fail-safe，调用方提示重新登录）。`），**仅新增注释行，零代码改动**（`git diff --numstat` 为 79 文件 +107/−0，且 107 行全部以 `//` 开头）。

**TODO/FIXME 核实结论**：代码侧真实标记 **2 处**，均核实为**仍然有效**，不改动语义：

- `ui/vite.config.js:27` —— “未来大版本移除 legacy `PORT` 变量支持”。核实：下一行仍为 `env.SERVER_PORT || env.PORT || 3001`，legacy 路径在用，标记成立。
- `tests/development-standards/verify-config.spec.ts:46` —— `TODO(G1-b/G1-c, …§7 第 2 步)`。核实：`docs/development-standards.md` §7 第 2 步的 `G1-b/G1-c` 两项仍为未勾选，占位成立。

另修正一处**长期制造审计误报**的注释：`ui/src/components/chat/tools/configs/toolConfigs.ts` 的区块分隔注释原为 `// TODO TOOLS`，语义是「Todo 工具族」（TodoWrite/todo_write/TodoRead，与同文件的 `// COMMAND TOOLS`/`// CRON TOOLS` 同构），却每次都被 `\bTODO\b` 计入。改为 `// Todo-list 工具族（TodoWrite / todo_write / TodoRead）` 并加一行说明。

## Alternatives considered

- **把 try/catch 抽成 `tryOr(fn, fallback)` 一类的 helper，让 `catch {` 计数真正下降。** 落选：这要在 100+ 个调用点改变控制流形态（有的要 `continue`、有的要赋局部变量、有的要 return 具体对象），属于**改行为面**的重构，与保守档「仅执行无行为变化的清理」直接冲突；且一旦抽错，失败会被搬到 helper 里、更难定位。收益（一个更好看的数字）与风险不成比例。
- **把无参 `catch {` 一律改成 `catch (e) {`，让指标归零。** 落选：这是纯粹的指标游戏——没有一个 `catch` 会因此多出信息，却让每个未使用的 `e` 触发 lint 告警或需要 `void e`。指标的价值在于指向风险，不在于归零。
- **对 125 处（含已在函数级 JSDoc 说明的 18 处）一律补体内注释。** 落选：冗余。例如 `SkillManager.statIsDirectory` 上方已写明「断链 / 不可读的 symlink 视为非目录（fail-safe 跳过）」，再在体内写一遍是噪声，会把「有注释」这个信号稀释掉——而本卡的目的恰恰是让该信号可信。
- **把 518 处无参 catch 全量补注释。** 落选：其中 374 处已有意图注释，11 处是错误转译（`throw` 本身即说明），8 处已落日志。全量重写等于用 500 行 diff 换 0 信息。
- **保留 `// TODO TOOLS` 分隔注释，改为修 `measure-techdebt.mjs` 的 `TODO_PATTERN` 以过滤误报。** 落选：可过滤的是「字符串字面量/正则里的同名词」（`base64,XXX`、提示词、`DEFAULT_FUZZY_TODOS`），但分隔注释是**注释里的真实单词**，与真标记 `// TODO: Remove support…` 在词法上无法区分——除非把规则收紧到能漏掉真待办。误报的根因是这个**具体注释的用词**，就在源头改一处最省。
- **只出审计报告、不做任何改动。** 落选：那会把 107 处「看起来吞了错、但没人知道为什么」的代码原样留给下一个读者；本卡存在的意义就是消掉这一类。

## Consequences

- **换来**：`src + ui/src` 无参 catch 的「无注释静默吞错」从 125 降到 18，且剩余 18 处逐条可指到说明位置；`TODO/FIXME` 的真实标记从「83 命中」收敛到 2 处有效项，后续审计不再被分隔注释误报。分类口径与三层判据固化在本 note，可复现。
- **付出**：79 个文件 +107 行注释，属**跨文件行号位移**——`docs/event-producer-consumer.md` 的事件矩阵按 `file:line` 硬编码，已 `pnpm gen:event-matrix` 重生成（8 行变更，归一化行号后逐字节零差异，证明纯位移）。这也是本卡唯一的非注释产物。
- **零行为变化的证据**：对全部 79 个改动文件，用 TypeScript `transpileModule({ removeComments: true })` 分别编译 `HEAD` 版与工作树版，**79/79 产物逐字节相同**。这比抽样测试更强——注释不可能改变编译产物。
- **未处理并登记**：11 处错误转译（`catch { throw new XError(...) }`）与 8 处带日志的 catch 保持原样——它们不静默，无需意图注释；`ui/vite.config.js:27` 与 `verify-config.spec.ts:46` 两条 TODO 经核实有效，保留原样。
- **遗留口径问题**：`measure-techdebt.mjs` 的 `catchNoParam`/`catchSilent` 作用域仍只覆盖 `src/`，与基线表的 `src + ui/src` 声明不一致，且 `catchSilent` 语义会把「已注释的防御式」计为「静默」。本卡未改工具（避免与 C40 刚定的 any 口径同批改动叠加），建议随 C42 终审一并修正。
