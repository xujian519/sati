# Agent Note: 债务仪表盘补 `as unknown as` 双重断言口径

Status: implemented

## Problem

`scripts/measure-techdebt.mjs` 的类型逃逸统计（`scanTypeEscapes`）覆盖三类：TS AST 的
`AnyKeyword` 节点、`@ts-expect-error` / `@ts-ignore` 指令。**三类全部落在「类型位 / 指令」上**，
于是 `x as unknown as T` 双重断言**一处也未被计入**——它既不是 `AnyKeyword` 节点，也不是
`@ts-` 指令，在 AST 上是一个嵌套的 `AsExpression`，在文本上则毫无痕迹。

后果不是「少一个数字」，而是**仪表盘在误导排期**：`any` 仅 3 处（「类型纪律很好」）与
`src + ui/src` 实测 **27 处绕开全部类型检查**并列呈现。`docs/technical-debt/backlog.md`
与 `next-batches-schedule.md` 的优先级排序建立在这份残缺数据上。

而 `as unknown as` 是**比 `any` 更强**的类型逃逸：`any` 至少会传染、也仍能被 lint 规则捕获，
双重断言一次性绕开全部类型检查且不留任何痕迹。

## Decision

1. `scanTypeEscapes` 增加 AST 检测分支，记为**独立指标** `asUnknownAs`（JSON 里挂在
   `unsafe.asUnknownAs`，含 `total` / `perModule` / `items`），**不与 `any` 合并计数**
   ——两者治理成本与语境不同。
2. 判定抽为纯函数 `isDoubleAssertionThroughUnknown(node, ts)`（导出）：`AsExpression` 的
   expression 仍是 `AsExpression` 且内层 `type` 为 `unknown`。两条刻意的取舍：
   - 括号是透明包装，先剥 `ParenthesizedExpression`（`(x as unknown) as T` 同样命中）；
   - **单次 `as unknown`**（仅把值加宽到 unknown）不越检查，**不算**；三元串联
     `as unknown as unknown as T` 只在**最外层**计 1 次（对内层加负向守卫，避免重复计数）。
3. `unsafe` 原有三口径**语义与数字不变**（历史可比）；`asUnknownAs` 作为新行加入
   `metrics.md` 异味指标表，`scopes` 增加对应口径行并显式标注「口径变更（0 → N）」。
4. 新增 `scripts/measure-techdebt.test.mjs`（12 用例）并挂入 `pnpm test:pr-tooling`。
   脚本加 `isMain` 守卫，使纯函数可被 import 而不触发度量（此前 import 即执行 `main()`）。
5. 更新 `docs/technical-debt/README.md` 的类别表与指标口径说明。

## Alternatives considered

- **把 `as unknown as` 并入 `unsafe.total` / 与 `any` 同类计数** — 落选；`any` 是类型位疏漏，
  双重断言多是跨层/协议未对齐的桥接，治理成本与语境不同，合并会让两者都不可读，且使
  「`any` 仅 3 处」这一既有的交叉验证结论失真。
- **继续用正则统计 `as unknown as`** — 落选；与 C42「`any` 改 AST」同因：正则会计入注释与
  字符串里的同名文本（本仓有 `// 这里曾写 x as unknown as Foo` 这类注释），且无法识别括号
  包装与串联断言。单测里专门覆盖了这两种失真。
- **把 `tests/` 一并纳入本指标作用域** — 落选（本次）。`unsafe` 的作用域是产品代码
  `src + ui/src`，本指标与它对齐才能同表并列；测试文件的逃逸属另一治理面，若要做应比照
  `todos` 另立作用域。
- **顺手修正 issue #339 标题里的「329 处」** — 采纳为**文档更正**，不改口径。见下。

## Consequences

- `unsafe.asUnknownAs.total` = **27**（`src` 8 · `ui/src` 19），与 `--json` 逐处清单可复现。
- **`#339` 的「329 处」是作用域混淆**：其复现命令 `grep -rEn 'as unknown as' src/ ui/src/`
  与正文分布表（列的是 `tests/tool 49`、`tests/gateway 46`… `tests/` **不在 `src/` 下**）
  自相矛盾。按正确作用域实测：`src` 8 · `ui/src` 19 · `tests/` 294（合计 321）。issue 的 329
  实为「`src` + `ui/src` + `tests/`」的合数，与工具声明的 `src + ui/src` 口径本就不可比；
  数字亦随 09-14 之后的提交有小幅漂移。已写入 README 口径说明并在 issue 中更正。
- **口径变更（0 → 27）来自度量口径变更，而非新增债务**——趋势图须据此标注，勿与历史快照直接同比
  （比照 2026-09-11 口径对齐的先例）。
- 不改任何工具 `inputSchema`/`outputSchema` 与 `AgentEvent`/gateway frames，LLM replay
  fixtures 与事件矩阵不受影响。
