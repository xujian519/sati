# Agent Note: 开工前基线新鲜度检查（`pnpm check:freshness`）

Status: implemented

## Problem

本仓有两条**按 `file:line` 硬编码**的产物门禁：`docs/event-producer-consumer.md`（事件矩阵）与
`docs/code-facts.md`（文档事实层 claim）。它们保证「产物与当前源码一致」，但**不保证「你手上的源码是最新的」**。
在过期基线上工作有两类真实损失：

1. **分析结论错**：按旧 `file:line` 定位、给已经不存在的函数写测试、修已经消失的问题。
2. **生成物错**：`pnpm gen:event-matrix` / `pnpm gen:doc-claims` 从旧工作树重算，产物在提交那一刻就被自己的基线判定为过期。

同类问题在 `zai-org/ZCode` 有实证：其本地分支曾落后 `origin/main` **140 个提交**（本地 skill 仍 558 行、主线已收敛到
128 行），另一条集成分支落后自己的远端 29 个提交——两次都在旧基线上开过工。本仓没有对应的检查，
开发者的「我是不是落后了」纯靠 `git status` 的自觉（而它对新 clone、`git reset`、detached checkout 后的落后一律静默）。

## Decision

新增 `scripts/check-workspace-freshness.mjs`（`pnpm check:freshness`），**借设计不搬代码**——判定规则照
ZCode 的 `scripts/check-workspace-freshness.mjs` 重写，按本仓语境调参数与默认值。

**四条规则**：

| 规则 | 条件 | 处置 |
|---|---|---|
| R1 | 本地分支落后自己的 upstream（任何数量） | 失败，给 `git merge --ff-only <upstream>` |
| R2 | `ahead==0` 且落后 `origin/main` 超阈值 | 失败（纯过期检出：没有任何自有提交） |
| R3 | `ahead>0`（特性分支有自有提交）且落后 `origin/main` 超阈值 | 仅告警 |
| R4 | 非 git 工作树 / 无 upstream / 无 `origin/main` / git 不可用 | 跳过该规则并打印原因，**不算失败** |

**三处按本仓语境的刻意选择**：

1. **默认离线**（`--fetch` 才 `git fetch`）：本检查会进 `pnpm check`，开发机与 CI 都不该因为一次门禁而意外联网。
   离线时打印 `origin/main` 参照点的提交与时间，让「我读到的是哪天的上游」可判（否则离线判定会变成不可判的乐观读数）。
2. **阈值默认 10**（ZCode 用 50）：本仓 `main` 受保护、变更经 PR 高频合入，落后两位数即意味着本地视图与上游已明显不同。
   `--max-behind-main N` 可调。
3. **挂 `pnpm check` 首位而不是 `pnpm lint`**：本检查依赖本地 git 状态与可选网络，不适合每次 lint / pre-commit 都跑；
   放首位是为了在 typecheck/lint 之前先否掉「基线不对」这一前提。CI 的 `quality` job 逐条跑 typecheck/lint/format/test，
   不跑 `pnpm check`；且 CI checkout 通常是无 upstream 的 detached HEAD，天然走 R4。

**输出契约**：stdout 只留一行结论（`fresh — …` / `skipped（原因）`），诊断走 stderr（`✗` 失败 / `!` 告警 / `·` 跳过的规则与参照点）。
便于将来被脚本消费时不必解析日志。

**负控制**（`docs/development-standards.md` §4 要求每个门禁有「必须变红」的证明）：`scripts/check-workspace-freshness.test.mjs`
（挂 `pnpm test:pr-tooling`）在临时目录搭 local-origin 三件套（bare origin + seed 推送 + client 克隆），
用**真实 git 操作**制造五种场景断言退出码与输出：新鲜、落后自己的远端、无自有提交的过期检出、特性分支分叉、无 `origin/main`、
非 git 工作树、非法参数。变异验证（把 R2 条件置为恒假 → 2 条用例红；把默认离线改成默认 fetch → 1 条红）确认它不是恰好通过。

