# Agent Note: 度量口径对齐 git 清单与路径前缀豁免

Status: implemented

## Problem

两处口径失真，都会让事实层与门禁给出**与代码不符的信号**。它们同属「数字的取得方式错了」，而不是「数字本身变了」。

### 一、`src/` 模块文件数把依赖声明与编译产物算成模块源码（#520）

`scripts/doc-claims/resolvers.ts` 的 `srcModuleList()` 用 `filesWithSuffix()`——`readdirSync` + `statSync` 递归、**不跳过忽略目录**、后缀判定是 `endsWith(".ts")`（于是 `.d.ts` 也算命中）。`docs/code-facts.md` 的「`src/<模块>/` .ts/.tsx 文件数」因此把 `node_modules` 下的第三方声明与 vendored 子包 `lib/**/*.d.ts` 算成了模块源码。

同一棵树（提交 `963b3e518`）在三种环境下的实测值：

| 环境 | `src/context` 计数 |
|---|---|
| 主 worktree：已 `pnpm install` + 子包已 build | **316**（= 当时入库值；CI 也是这一态） |
| 只装了依赖、子包未 build | 280 |
| 干净检出（`git worktree add` 后什么都没跑） | **98** |

316 的拆解：本仓自身源码 **49** + vendored 子包源码 **49** + 子包 `lib/**/*.d.ts`（未跟踪的编译产物）**36** + `node_modules` 下第三方声明 **182**。即 **218/316（69%）不是本仓源码**。

后果分两层：

1. **事实本身失真**——读者得到「该模块有 316 个源文件」这一错误结论（`docs/code-facts.md` 是入库的、受门禁覆盖的事实层，`CLAUDE.md` 与各指南以它为唯一事实源）。
2. **门禁假红**——`check:doc-claims` 挂在 `pnpm lint` 尾，任一环境与入库值不符即报 stale，**而树没有问题**。此时「让门禁变绿」的顺手做法是把本机算出的数写回仓库，等于把**本机环境状态固化进事实层**，下一个人再撞一次——这正是 `docs/technical-debt/README.md` 警惕的「以未核数字替换未核数字」。

### 二、`lib` 按目录名豁免吞掉同名源码目录；`ui/src` 的 `.js/.jsx` 不在任何扫描面（#530）

`scripts/measure-techdebt.mjs` 的 `EXCLUDE_DIRS` 按「**任意层级的目录名**」豁免，其中 `lib` 把 `ui/src/lib/`（4 个 `.ts` + 1 个 `.js`，真实源码）整体吞掉；同时 `uiSrcFiles` 的后缀集合只收 `.ts/.tsx`，`ui/src` 的 9 个 `.js/.jsx`（`main.jsx`、`contexts/*.jsx`、`i18n/config.js`、`utils/api.js` 等）也不在任何文件级扫描里。

后果：「无注释的无参 catch」（`TD-CATCH-001` 的治理目标）少算 **5 处**——报表给 12，真实 17；`ui/src` 规模少算 13 个文件 / 1,465 行。两处盲区还叠在同一个文件上（`ui/src/lib/utils.js`）。

### 两处都是 #341 自己留下的尾巴

`docs/notes/implemented/2026-09-16-metric-scope-fix.md` 的 §仍未覆盖 明确登记：

> `ui/src` 的 `.js` / `.jsx`（`main.jsx`、`TaskSettingsContext.jsx` 等）仍未进入任何文件级扫描——C39 收束时已记录，本次未变。

同一份 note 还把「`lib/`（编译产物）与 `ui-source/` **本就由 `EXCLUDE_DIRS` 的目录名豁免覆盖**」当作正面事实记录——而**正是这条目录名豁免**在另一头误伤了同名的源码目录。同一个机制在一处是保护、在另一处是遮蔽，这是本次要一并处理的形状。

## Decision

### 1. 模块文件数改走 **git 清单**（#520）

`scripts/doc-claims/resolvers.ts` 新增 `gitListedFiles(root, suffixes)`：

```js
execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", root], { cwd: REPO_ROOT })
  → 过滤：路径前缀 → 后缀命中且非 .d.ts → 无点开头目录段
```

