# Agent Note: 架构边界门禁（`check:architecture-boundaries`）与修复空转的 ui/server→src 门禁

Status: implemented

## Problem

三件事，前两件是**现在就有问题**：

1. **`src/` → `ui/` 完全没有门禁**。`Agents.md` 铁律 2（「`src/` 不得导入 `ui/`」）只存在于散文里：根 `eslint.config.mjs` 只有两类 `no-restricted-imports`（危险 API、团队层禁 `src/patent`），`src→ui` 不在其中；`scripts/measure-techdebt.mjs` 只把它统计进 `docs/technical-debt/metrics.md`（当前 0），那是**新鲜度门禁**，不是禁令。同理 `ui/src`（浏览器客户端）→ 后端 `src/` 也无门禁——`ui/eslint.config.js` 的同名规则对 NodeNext 风格带扩展名的 specifier 不生效（已记录的既知问题）。
2. **`scripts/check-ui-server-boundary.mjs` 从上线起就在空转**。它先用状态机把注释**与字符串字面量**整体置空（`out += " ".repeat(j - i)` 连引号一起抹掉），再用**要求引号**的正则 `["']([^"']+)["']` 提取 specifier —— specifier 本身就在字符串里，置空后正则永远匹配不到，导入循环体一次都没执行过。实测证据（`ui/server` 放一个伪造文件）：

   ```
   import { something } from "../../src/patent/workflow/runtime/deepInternal.js";
   → check-ui-server-boundary: fresh     # 修复前：深层未白名单导入被放过
   → check-ui-server-boundary: ✗ ui/server/__boundary_probe.js:1 → src/patent/...   # 修复后
   ```

   即 `ui/package.json` 的 lint 里那道门禁此前只可能因「eslint except 列表漂移」而红，**永远拦不住导入**。这正属于本仓 §4 警告的形态：「会误报的门禁比没有更糟」——不会被撞红的守卫等于没有。
3. **没有文件规模护栏**。src 有 16 个文件 > 800 行（最多 1764），ui/src 16 个（最多 1441），ui/server 9 个（最多 2347）。已有指标只做「top-N 大文件」展示与新鲜度校验，不拦住**新**巨型文件的诞生。

## Decision

1. **新增 `scripts/check-architecture-boundaries.mjs`（`pnpm check:architecture-boundaries`，挂 `pnpm lint` 末尾）**，三条规则：

   | 规则 | 内容 | 检测方式 |
   |---|---|---|
   | `src-no-ui-import` | `src/` 不得 import `ui/` | 相对 specifier 解析进 `ui/` 子树；裸 specifier `ui/*`、`sati-ui` |
   | `ui-src-no-backend-import` | `ui/src` 不得 import 后端 `src/`（浏览器客户端只能经 gateway/WebSocket） | 相对 specifier 解析进 `src/` 子树；裸 specifier `sati`、`@sati/*` |
   | `file-size` | 单文件 ≤ 800 行 | `split("\n").length`（与 `measure-techdebt.mjs` 同口径），vendored 子包不参与 |

2. **specifier 提取改用 TS 编译器**（`scripts/lib/import-specifiers.mjs`，`ts.createSourceFile` + 遍历 `ImportDeclaration`/`ExportDeclaration`/`ImportEqualsDeclaration`/`CallExpression`）。注释与字符串里的假 import 天然不在语法树里（零误报），模板字面量 `${}` 内的真实 import 也不漏（零漏报）。路径解析仍由各门禁自己的纯路径逻辑完成——原脚本拒绝 eslint resolver 的理由（`.js`→`.ts` 不回退）与「解析字面量」无关。
3. **修复 `check-ui-server-boundary.mjs`**：删掉状态机与正则，改用同一提取器；顺带给 `readEslintExceptList` 加读失败兜底（此前 `ui/eslint.config.js` 缺失会直接崩栈，而不是报违规），并加 `--root`（供负控制指向 fixture 树）与 `isMain` 守卫（供测试读白名单）。
4. **存量豁免基线** `docs/technical-debt/architecture-baseline.json`：命中基线 = 存量不阻塞，其余 exit 1；`--update-baseline` 按当前工作树重写（同时清除已消失的条目，避免基线退化成「永久许可清单」）。首版 41 条全部是 `file-size`（16 个非 vendored `src/` 文件 + 16 个 `ui/src` + 9 个 `ui/server`），两条边界规则当前 0 违规、基线为空。
5. **阈值 800 行**的理由：不是照抄外部项目的 400——400 会把 112 个 src 文件一次性变成待豁免，白名单大到无法评审；600 也要 48 个。800 行 ≈ 本仓 god function 阈值（300 行）的 2.7 倍，只牺牲 16 个 src 文件，且给「文件该拆了」明确信号（`--max-file-lines` 可调）。
6. **负控制**（`test:pr-tooling`，CI `Self-test PR tooling gates` 步骤会跑）：新增 `scripts/import-specifiers.test.mjs`（提取器两侧：注释不误报、字符串里的 `require()` 是数据、模板 `${}` 里真实 import 不漏报）、`scripts/check-architecture-boundaries.test.mjs`（fixture 树 10 例：三条规则各自变红、注释不误报、vendored 只受 R1、基线缺失/失效条目/`--update-baseline` 语义、阈值可调、参数校验）、`scripts/check-ui-server-boundary.test.mjs`（7 例：白名单放行、深层静态导入、动态 `import()`、`.cjs` 的 `require()`、注释不误报、except 漂移、配置缺失）。
7. **门禁联动**：`package.json` 的 `lint` 链末尾挂 `check:architecture-boundaries` → `pnpm gen:doc-claims` 回填 `lint_gate_count`（11→12）与 `docs/code-facts.md` §4 清单（同 PR 提交）。

