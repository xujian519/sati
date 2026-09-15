# Agent Note: 债务指标基线加新鲜度校验门禁

Status: implemented

## Problem

`docs/technical-debt/metrics.md` 是债务排期的**唯一量化依据**，但它只能由
`node scripts/measure-techdebt.mjs --update` **手工触发**，没有任何机制保证它与工作树同步。
`README.md` §如何保持新鲜 写的是「每季度或大版本重跑」——**是约定，不是机制**。

后果已被 2026-09-14 的审计实证（issue #340）：基线停在 **09-11**，而 09 月的拆解运动
（`createLocalGateway` P4a 十刀、`AgentLoop` #147 八刀）已让报表严重失真：

| 条目 | 基线声称 | 实测（2026-09-14） |
|---|---|---|
| `src/cli/createLocalGateway.ts` | 2696 行 | 448 行 |
| `src/agent/loop/AgentLoop.ts` | 2430 行 | 1134 行 |
| god function `createLocalGateway` | 607 行 | 已不存在 |
| god function `prepareSessionRuntime` | 517 行 | 已不存在 |
| god function `createReadFileTool` | 509 行 | 已不存在（拆为 127 行） |
| god function `handleModelError` | 364 行 | 已不存在（外迁 `modelErrorRecovery.ts`） |

**排期决策继续建立在这些过期数字上**，而基线不会因为源码变了而变红。

## Decision

采用 issue #340 的**方案 A**：

1. `measure-techdebt.mjs` 新增 `--check [path]`（默认 `docs/technical-debt/metrics.md`）：
   依当前工作树**重算并整篇渲染**，与磁盘上的基线正文逐行比对，不一致以非 0 退出（`process.exitCode = 1`）。
2. `package.json` 新增 `check:techdebt-metrics`（`--check`）与 `measure:update`（`--update` 的短别名），
   并把 `check:techdebt-metrics` 挂在 `lint` 链尾——与既有的 `check:event-matrix`、`check:issue-labels`
   同构（仓库已有两个同形态门禁，模式已验证）。
3. 比对前归一化：**丢弃「历史快照」段**（那是历史记录，不属于本次内容）与**快照时间戳**
   （`> 最近一次快照：**YYYY-MM-DD**` 隔日必变，不挡住会让「今天生成、明天在 CI 跑」无条件变红）。
4. 差异报告用**多重集行比较**（不是按下标逐行比）：`--update` 是整篇重写，一行插入会让其后所有行
   错位，按下标比会报出满屏假差异，看不出真正变了什么。输出分「基线缺少 N 行」「基线多余 N 行」并给修复命令。
5. 新增 9 条测试（`scripts/measure-techdebt.test.mjs` 由 12 → 25 用例），含 7 条**负控制**：
   当前基线必须通过、正文插入一行必须失败、数字被改动必须失败、基线文件不存在必须失败、
   `listFiles` 不得返回被忽略的文件、`listFiles` 必须计入未跟踪但未被忽略的新文件。

## 实施中被门禁自己抓到的口径缺陷：文件清单必须 **git 感知**

本 PR 首次在 CI 上跑这道门禁时，它**红了——而且红得对**：

```
✗ 指标基线已过期：docs/technical-debt/metrics.md 与当前工作树不一致。
  基线缺少 5 行（当前工作树应写入）：
      | tests 文件 | 527 |
      | 知识卡逐字节重复（组 / 冗余文件 / 冗余字节） | 70 组 · 90 文件 · 527689 B | — |
      | knowledge | 38 |
      | methodology | 2 |
      | **合计** | **510** |
  基线多余 5 行（当前工作树已不再产生）：
      | tests 文件 | 532 |
      | 知识卡逐字节重复（组 / 冗余文件 / 冗余字节） | 72 组 · 92 文件 · 546268 B | — |
      | knowledge | 42 |
      | methodology | 3 |
      | **合计** | **515** |
```

