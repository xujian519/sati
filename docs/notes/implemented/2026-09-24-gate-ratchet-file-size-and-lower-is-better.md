# Agent Note: 门禁棘轮化（file-size 上限 + 「越少越好」指标上限）

Status: implemented

## Problem

两道门禁都只校验「与基线正文一致」，不校验「不得更差」。基线因此是**方向性冻结**名义下的**永久许可**：只要顺手刷新一次，任何增长都被静默追认，无人知道哪次是修正、哪次是侵蚀。

### 一、架构边界门禁的 `file-size` 豁免只匹配「规则+文件」（#527）

`scripts/check-architecture-boundaries.mjs` 的 `baselineKey` = `rule \t file \t detail`，而 `file-size` 是文件级规则（`detail` 恒空），基线条目虽然**记录了 `lines`**，但 `readBaseline` 只把键收进一个 `Set`、`fresh` 判据只看「键在不在集合里」。于是命中基线的巨型文件可以**在豁免名义下无声增长**——记录的 `lines` 从不参与比较。

实测（基线 `2e64d987f`）：41 条 `file-size` 豁免中 **6 条已超过各自基线记录值，合计 +136 行**：

| 文件 | 基线记录 | 实测 | Δ |
|---|---|---|---|
| `src/gateway/protocol/types.ts` | 911 | 984 | +73 |
| `src/gateway/client/InProcessGateway.ts` | 1489 | 1518 | +29 |
| `ui/src/components/chat/hooks/useChatRealtimeHandlers.ts` | 1005 | 1025 | +20 |
| `src/cli/sati.ts` | 1028 | 1035 | +7 |
| `ui/src/stores/useSessionStore.ts` | 1347 | 1352 | +5 |
| `ui/src/components/app-shell/AppShellV2.tsx` | 893 | 895 | +2 |

且基线文件全历史仅 `4a4ddef6e` 一次提交、**从未刷新**——「`--update-baseline` 静默追认增长」不是推断，+136 就是历次「顺手刷新」的累积，而 issue 自设的立项线是「+50 行」。

### 二、无注释无参 catch 的零基线被逐步侵蚀且无棘轮（#530）

`check:techdebt-metrics`（`measure-techdebt.mjs --check`）做的是**整篇 `metrics.md` 正文比对**：它只报「与磁盘不一致」，而 `measure:update` 会把**任何**变化（含侵蚀）重写为合法。#353 曾把「无注释的无参 catch」清零一次，此后新代码又逐次爬升（0→12，P1 修正口径后为 **17**），每一次都被「刷新基线」这个动作合法化，没有任何机制**单独拦住「变差」这个方向**。

## Decision

两道门禁同型，用**一套棘轮语义**修：**越少 / 越短越好 ⇒ 当前值不得超过基线记录值；超过即失败；承认增长必须走一次显式、可 review、且打印 Δ 的动作。**

### 1. `file-size` 棘轮（#527）

`readBaseline` 由 `Set<key>` 改为 `Map<key, entry>`（保留记录的 `lines`）。`fresh` 判据从「键不在基线」扩展为：

```
键不在基线                              → 新债（fresh）
键在基线 且 rule=file-size 且 当前行数 > 基线记录行数 → 棘轮违例（fresh，附 baselineLines）
键在基线 且 当前行数 ≤ 基线记录行数        → 存量豁免（放行）
```

`--update-baseline` 在写盘前读回旧基线，**逐条打印本次追认的 `lines` Δ 与合计**，把「承认动作」变成 PR 里可见的证据。本次首刷追认了上表 6 条、合计 **+136 行**（已写入 PR 描述）。

### 2. 「越少越好」指标棘轮（#530）

新增 `docs/technical-debt/thresholds.json`——与 `metrics.md` **分离**的上限文件：

```json
{ "version": 1, "lowerIsBetter": { "catchEmpty.total": 0, "catchNoParam.undocumented": 17 } }
```

`measure-techdebt.mjs` 新增纯函数 `resolveMetricPath` / `checkRatchets` / `updateThresholds`；`--check` 在整篇比对之后**追加**棘轮断言（两者都要过），并新增 `--update-thresholds` 刷新入口（打印逐项 Δ，标注「承认侵蚀」或「锁定改善」）。

**为什么独立于 `metrics.md` 而不复用整篇比对**：整篇比对的刷新（`measure:update`）是「让报表等于当前树」，本就允许数字上下浮动、无声无息；棘轮要的是「上限只能被**显式**移动」。把上限单列成一个只在 `--update-thresholds` 时才变的文件，才能让「承认侵蚀」与「日常刷新」在动作上区分开——这正是 #530 要治的形态。上限值放在机器可读的 JSON 里（而非写死脚本），使「上调阈值」成为一次可 review 的 diff。

