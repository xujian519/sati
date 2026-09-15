# Agent Note: 桌面端运行时布局接线的重复收口（铺陈 + vstore 重链）

Status: implemented

## Problem

issue #348 的描述是「把 pnpm 的 virtual store 布局重建成可运行的运行时目录这套逻辑在**三处**
各写了一遍」。核代码后发现：**这是两组互不相干的事，共 5 个站点、4 个文件**，而 issue 的
散文措辞与它自己引用的行号指向的是不同的东西。

| # | 站点 | 做什么 | 语言 | 在谁的路径上 |
|---|---|---|---|---|
| 1 | `apps/desktop/src/server-manager.ts` `resolvePaths()` 内联块 | **铺陈**：`dist`/`src`/`node_modules`/`memory-core` 五条链接 | TS | **运行时**（用户机器） |
| 2 | `apps/desktop/scripts/lib/packaged-runtime.sh` `pd_runtime_extract_bundles()` 尾部 | 同上（同一组链接） | shell | L2/L3 验证 |
| 3 | `apps/desktop/scripts/verify-dmg.sh` Step 6 | 同上（同一组链接） | shell | L1 验证 |
| 4 | `apps/desktop/src/server-manager.ts` `reconstructPnpmLinks()` | **vstore 重链**：把被 bsdtar 物化成实目录的包 junction 回 `.pnpm/<name>@<ver>/…` | TS | **运行时**（Windows） |
| 5 | `apps/desktop/scripts/relink-pnpm-win.mjs` | 同 4（docstring 自述 "Mirrors server-manager.ts reconstructPnpmLinks() **and extends it**"） | mjs | Windows 安装器验证 |

### 与 issue 登记口径的差异（先核代码再动手）

| 项目 | issue #348 / 台账登记 | 实测（2026-09-15） |
|---|---|---|
| 重复点数量 | 3 | **5**（两组：铺陈 3 + vstore 重链 2） |
| issue 引用的三处行号 | `server-manager.ts:716-766`、`packaged-runtime.sh:62-81`、`verify-dmg.sh:243-278` | 三处**全部命中「铺陈」**（`:729-766` / `:64-83` / `:246-275`），**不是**它散文里说的 `reconstructPnpmLinks()` |
| `.pnpm` vstore 重链 | 未提及 | `server-manager.ts:795-924`（130 行）+ `relink-pnpm-win.mjs`（156 行）—— **issue 完全漏掉的第 4、5 处** |
| 「抽共享实现」的可行性 | 「运行时是 TS、验证脚本是 shell ⇒ 不能是同一个文件」 | 成立，但**同语言内**的重复（两处 shell）可以真收敛，issue 没有区分这两层 |

即：**危害判断正确，但「重复的是什么」判断错了**——把两种不同的解析失败当成一件事，同时
漏掉了其中最靠近用户的一处（Windows 上 vstore 不重链 ⇒ 启动即 ERR_MODULE_NOT_FOUND）。

### 顺带核出的真实功能缺口

`relink-pnpm-win.mjs` 对**自身没有 `.pnpm` 的树**（`satiui`、`sati-memory-core`）整体跳过，
而运行时侧把 `[satiUiDir, satiMemoryDir]` 作为 `extraRoots` 用 **sati-main 的 vstore** 去补。
⇒ **验证比运行时弱**：`satiui/node_modules` 里的实目录包在验证时从未被重链，而用户机器上会被
修好。这正是 issue 所说「脚本校验通过但用户跑不起来」的一个已存在的实例（验证恰好在
gateway 冒烟里碰不到 satiui 的隔离依赖，所以一直没暴露）。

## Decision

### 1. TS 侧：布局接线搬进无依赖模块

新增 `apps/desktop/src/runtime-layout.ts`（**不 import electron**，可被单测直接驱动），
承载 `linkDirectory()` / `stageRuntimeLayout()` / `reconstructPnpmLinks()`。
`server-manager.ts` **1401 → 1205 行**，只剩三行调用与一句指向模块的注释。