**根因**：`listFiles` 用 `readdir` 遍历**工作树**，而磁盘上存在 `.gitignore` 忽略的文件——
本仓实测 `tests/**.test.ts` 有 5 个（`.gitignore:214: *.test.ts`，项目惯例用 `*.spec.ts`），
`src/knowledge/patent/wiki` 下也有被忽略的 md。它们在 CI 的检出树里**不存在**。
于是同一份代码在开发机上算出 532 个测试文件、在 CI 上算出 527 个——**指标不可复现**，
门禁也就在 CI 上必然假红。这直接违背 `README.md` 对指标的「可复现」定位。

**修法**：`listFiles` 改走 `git ls-files --cached --others --exclude-standard`
= 已跟踪 ∪ 未跟踪但未被忽略。含未跟踪文件是刻意的（「先刷新基线、再 `git add`」是常见顺序，
只认 `--cached` 会漏掉刚新建的文件）；排除被忽略者则堵住上面那条不可复现的路径。
`knowledgeDupMd` 同步改走同一清单。

**副作用（都是修正，不是回归）**：`tests 文件` 532 → **527**、`测试覆盖合计` 515 → **510**、
`knowledge` 42 → **38**、`methodology` 3 → **2**、`知识卡逐字节重复` 72 组/92 文件 → **70 组/90 文件**。
即此前基线把**不在仓库里**的文件也算进了规模与重复度。

## Alternatives considered

- **方案 B：只在 `metrics.md` 顶部记 commit SHA，比对「HEAD 之后是否改过 src/ 或 ui/」，只提醒不阻断**
  — 落选；CI 中的「提醒」会被忽略，而本问题的本质正是「靠人记得」不可靠。
- **每次 CI 自动重生 `metrics.md` 并提交** — 落选；会产生噪音提交，且会与所有在开 PR 冲突
  （基线文件是高频改动点）。让**改动方在自己的 PR 内**刷新，冲突面最小。
- **只比对「关键指标」白名单（Top-N 大文件、god function 数、异味计数）而非整篇正文**
  — 落选；白名单本身会成为下一个漂移点（新增指标时忘了加进白名单，就等于又开了一个静默缺口）。
  整篇比对最简单也最严，且新增指标时零维护。
- **按下标逐行 diff** — 落选；见 Decision 第 4 条。改用多重集比较，对行序不敏感。
- **门禁降级为 warning / 仅本地 hook** — 落选；与仓库「铁律必须有门禁」的既有主张相悖，本地 hook 可被绕过。
- **把 `--check` 挂到独立的 CI job 而非 `pnpm lint`** — 落选；`pnpm lint` 已是聚合门禁且开发者会本地跑，
  挂在链尾能让问题在**提交前**暴露，而不是等到 CI。
- **让 `--check` 容忍「本机与 CI 文件清单不一致」（如只比对若干「稳定」指标）** — 落选；这正是
  实施中暴露的真问题（见上节），容忍等于把「指标不可复现」固化下来。改为修根因：让清单 git 感知。

## Consequences

- **改动了任何会影响指标的代码后，必须在同一 PR 内跑 `pnpm measure:update` 刷新基线**，否则 CI 变红。
  影响的典型面：文件/行数变化（Top-N 大文件）、god function 增减、裸 `console`/空 `catch`/无注释 `catch`/TODO 计数、
  分层违规、测试文件数、i18n key 对齐、知识卡重复。**这是有意的摩擦**——它正是「基线不再静默失真」的代价。
- **口径变更须与基线刷新同 PR 落地**（如 #339 新增 `asUnknownAs` 行）：否则门禁会在下一个人的 PR 上才炸，
  届时难以定位到「是口径变了还是代码变了」。错误信息里已显式说明这一点。
- 门禁在基线刚刷新后必然通过（验收标准 3）；`pnpm check:techdebt-metrics` 全量遍历约 2–3s，
  挂入 `pnpm lint` 后可接受。
- 快照时间戳与历史段不计入比对，故「隔日运行」不会产生假红。
- 不改任何工具 `inputSchema`/`outputSchema` 与 `AgentEvent`/gateway frames，LLM replay
  fixtures 与事件矩阵不受影响。