## Alternatives considered

- **用 eslint `no-restricted-imports` / `import-x/no-restricted-paths` 代替脚本** — 落选。带扩展名的 NodeNext specifier 下 resolver（unrs-resolver）不做 `.js`→`.ts` 回退，规则静默跳过；这正是 `check-ui-server-boundary.mjs` 当初存在的理由，两处踩过同一个坑，不再重犯。
- **沿用「先删注释与字符串再正则」的做法（只在旧脚本上改一行）** — 落选。该做法自相矛盾：specifier 就在字符串里，删字符串则永不匹配（空转）、留字符串则无法区分「代码里的导入」与「数据里的 `'require("x")'`」（误报）。TS AST 一步解决两端。
- **照抄 ZCode 的 400 行阈值** — 落选；见 Decision 第 5 条（会把 112 个文件推进白名单）。**取 600** 也落选（48 个豁免仍偏大，且 600 与 800 在「文件该拆了」的信号强度上差别不大）。
- **只对 `src/` 做行数上限**（ui 侧交给后续） — 落选。同一条规则在三个树里用两套口径无法向评审解释；41 条豁免是**数据**不是代码，多 25 条的代价小于「为什么 ui 没有上限」的解释成本。
- **行数规则做成「不许增长」的棘轮**（基线记录行数，超过即红） — 本次落选、非拒绝。存量 41 个文件里有 `AgentLoop.ts`、`useSessionStore.ts` 这类高频改动文件，任何 +1 行都会红，会把存量重构 PR 变成反复改基线的仪式；先把「新文件不得超大 + 未豁免文件不得越过 800」立住，增长检测留作后续（基线已记录 `lines` 字段，具备实施条件）。
- **基线用 `sha256(rule\0file\0detail)[:16]` 指纹键** — 落选。指纹在评审里不可读（`a3f9…` 无法与文件对照），而本仓没有跨仓库移植基线的需求；改用可读三元组键（`rule \t file \t detail`），语义等价。
- **`--changed` 增量模式 + 沿 importer 反向闭包扩散** — 落选。三条规则的违规都是**文件自包含属性**（导入写在自身、行数属于自身），改 A 不会让 B 违规，反向闭包对当前规则集不产生额外检出；而全树 1816 个文件的完整扫描只要 ~0.8s，且 `pnpm lint` 里的 eslint 本来就在全树跑。若将来加入「依赖者数量上限」这类跨文件规则，再补增量模式。
- **把 `ui/server → src` 也搬进新脚本（单一架构门禁）** — 落选。那会连带搬迁 barrel 白名单与 `ui/package.json` 的挂载点、改两份文档，diff 与风险都不小；两个门禁**共用提取器**即可消除重复实现，whitelist 仍各自表述。
- **规则 3 做成「禁止 lint 抑制指令」（ZCode 的 disable-count 思路）** — 落选。`@ts-ignore` / `@ts-nocheck` 已由 eslint `ban-ts-comment`（根 + ui，error）拦下，再加一道是重复门禁；`eslint-disable-next-line` 在本仓的 5 处用法都带 `--` 理由，是有意保留的行内抑制。
- **基线文件缺失时 fail-open（当作空基线）** — 落选。那等于删掉基线文件即可放行全部存量违规；改为 fail-loud 并打印 `--update-baseline` 重建命令。
- **给 `ui/src` 开 `@sati/web-client` 白名单**（该别名写在 `ui/tsconfig.json` 的 `paths` 里） — 落选。`ui/vite.config.js` 没有对应 alias，import 它会在构建期失败，且全仓 0 处使用——它是**死配置**；门禁拦住新增使用比给它开白名单更正确（若将来确需复用共享协议代码，应在基线登记并在 PR 说明，最好抽成独立包）。

## Consequences

- **`src/` 与 `ui/` 的耦合方向现在有机器强制**：`src→ui`、`ui/src→src` 两条此前零覆盖，`ui/server→src` 那条从「假门禁」变成真门禁（真实仓库当前仍是 fresh：14 处深层导入全部落在白名单内）。
- **新增/修改依赖方向或新增巨型文件会在 `pnpm lint` 变红**，修复路径写在错误信息里（下沉共享逻辑 / 走 gateway / 拆模块 / 登记基线并说明理由）。
- **41 条存量豁免是一份可见的债清单**（`docs/technical-debt/architecture-baseline.json`），它不阻塞任何现有工作，但每次 `--update-baseline` 的 diff 都要过评审；删除条目 = 拆完一个巨文件。
- **`ui/eslint.config.js` 的 `except` 列表仍是冗余的意图文档**（真门禁在脚本里），但两处清单的漂移由脚本自检兜住（新增 7 例中的「except 漂移」一例即验证此路径）；`ui/tsconfig.json` 的 `@sati/web-client` 死配置留着不动（不在本刀范围，但门禁会拦住它的新增使用）。
- 门禁耗时 ~0.8s（1816 文件：读文件算行数 + TS 解析边界面），挂 `pnpm lint` 末尾可接受。
- 不改任何工具 `inputSchema`/`outputSchema` 与 `AgentEvent`/gateway frames：llm-replay fixtures 与事件矩阵不受影响。