正文按 `git show HEAD:apps/desktop/src/server-manager.ts` **机械派生**（切片 + 删除三段 + 插入
7 行），不重打。等价性核对要求三段**函数体逐行相同**（去首尾空白、去空行）：

| 段 | 旧行 | 模块 | 结果 |
|---|---|---|---|
| `linkDirectory` 体 | 124-131 | 同名函数体 | 8 有效行**逐行相同** |
| staging 体（不含 destructure） | 724-766 | `stageRuntimeLayout` 体 | 39 有效行**逐行相同** |
| `reconstructPnpmLinks` 体 | 796-924 | 同名函数体 | 122 有效行，仅 `biome` 压行造成的折行差异 |

唯一进入判定范围的归一化是「去**全部**空白」，其合法性由一条前置断言兜底：**比对区段内
所有字符串/模板字面量都不含空白**（先剥注释再扫，否则 `pnpm's` 的撇号会被当成定界符）。
折行差异来自 `biome` 把跨行数组压成单行时顺带删掉的尾逗号，故另加一条**定向**归一化
（仅吃掉紧邻 `]`/`}`/`)` 的 `,`，两侧同时施加）。

零行为变化的另两条腿：`biome check` / `eslint` 对新文件报无待修项；**32 条新用例**（19 条
布局行为 + 13 条跨实现一致性）在搬移前后从零到全绿。

### 2. shell 侧：两处铺陈真收敛为一处

`pd_runtime_stage_links()` 落进**既有的** `scripts/lib/packaged-runtime.sh`（该文件本就是
release-l2/l3 共用的库），`verify-dmg.sh` 改为 `source` 它并调用。两处**真实差异显式参数化**
而非抹平：

- `$4=root_memcore`：release-l2/l3 一直建根级 `edgeclaw-memory-core`，verify-dmg.sh 从来没建过。
  本布局下它是冗余的（解析走 `SANDBOX/node_modules`），但删除需要 L2/DMG 实跑证据 ⇒ 保留原行为；
- `$5=logger`：verify-dmg 用它把 4 条 `pass` 计入自己的 PASS 计数（原内联块就在 `pass`），
  release-l2/l3 静默 ⇒ 计数保持不变。

另有一处**条件合并**：lib 版用 `if [[ -d "$CCM_DIR/dist" ]]` 同时建 `dist` 与 `dist/src`，
verify-dmg 版分成两个 `if`。差异只在「`dist` 在而 `dist/src` 不在」这一退化情形（前者不建、
后者建出悬空链接），采 lib 侧语义。

### 3. mjs 侧：改可导入 + 补齐借用 vstore

`relink-pnpm-win.mjs` 的四个函数改为 `export`，CLI 入口用 `import.meta.url === pathToFileURL(argv[1])`
守卫（**行为不变**，只是从「纯脚本」变成「可被 import 的脚本」）；新增 `relinkTrees(treeDirs, log)`
承载「挑 owner、其余树借它的 vstore」的语义，与运行时的 `reconstructPnpmLinks(root, extraRoots)`
对齐——即补上上面那条功能缺口。

### 4. 三条判据（各配负控制）

| 判据 | 覆盖 | 用例 |
|---|---|---|
| 等价性核对 | 搬移是否忠实 | `scripts` 一次性脚本（用毕即删，方法记于本 note） |
| TS ↔ shell 一致性 | 铺陈两版 | `tests/desktop/runtime-layout-shell-parity.spec.ts`（3 条） |
| TS ↔ mjs 一致性 | vstore 重链两版 | `tests/desktop/pnpm-vstore-relink-parity.spec.ts`（4 条） |

负控制**全部实测转红后复绿**：搬移注入 5 类（逻辑/边界/行尾注释/顺序/数组元素缺失）、
mjs 注入 3 类单侧改动（退回跳过 / 单候选边界 / 作用域分支删除）、shell 注入 3 类单侧改动
（漏建 `src` / 漏建 `node_modules` / 不删空壳）。

## Alternatives considered