`srcModuleList()` 的 `fileCount` 由 `filesWithSuffix(.ts) + filesWithSuffix(.tsx)` 改为 `gitListedFiles([".ts", ".tsx"]).length`；`filesWithSuffix` 保留给 `skills/**/SKILL.md` 统计（那里没有忽略目录问题）。生成的模块表下补一句口径注记，让读者不必翻脚本就知道这列数的是什么。

选 git 口径的三条理由：① 与 `scripts/measure-techdebt.mjs` 自 #340 起的口径**同源**（同一条命令、同样排除 `.d.ts`）；② 与 AGENTS.md 已声明的「按 `git ls-files` 统计」一致；③ **一次消除两类漂移**——`node_modules` 与子包 `lib/` 都不在 git 清单里。

### 2. `lib` / `ui-source` 由「目录名豁免」改为「**路径前缀豁免**」（#530）

`EXCLUDE_DIRS` 只保留**产物类**目录名（`node_modules` / `dist` / `.pnpm-store` / `coverage` / `.git` / `.reasonix` / `.qoder` / `.codegraph` / `test-results`）。新增：

```js
const EXCLUDE_PATH_PREFIXES = [
  "src/context/memory/edgeclaw-memory-core/lib",
  "src/context/memory/edgeclaw-memory-core/ui-source",
];
```

`listFiles()` 的过滤链末端加 `.filter(p => !isPathExcluded(p))`（精确到**路径段**，故不误伤 `libx/`、`library/`）。

### 3. `uiSrcFiles` 后缀补 `.js` / `.jsx`（#530）

`ui/src` 的全部产品源码进入扫描面。`godFunctions` 与 `scanTypeEscapes` **自身**按扩展名跳过非 `.ts/.tsx`（已核实），故函数级与类型逃逸指标不受影响——只有 catch / TODO / 行数三类随之修正。

## Alternatives considered

- **只跳过 `node_modules` 并让 `.d.ts` 不算 `.ts`（不动 git 口径）** — 落选：子包 `lib/**` 的 36 个编译产物仍在计数里，仍随「子包编没编译」漂移，issue 自认「只做这条不算还清」。
- **把 vendored 子包整体移出该行（照 #341 的排期表先例）** — 落选：要一次改 30 行数字且引入第二套「可见 / 不可见」口径；子包源码本来就是本仓 git 跟踪的一部分，移出会让事实层与 AGENTS.md 的「按 `git ls-files` 统计」声明不一致。
- **从 `resolvers.ts` 直接 `import` `measure-techdebt.mjs` 的 `listFiles()`（真复用代码）** — 落选：`measure-techdebt.mjs` 是 `.mjs`，**不进 `tsc` 产物**；而 `resolvers.ts` 既可能从 `scripts/doc-claims/`（tsx 直跑）也可能从 `dist/scripts/doc-claims/`（`pnpm test` 跑编译产物）加载 ⇒ 跨文件引用在 dist 下解析失败。改为**同源口径、各自实现**，两处注释互相指向。
- **给 `lib` 加白名单例外（`ui/src/lib` 不豁免、其余照旧）** — 落选：仓内还有 `scripts/lib`、`skills/<skill>/scripts/lib`、`apps/desktop/scripts/lib`；「与编译产物同名」这个形状会随新目录反复出现，白名单只会让下一个人再踩一次，且踩了不会有人发现（少算不会报错）。
- **`lib` 完全不豁免** — 落选：子包 `lib/` 的 36 个 `.js` 会进入 `srcScanAll`，随后被 `VENDORED_SUBTREES` 判为 vendored ⇒ `vendored.files` 虚增 36，单列节的规模统计失真（「编译产物」混进「子包源码规模」）。
- **只改 `uiSrcFiles` 后缀、不动 `lib`** — 落选：`ui/src/lib/customNames.ts:31` 的 1 处无注释无参 catch 仍被吞，且 `ui/src` 规模仍少 4 个文件。两条盲区必须同批修，否则「真实值」仍不对。
- **顺带把 `uiSrcFiles` 也喂给 `godFunctions` / `scanTypeEscapes`** — 不必：两者自身按扩展名跳过，`.js/.jsx` 不会进入 AST 扫描；若将来要覆盖它们，应各自显式声明 `ScriptKind`，而不是靠后缀集合隐式影响。
- **在 `metrics.md` 的报表里注明「本数字不含 `ui/src` 的 js」而不是改口径** — 落选：那是把 bug 转成说明书（同 #355 的判例：文档准确、行为错误时，要改的是行为）。且 `console` 口径早就含 `ui/server` 的 `.js`，注记只会让两套口径的矛盾变得「有据可查」而非消失。

