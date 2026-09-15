# Agent Note: fire-and-forget 落盘的测试同步（`main` CI 偶发变红的根因）

Status: implemented

## Problem

2026-09-15 02:56Z，`main` 的 push CI（run `34923087975`，merge commit `cb58aa6db`，即 #377 合并结果）在 `Typecheck, Lint & Test` 变红，唯一失败用例是 `tests/gateway/client/eventMapping.spec.ts` 的「tool_result 大结果触发 tmp 落盘 resultPath（best-effort）」，断言 `tmp 文件应实际写入` 失败（`# fail 1` / 4318 pass）。

而 58 分钟前同一内容的 pull_request run（`34922417666`）是绿的。两者差异**不在内容**：

- 该 spec 的最后一次改动是 `019345987`（#55），本批两个 PR 都未触碰；
- merge commit 的第一父 `62e7dbb62`（#375 的合并）产生于 PR run 之前，故 merge 结果树与 PR 预览树一致。

同树、异果 ⇒ 非确定性，不是回归。

**机制**（已用一次性探针实测）：`mapAgentEvent` 对 `tool_result` 的落盘是 fire-and-forget —— 它在**同步返回 `resultPath` 之后**才在 async IIFE 里 `mkdir` + `writeFile`（`src/gateway/client/eventMapping.ts:77-84`），且该 IIFE 的 `catch` 静默（注释明言 best-effort/审计用）。测试用的却是「固定 `setTimeout` 100 ms 后 `existsSync`」：它没有任何完成通知可依，只有一个固定预算。

- 实测：`mapAgentEvent` 返回**瞬间**文件不存在（0 ms）；本机（APFS）写完 p50 = 1 ms / p95 = 2 ms ⇒ 固定预算只有约 **50×** 余量。
- 余量虽大，却是**唯一**保障。CI 上该进程与另外 3 个 CPU 密集的 node 测试进程争抢 4 vCPU，而两步 fs 操作各需一轮事件循环调度；进程一旦被饿死超过 100 ms，计时器回调就可能先于写盘续体被调度 —— 断言失败，而写盘本身完全正常。

为什么要修：`main` 变红会拦住后续所有 PR 的合并（required checks），而失败信息只有一句「tmp 文件应实际写入」，**无法区分「慢」与「写失败」**，把一次调度停顿伪装成产品缺陷，需人工逐层排查。

## Decision

1. `tests/gateway/client/eventMapping.spec.ts` 的固定 sleep 改为**有界轮询** `waitForFile(path, 5000)`（10 ms 间隔）；断言失败信息带上目标路径与两种可能（写盘未完成 / best-effort 写失败）。手法沿用仓内既有约定 `tests/session/transcript/jsonl-writer.spec.ts:41` 的 `waitFor`。
2. **不动产品代码**。落盘保持 fire-and-forget：读取侧是懒的且已防御 —— `src/adapters/channel/tui/app/TuiApp.tsx:179-189` 在用户展开工具输出时才 `readFile(resultPath)`，并用 `catch` 回落 `msg.fullText ?? msg.text`。
3. 登记 `TD-TEST-004` 记录本类风险（仓内另有约 40 处测试内固定 sleep，未逐一分类）。

## Alternatives considered

- **让产品侧暴露完成信号（把写盘 promise 交给调用方 await）** — 落选：`mapAgentEvent` 的契约是**同步**返回 `GatewayEvent[]`；为可测性引入模块级 pending 集合、或改成 async，都会污染 `InProcessGateway` 的同步映射路径，成本远大于收益。仅当将来出现**非懒式**消费者时才值得回头做。
- **把 sleep 从 100 ms 调大（500 ms / 2 s）** — 落选：仍是固定预算，只是把余量从 50× 提到 1000×；CPU 饥饿下没有任何「足够大」的固定值，且真失败时更慢。
- **测试内同步自旋等待（`while (!existsSync) {}`）** — 落选：**会自锁**。写盘的 promise 续体依赖事件循环推进，同步自旋不给它机会，必然等满超时（本次探针第一版即踩到，进程被杀）。这条也解释了为什么「快」的写法反而不成立。
- **给产品侧 `catch` 加日志以区分「慢」与「失败」** — 本次落选：debug 级默认不显示，warn 级会给一个注释已声明为 best-effort 的路径引入噪声与指标面变化；改为把两种可能写进断言失败信息，成本为零而信息量足够。若同类失败再现，再升级为可观测通道。
- **让测试自设 `TMPDIR`（mkdtemp）以隔离落盘目录** — 落选：不解决同步问题（文件仍可能未写完），只多一层隔离；`/sati-tool-results/` 的路径断言已足以定位。

## Consequences

- 换来：断言对调度抖动免疫（修复后本地 50/50 通过；负控制：把路径指向永不存在的文件，300 ms 内即转红且信息可读）；`main` 不再因一个固定预算而变红。
- 付出：实际未落盘时断言最长等待 5 s；测试不再锁住「100 ms 内完成」这个从未成立过的性能假设（也无人要求）。
- 未置于本 note 的范围：其余约 40 处固定 sleep 的分类（见 `TD-TEST-004`）。

## Unresolved risks

- **`TD-TEST-004` 未闭环**：真正危险的是「断言 fire-and-forget 副作用已完成」这一类；「等事件送达」类（如 `tests/gateway/kanban-protocol.spec.ts` 的 50 ms）风险低但同族，尚未逐一归类。
- **产品侧窗口仍在**：`resultPath` 在文件存在前就被投递。当前唯一消费者（TUI）为懒读且有回落，故用户可观察层面无虞；若将来出现「事件到达即读该文件」的消费者，就会踩同一个窗口，届时必须改产品侧（见 Alternatives 第 1 条）。
- 本次**未在 CI 上复现**失败（探针在本机合成压力下 p95 仍为 2 ms），故「CPU 饥饿使计时器先于写盘续体被调度」是机制推断，直接证据是同树异果 + 代码上没有完成保证。重跑原 SHA（run `34923087975`）若通过，即为非确定性的旁证。
