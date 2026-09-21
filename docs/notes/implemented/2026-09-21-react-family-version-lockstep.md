# Agent Note: react 家族必须整版锁步升级（补 react-dom）

Status: implemented

## Problem

2026-09-21 dependabot 在改动后的配置下重跑，开出 10 个新 PR，其中 9 个全绿 —— 唯一失败的
`#503` `chore(deps): bump react and @types/react`，报错是：

```
Error: Incompatible React versions: The "react" and "react-dom" packages must have
the exact same version. Instead got:
```

失败面是 **ui 的 58 个测试文件全红**，而 `Tests 621 passed (621)` —— 失败发生在**收集期**，
不是断言期，所以「测试数全过」和「文件数大面积失败」同时成立，很容易被误读成 flake。

**根因是 dependabot 的「together」判断覆盖不全**：

- `react` 声明在**两处**：根 `package.json`（TUI 经 `ink` 用）与 `ui/package.json`；
- `react-dom` 只声明在 `ui/package.json`；
- `@types/react` / `@types/react-dom` 同理。

dependabot 把「`react` + `@types/react`」判为 "These dependencies needed to be updated
together"，于是**同时**升了根与 ui 的两个 `react` 和 `@types/react`，但 **`react-dom`
原封不动留在 19.2.8**。React 在加载期自检 `react` 与 `react-dom` 的版本，不一致即抛错，
于是所有 import 到 React 的测试文件在收集阶段就炸掉。

这是**配置缺陷，不是 React 19.3.0 的真实破坏**——与 `@univerjs/*` 必须整组同版
（见 `2026-09-21-dependabot-workspace-dirs-and-pr-gate-bot-exemption.md`）是同一类问题：
**依赖族里存在「必须完全同版」的运行时约束，而 dependabot 只按包名逐个/成对处理**。

## Decision

1. **`.github/dependabot.yml` 增加 `react` 分组**，把 `react` / `react-dom` /
   `@types/react` / `@types/react-dom` 收进同一个 PR，结构上不可能再出现版本失配。
   注释里写明报错原文与「失败发生在收集期」这个易误读点，防止后人把 #503 当成 flake 关掉。
2. **本 PR 直接把 react 家族整体升到 `19.3.0`**（根 + `ui` 的 `react`、`ui` 的
   `react-dom`、四个 `@types/*` 一起动），取代失败的 `#503`。
3. **等价性/正确性证据用 ui 侧全量结果**：补齐 `react-dom` 后
   `cd ui && pnpm typecheck` 零错误、`./node_modules/.bin/vitest run` **145 files / 976 tests
   全通过** —— 与升级前（同样 976 全过）逐一对应，说明 19.2.8 → 19.3.0 对本仓的 UI
   代码面零回归。根侧 `react` 走 `ink`（TUI），由 `pnpm test` 全量覆盖。

## Alternatives considered

- **只加 `react` 分组、不在此 PR 升级**（留给 dependabot 下一轮开分组 PR）— 落选：
  分组的价值正是让「同版」可自动达成，那么这一轮的失配已经修好、升级也已实测通过，
  没有理由让修复推迟一个周期；推迟还会让 `#503` 的失败结论只存在于 PR 评论里。
- **在 `#503` 的 dependabot 分支上补一个 `react-dom` 提交**（仓库先例：`#267` 曾靠人工
  往 bot 分支补 lockfile 才合入）— 落选：那正是本次要消除的形态（人工维护 bot 分支），
  且 bot 下次 rebase / 重开会覆盖；正确做法是让配置保证同版，由正常 PR 交付。
- **把 `react` 加进 dependabot `ignore`** — 落选：React 的 minor 升级要跟（安全与行为修复），
  问题是**协调**而不是**频率**；`groups` 精确解决协调。
- **顺带把 `@vitejs/plugin-react` / `vite` 也并进同一分组** — 落选：它们与 React
  运行时没有「必须同版」的约束，并进去只会让一个包卡住整组升级。
- **把这次失败判为「基础设施 flake」并重跑** — 落选：报错文本是明确的版本一致性断言，
  且 `621 passed` 与 `58 failed files` 并存的形态正是收集期失败的签名；重跑必然复现。

## Consequences

- `react` 家族从此只能整组升级；代价是若某次只有部分包能升需人工介入（期望行为）。
- 根与 `ui` 的 `react` 因为同一分组而**强制落在同一版本**上 —— 这本身是收益：
  此前根（TUI/`ink`）与 ui 可以各自漂移。
- 该类缺陷（「运行时要求同版」）在本仓已有两个实例（`@univerjs/*`、`react` 家族）；
  注释里保留了「如何在报错文本上识别这一类」的说明，供下次新增分组时套用。
- 参考实现位置：`.github/dependabot.yml` 的 `groups.univerjs` 与 `groups.react`。