## Consequences

**换来**：模块文件数在**任何环境复算得同一值**（装了依赖、编没编译子包都不改变它）；`ui/src` 的全部产品源码进入扫描面；「无注释无参 catch」的治理目标从错误的 12 修正为 **17**；两个既有护栏（`check:doc-claims` 的假红、`check:techdebt-metrics` 的漏算）不再各自说谎。

**付出（一次性口径跳变，跨此日期的同比须按同口径重算）**：

| 指标 | 旧口径 | 新口径 | 差值来源 |
|---|---|---|---|
| `src/context/` 文件数（`docs/code-facts.md`） | 316 | **98** | −182 `node_modules` 声明 − 36 子包 `lib/**.d.ts` |
| `ui/src` 文件 / 行数（`metrics.md`） | 576 / 92,914 | **589 / 94,379** | +9 个 `.js/.jsx`（+1,119 行）+ 4 个 `ui/src/lib/*.ts`（+346 行） |
| 无参 `catch {`（总计） | 671 | **678** | +7（`ui/src` 114 → 121） |
| ↳ **无注释**（隐患类，目标） | **12** | **17** | +5 |
| ↳ 已带意图注释 | 659 | **661** | +2 |
| `as unknown as` / 裸 `console.*` / God function / Top 大文件 | — | **不变** | 三者自身跳过非 `.ts/.tsx`，或本就含 `.js` |

**未变的边界（刻意）**：vendored 子包的 `lib/` 与 `ui-source/` **仍不在扫描面内**（只是改为按路径豁免）——`vendored.files / lines` 保持 **49 / 16,682**，子包源码仍由 `VENDORED_SUBTREES` 单列。这条由新增的负控制用例守住。

**新增护栏**：

- `tests/scripts/doc-claims.spec.ts`：① 逐模块的计数必须等于**独立复算**的 git 清单值（不走被测解析器）；② `src/context` 的上界断言——口径退回文件系统遍历时，本机（有依赖 + 有 `lib/`）立刻越界。
- `scripts/measure-techdebt.test.mjs`：① `ui/src/lib` 的源码可见、`.js/.jsx` 在扫描面内；② **子包编译产物仍被路径前缀挡住**（负控制：证明本次没有放宽 vendored 边界）。

**连锁影响**：

- `TD-CATCH-001`（#530 / #353）的读数由 12 更正为 **17**，其「回升超过 45 即立项」的触发线不变（仍按 45 读）；账本条目与该 issue 的描述须按新口径回填（已在实施方案的 P9 登记）。
- `git` 口径含「未跟踪但未被忽略」的文件 ⇒ 本地新增未 `git add` 的 `.ts` 会即时改变 `src_module_list` 的计数。这与 `measure-techdebt` 的行为**一致**，是刻意对齐；代价是「本地有未跟踪文件时 `--check` 会看到差异」，已在 `gitListedFiles` 的注释里写明。
- 本 PR **只做 #530 的「口径」段**；其「棘轮」段（`measure-techdebt.mjs --check` 增阈值断言、`--update-baseline` 打印本次追认的增量）按实施方案拆到 P2——顺序有意：棘轮冻结基线值，而本次口径变更把基线从 12 抬到 17，先上棘轮会把漏算的 5 处永久合法化。

## 相关

- issue **#520**（本 note 关闭）· issue **#530**（本 PR 交付其口径段）
- 先例与尾巴：`docs/notes/implemented/2026-09-16-metric-scope-fix.md`（#341，本 note 修掉它 §仍未覆盖 登记的一半）
- 事实层：`docs/code-facts.md`（`src/context` 316 → 98，并补口径注记）
- 基线：`docs/technical-debt/metrics.md`（按新口径重新生成）
- 实施方案：`docs/open-issues-remediation-plan.md` §3.1（P1）
