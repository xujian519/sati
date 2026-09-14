# Agent Note: 两个时序脆弱用例的去抖动（CI 超时根因）

Status: implemented

## Problem

PR #313（`fix/upstream-571-prompt-date-anchor`）的 CI `Typecheck, Lint & Test` 失败，两个用例红：

- `tests/knowledge/embedding-consistency.spec.js` — 文件级节点 **60001ms 超时**（`--test-timeout 60000`），其子用例被取消（`# cancelled 1`）。
- `tests/session/transcript/jsonl-writer.spec.ts` →「定时器兜底：无显式 flush 时 flushIntervalMs 后落盘」— 断言 `existsSync(path) === true` 得 `false`。

该 PR 的改动只覆盖 `src/agent/loop/AgentLoop.ts`、`src/context/**`、`src/router/tokenSaver/**` 与对应测试，**未触碰**这两个测试文件及其被测代码（`src/knowledge/shared/embedding-consistency.ts`、`src/session/transcript/JsonlTranscriptWriter.ts`）。因此失败不是该 PR 引入的缺陷，而是两个用例本身**按构造就依赖机器时序/磁盘吞吐**。

证据（同一套件的绿跑 vs 红跑）：`jsonl-writer` 那条用例在 main 绿跑中耗时 **40.65ms**——恰好等于它自身 `setTimeout(40)` 的等待窗口，余量为零；红跑中 73ms 时文件还没落盘。`embedding-consistency` 文件在绿跑中 8 条用例共约 6.1s，其中「rowid 采样（2000 行库）」单条占 **6022ms**，其余各 10–25ms。

## Decision

1. **`embedding-consistency.spec.ts` 的种子数据改单事务批量插入**（`db.exec("BEGIN")`/`"COMMIT"`，并把两条 prepared statement 提到循环外）。原写法在自动提交模式下每条语句各成一次事务：2000 行 × 2 条语句 ≈ **4000 次 fsync**。本机实测逐条 922–1217ms vs 批量 4ms（约 250×）；改动后该文件从 1357ms 降到 55ms。断言与数据完全不变，只改事务边界。
2. **`jsonl-writer.spec.ts` 的定时器用例改为等待可观测结果**：新增 `waitFor(predicate, timeoutMs = 5000)` 轮询辅助（与本仓 `createEdgeClawMemoryProviderFromConfig.spec.ts` 中的同名辅助同构），条件为「文件已存在且恰好 1 条记录」，取代固定 `setTimeout(40)`。用例语义不变——仍不调用任何显式 flush，只把"等固定毫秒数"换成"等结果出现（有界失败）"。

## Alternatives considered

- **只重跑 CI（当偶发忽略）** — 落选：两个用例的余量都为零（一个 40.65ms/40ms，一个单条约占文件 99% 且是纯 I/O 放大），不改则下次照红；重跑只是在赌机器。
- **把 `--test-timeout` 调大** — 落选：把 60s 调到 120s 只是把阈值推远，`embedding` 文件的问题根因是 4000 次 fsync 的写放大（25×–250× 的差距），不是"差一点时间"；且放宽全局超时会让真正的死锁更晚暴露。
- **`jsonl-writer` 用例改为注入假定时器/fake timers** — 落选：需要为可测试性改造 `JsonlTranscriptWriter` 的生产代码（当前只注入了 `now`，定时器来自 `setInterval`），代价大于收益；轮询等待不侵入生产代码。
- **`jsonl-writer` 用例把 40ms 放大到 500ms** — 落选：仍是固定窗口，只是把"必定失败"变成"大概率不失败"，没有消除对调度的依赖。
- **给 embedding 种子数据改用 `PRAGMA synchronous=OFF` / WAL** — 落选：改了 DB 行为（测试与生产同一 `node:sqlite` 语义），而单事务已经能把提交次数从 4000 降到 1；事务边界是更小的假设。
- **一并去抖动套件里其他固定 sleep 用例（37 处 `setTimeout(resolve, N)`）** — 落选：本轮只修已红的两个；其余（如 `patentCache` 的 80ms 窗口、`node-policy` 的 200ms）未在 CI 上失败，且多数等待的是"人为延迟"而非"待观测结果"，不能机械替换。列为后续可选清理。

## Consequences

- 两个用例不再依赖机器负载：一个把 I/O 放大降了约 250×，一个把固定窗口换成有界轮询。
- 诚实边界：红跑日志中该文件的子用例未输出任何 TAP 行即被取消，故**无法确证 60s 时正在跑哪一条**。可确证的是该文件的运行时间 99% 集中在那一 I/O 放大用例上，因此它是 60s（相对绿跑 6.1s，约 10×）的唯一合理候选；修它直接消掉了这一放大。
- 未消除的风险：套件里仍有数条 5–15s 的重用例（lint fixture 负控制、`系统 Chrome 存在时可生成 PDF`、团队编排集成），它们在 CI 磁盘/CPU 争抢下同样有超时理论风险，但本轮未出现失败，未一并处理。
- `docs/technical-debt/backlog.md` 未登记此项：这不是新债，而是两个既有用例的脆弱性被负载暴露后的修复。