## Alternatives considered

- **只提醒不阻断（warning-only）** — 落选。仓库既有主张是「铁律必须有门禁」，告警在提交链路上会被忽略；
  而 R1/R2 的修复成本是单条 `git pull`，阻断的代价远小于「用旧基线写完才发现」。
- **照 ZCode 默认 fetch（用 `--no-fetch` 关闭）** — 落选。本仓的 `pnpm check` 是高频本地入口，
  默认联网会让门禁的成败取决于网络；且 CI 若将来纳入本检查，默认联网会引入新的抖动源。改为默认离线 + 打印参照点。
- **阈值照抄 50** — 落选。50 是给「主线推进缓慢的大仓」的值；本仓 50 个提交的漂移足以让 `file:line` 类产物全错，
  等于门禁形同虚设。取 10 并在 header 与规范里写明理由，可调。
- **把检查挂进 `pnpm lint`（与其它 `check:*` 同构）** — 落选。lint 是「代码违规」语义且被 pre-commit / CI 每次触发；
  本检查判的是**环境状态**（本地 ref 与远端的关系），混进 lint 会让「无法判定」类跳过频繁出现在无关提交上。
- **R4 无法判定时失败（fail-closed）** — 落选。无 `origin/main`（浅克隆、单分支 clone）或 git 不可用是**合法的正常环境**，
  fail-closed 会让门禁在最需要它的陌生检出上直接劝退使用者。改为跳过 + 打印原因，把「未判定」显式化而不是伪装成「合格」。
- **让脚本用 `git rev-parse --show-toplevel` 而不是 `process.cwd()` 定位仓库** — 采纳（而非备选）。
  这既是正确性（从子目录调用也能工作），也是可测性：测试只需 `spawnSync(..., { cwd: tmpRepo })`，无需给脚本开 `--repo` 参数。
- **把「落后」判定做成棘轮（记录上次判定的基线，只允许单调改善）** — 落选。落后的参照点是远端 ref 本身，
  不需要额外状态；棘轮会引入一个需要维护且可能与远端冲突的本地文件。
- **在 CI 里也强制本检查** — 本次不采纳（不是拒绝）。CI 的 checkout 形态使 R1/R2 大多走 R4，
  加了等于空转；真正的保护面是「开发者在自己的机器上开工前」。若将来 CI 改成 fetch 全历史 + 有 upstream，
  再评估挂进 `quality` job。
- **顺带检查工作树是否有未提交改动（dirty tree）** — 落选。本检查判的是**基线**（ref 关系），
  未提交改动是开发常态且已有 lint-staged / pre-commit 覆盖；混进来会让门禁在正常编辑中途误报。

## Consequences

- `pnpm check` 现在**先**判基线：在落后自己的远端、或（无自有提交时）落后 `origin/main` 超过 10 个提交的检出上，
  会直接失败并打印修复命令。这是有意的摩擦——修复成本是一条 `git pull`。
- **CI 不覆盖本检查**（`quality` job 不跑 `pnpm check`）。它是一道**开工前**护栏，不是合入门禁；
  行为回归由 `pnpm test:pr-tooling` 里的负控制锁住（CI 跑该步骤）。
- 特性分支（`ahead>0`）落后主线只告警不失败：链式 PR 栈（base 逐级相扣）天然落后 `main`，阻断会直接打断既有工作流。
- `--max-behind-main` 的取值是策略而非机制：调大等于放宽，调小等于收紧，改它不需要改脚本。
- 判定依赖 `origin/main` 这一约定名。仓库若改用别的默认分支名（如 `master`），R2/R3 会退化为 R4 跳过（可见但不阻断）——
  当前 `main` 是受保护的默认分支，无需泛化。
- 不改任何工具 `inputSchema`/`outputSchema` 与 `AgentEvent`/gateway frames：llm-replay fixtures 与事件矩阵不受影响；
  `lint_gate_count` 口径只数 `scripts.lint` 链，本门禁挂在 `scripts.check`，故文档事实层计数不变。