`checkRatchets` 对「阈值指向一个取不到值的指标路径」**fail-loud**（记为违例）——否则指标改名后棘轮会静默退化为「恒通过」，比没有棘轮更糟。

### 3. 受管指标只放两类明确的治理目标

`catchEmpty.total`（空 `catch {}`，零基线）与 `catchNoParam.undocumented`（无注释无参 catch，#530 / #353 的治理目标）。刻意**不放** `console.total` / `todos.total` / `unsafe.total`：它们各有设计豁免或归属其它议题，纳入会放大本棘轮的爆炸半径、制造与治理目标无关的红。`updateThresholds` 只重写文件里**已有**的键——新增受管指标是一次有意的 `thresholds.json` 编辑，不自动扩张。

## Alternatives considered

- **#527(b)「仅告警不阻塞」** — 落选：本仓门禁一律 `exit 1`，CI 里的 warning 等同无效（`TD-PROCGATE-001`「PR 门禁被模板注释恒真通过」就是同型失败）。
- **#530(b)「升级为 eslint 规则」** — 落选：`eslint.config.mjs` 连 `no-empty` 都没有，「catch 邻域必须带意图注释」这类判据 eslint 表达不了；且 P1 修的两处口径盲区（`ui/src` 的 `.js/.jsx`、`ui/src/lib/`）不修则 eslint 同样扫不到。
- **棘轮上限直接复用 `metrics.md` 里的数字（解析报表正文）** — 落选：报表正文是给读的、格式会变；解析它取上限等于把「上限」与「展示」耦合成同一处漂移点。独立 `thresholds.json` 是单一职责。
- **把 `--update-thresholds` 合并进 `measure:update`（一次刷新两处）** — 落选：那正好抹掉本设计要保留的区分——「日常刷新报表」不应顺带移动上限；承认侵蚀必须是一个**独立、显式**的动作。
- **棘轮自动下调（改善时自动收紧上限）** — 落选：自动改写一个「只能显式移动」的文件会重新引入静默变更；改为 `checkRatchets` 在改善时**提示**可 `--update-thresholds` 锁定收益，把决定权留给 PR。
- **一次性把全部「越少越好」指标纳入棘轮** — 落选：见 Decision 3，会放大爆炸半径。机制是通用的，将来加指标只需编辑 `thresholds.json`。

## Consequences

**换来**：两道门禁从「冻结存量」升级为「拦住变差」；存量文件增长与 catch 侵蚀都需要一次**可见、可 review、带 Δ** 的承认动作，而不再能被「顺手刷新基线」合法化。

**付出（一次性）**：

- 本 PR 必须**先让仓库转绿**——`--update-baseline` 追认了 6 条 file-size 增长（合计 **+136 行**，见 PR 描述）。这是棘轮的第一次真实使用，示范它期望的「承认动作」形态。
- 棘轮会让**合法增长**也必须显式承认：任何使豁免文件变长、或使受管指标回升的 PR，都要在同一 PR 内 `--update-baseline` / `--update-thresholds`。这是设计意图，但代价是「何时可以上调」需要判断——**顺手刷新正是棘轮要治的行为**，故两个刷新入口都强制打印 Δ，让承认动作在 PR diff 与 CI 日志里留痕。

**新增护栏（均带负控制）**：

- `scripts/check-architecture-boundaries.test.mjs`：① 存量豁免文件增长 → 失败并列 Δ，`--update-baseline` 追认后放行；② 负控制——文件缩小到基线以下**不**触发（证明判据是「超过记录值」而非「命中基线」）。
- `scripts/measure-techdebt.test.mjs`：`checkRatchets` 的等于/低于/高于三态、指标路径取不到值 fail-loud、文件缺失报错、`updateThresholds` 的 Δ（升/降）与「刷新后放行」、默认键引导生成。负控制——「基线 12、树 13 → 违例」。

**与其它批次的交叉**：P5（#534）会**减少** `ui/server/routes/git.js` 的行数与 2 处无参 catch，与本棘轮方向一致（减少不需承认）；P4/P6/P7 若使某豁免文件变长，须同 PR `--update-baseline`。

## 相关

- issue **#527** · issue **#530**（本 note 关闭其棘轮段；口径段由 `docs/notes/implemented/2026-09-24-metric-scope-git-and-path-prefix.md` / PR #557 交付）
- 前置：#353（catch 清零，PR #432/#433）——#530 是它缺失的护栏；`TD-PROCGATE-001`（恒真门禁）——同型失败
- 实施方案：`docs/open-issues-remediation-plan.md` §3.2（P2）
- 新增门禁产物：`docs/technical-debt/thresholds.json`