- **让 shell 与 mjs 直接调用编译后的 TS 实现（issue 的「方向 1」）** — 落选：两侧都要给
  **发布路径**引入「构建产物必须先在位」的新耦合，而 Windows 与 DMG 路径在本地**无法实跑**；
  一旦解包流程里产物缺失，失败会落在用户侧（`sati-main-bundle.tar` 明确 `--exclude='apps'`，
  编译产物不在被验证的树里）。改用「加一致性判据」，同样能拦住单侧漂移，且不动发布路径。
- **只加一致性测试、三处实现都留着（issue 的「方向 3」）** — 部分采纳：用于两组**跨语言**对。
  但**同语言内**的重复（两个 shell 脚本）必须先真收敛，否则是在测两份注定漂移的副本 —— 那正是
  本 issue 要消灭的东西。
- **把两组当一件事，抽一个 `linkRuntimeLayout` 覆盖全部 5 处** — 落选：铺陈解决的是「跨 bundle
  相对导入」，vstore 重链解决的是「隔离传递依赖不可达」，前置条件、幂等要求、失败模式都不同；
  合并只会得到一个「什么都做」的模块，正是 `RouterRuntime` 那条债务的翻版。
- **顺手删掉 release-l2/l3 的根级 `edgeclaw-memory-core` 链接** — 落选：读代码它确实是冗余的
  （`SANDBOX/node_modules` 那条已覆盖裸导入），但「冗余」不等于「无用」，删除需要 L2/DMG 实跑
  证据；改为显式参数，把差异写进函数注释而非留在两处代码里。
- **让 `relinkTrees` 的遍历算法与 TS 完全一致（消除超集关系）** — 落选：mjs 的「遍历全树」是
  它在 Windows 上的实际需要（workspace 包内部的 `node_modules` 运行时版走不到）；归一会削弱
  验证强度。改为在用例里把「超集」写成**显式断言**（交集逐条相同 + 独有覆盖点存在）。
- **用「识别已声明形态」的 allowlist 做等价性核对** — 落选：`#343` 的负控制已证伪该方向
  （不校验入库侧实参、行尾追加内容两个结构性漏洞）。本 note 的核对是**变换式**：按切片重建，
  再断言函数体逐行相同。
- **保留 verify-dmg.sh 内联块、只删 release 侧的重复** — 落选：反向收敛会留下「L1 与 L2/L3
  各一份」的原状，而 L1 正是发布流程默认调用的那一关。

## Consequences

- **收益**：同语言内的铺陈重复归零（3 → 1 个实现：TS 运行时 + shell 库各一份，跨语言由用例钉）；
  vstore 重链从 2 份「疑似同源」变成 2 份「被用例绑死且有显式差异清单」；运行时布局代码
  **首次可直测**（此前只能经 Electron 启动触达），19 条新用例覆盖幂等、空壳替换、目标缺失、
  scoped 包、单候选回退、多候选拒绝、hoist 根跳过等分支。
- **代价**：`server-manager.ts` 少了 202 行但多了一个模块边界；`verify-dmg.sh` 现在依赖
  `lib/packaged-runtime.sh` 在位（同目录树内，且该文件本就是同族库）。
- **风险 / 未验证**：Windows 安装器验证（`verify-installer.bat`）与 DMG 验证（`verify-dmg.sh`）
  的改动**未在真机实跑**——本地无法产出 DMG/NSIS。三处改动都落在**验证/铺陈**路径上，失败模式
  是「脚本报错」而非「静默放过」，故风险受控；但 `relinkTrees` 的借用语义需要在下次 Windows
  发版时实跑确认（已登记 `TD-DESKTOP-N07`）。
- **残留（已知差异，勿当缺陷）**：TS 侧 `linkDirectory` 对已存在条目**跳过**（运行时每次启动
  都会跑到，必须幂等），shell 侧 `ln -sfn` **覆盖**（只在 `mktemp` 出的新沙箱里跑一次）。
  新建树上产物相同，已在两个 spec 的注释里写明。
