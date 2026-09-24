# Agent Note: 记忆检索不再阻塞首 token（注入预算 + 后台预热 + abort 竞速）

Status: implemented

## Problem

每轮模型请求装配（`DefaultContextRuntime.prepareForModel`）都会 `await` 记忆检索完成才发请求。检索此前已做了一项优化——提前并行启动（`memoryPromise`），让它在同步的 prompt 组装期间跑——但随后那个 `await` 仍把首 token 钉在检索的尾延迟上。叠加内层预算后，最坏路径是「固定等满 30s 再空手进模型」：

- 外层熔断 `DEFAULT_MEMORY_RETRIEVAL_TIMEOUT_MS = 30_000`（`MemoryAttachmentBuilder` 用 `setTimeout` + `Promise.race(retrieve, waitForAbort)` 实现）。
- 内层是 vendored 子包 `edgeclaw-memory-core` 的 memory-gate LLM 调用，自带 `45s × 3` 重试预算。

两个缺口：

1. **阻塞**：30s 熔断只保证「不会无限等」，不保证「不等」。命中 provider TTL 缓存时几乎零成本，但冷检索（memory-gate LLM / 语义 embedding）慢时，用户在拿到任何输出前固定等最多 30s。
2. **abort 未透传**：`EdgeClawMemoryProvider` 声明并把 `signal` 传给 `service.retrieveContext`，但 memory-core 是独立 pnpm workspace 子包、其实现**不消费 `AbortSignal`**（`grep -rn AbortSignal memory-core/src` 计数 0）。⇒ 外层熔断只是「不再等」，内层幽灵调用继续跑到自己的 45s×3；更糟的是它跑完后仍会 `retrieveCache.set(...)`——一个被中止/陈旧的检索结果会污染 TTL 缓存，被注入到后续回合。

检索链路是 `CompositeMemoryResolver` 扇出：EdgeClaw 会话记忆 + 专利/法律/判例知识 provider，**每个 provider 各自带按 query 键的 TTL 缓存**。慢尾巴主要来自 EdgeClaw 与知识 provider 的语义 embedding 网络调用；同步 FTS/DB 检索与所有缓存命中都是「快路」。

## Decision

把「停止等待」与「中止工作」**解耦**——这是本次的核心，也是与登记项原建议的关键区别。

### 1. 注入预算（非阻塞化）

`prepareForModel` 不再无条件 `await memoryPromise`，改为 `await raceWithInjectionBudget(memoryPromise, memoryInjectionBudgetMs)`：

- 预算内返回（缓存命中 / 同步 FTS·DB / 快响应）→ 本轮照常注入，**单轮问答不退化**。
- 超预算 → 本轮空注入 + 记 `memory_retrieval_deferred`（info，可观测、不静默），但**不中止** `memoryPromise`：让它在后台跑完，写入各 provider 的 TTL 缓存，下一轮同 query 即命中。
- 缺省 `DEFAULT_MEMORY_INJECTION_BUDGET_MS = 2_000`，可经 `memory.injectionBudgetMs` 配置覆盖；`<= 0` 关闭非阻塞、退化为完整等待（旧行为，供测试与特殊场景）。

预算到期只「停止等待」，**绝不 abort**——真正的取消仅来自硬熔断（`memoryRetrievalTimeoutMs`）或回合级 `abortSignal`，二者都在 `MemoryAttachmentBuilder` 内驱动 `controller.abort`。这条解耦是「后台预热」能成立的前提：若预算到期就 abort，内层结果被丢弃、缓存永远不暖，下一轮照样冷——预算与 30s TTL 缓存就「打架」了（登记项据此否决过「到期即注入」，但那个否决只对**会 abort 的预算**成立）。

### 2. abort 竞速落仓内适配层

`EdgeClawMemoryProvider.performRetrieve` 把内层 `retrieveContext` 封成 `inner`，对 `inner` 与 `signal` 竞速（新增 `raceAbort`）：

- signal 先中止 → 立即 reject，`performRetrieve` 返回 fail-soft 空结果（`{diagnostics: []}`），**不写缓存、不落 `pendingRetrievals`、不计错误遥测**（中止非 provider 故障）。
- `inner` 仍可能在后台跑完——挂空 `inner.catch(() => {})` 防 `unhandledRejection`，其结果一律丢弃。
- `raceAbort` 在任一分支结算后摘除 abort 监听器，不留悬挂引用。

不改 vendored 子包：memory-core 有独立 build/typecheck/test、`metrics.md` 明文列为「不随本仓演进」，且其 `retrieveContext` 无 signal 形参。abort 的语义（「停止采纳内层结果」）只能落在仓内适配层。

## Alternatives considered

- **纯后台检索 + 下一轮注入（登记项原建议、计划 §2.3.3 的字面选项）** — 落选：因为 composite 里**所有** provider 在某 query 的首轮都是冷的，纯后台会让「单轮问答（无工具循环，只有一次模型请求）」**永远拿不到任何记忆/知识注入**——它只从第二轮起暖。记忆是 best-effort，但把首轮（且常是唯一一轮）一律清空是对可见行为的实质回退。注入预算保留了「快路本轮即注入」，只对真正慢的冷检索退到后台，严格优于纯后台。
- **「到期即有则注入、超时降级为空」（issue 备注的另一选项，会 abort 的预算）** — 落选：若预算到期即 abort 内层，结果被丢弃、缓存不暖，下一轮仍冷 ⇒ 慢检索永远注入不进来，且与 30s TTL 缓存互相抵消。本方案取「到期即有则注入」的**收益**、去掉其「abort」的**副作用**（预算只停等、后台继续暖缓存）。
- **把 abort 透传进 memory-core 子包（在其 service 入口接 `AbortSignal` 并在 LLM 调用处消费）** — 落选：那是改 vendored 子包，违背「子包不随本仓演进」的既有边界，且要把 signal 穿进 `45s×3` 的重试栈，改动面与回归面都远大于在适配层「丢弃结果」。子包真的停不下来是已知取舍——本方案只保证「不采纳、不缓存」幽灵结果。
- **同步 `peek()` 接口（各 provider 暴露缓存命中的同步读，DefaultContextRuntime 只消费 peek）** — 落选：要在 `MemoryResolver` 接口 + 5 个实现（composite/EdgeClaw/patent/legal/case-law）各加一个 peek 并保证语义一致，公开面变更大；且 peek 只能返回**已缓存**结果，冷但快的同步 FTS/DB 检索会被误判为「无」而退到下一轮。注入预算用一个 `Promise.race` 同时覆盖「缓存命中」与「冷但快」，无需新接口。
- **调小 `DEFAULT_MEMORY_RETRIEVAL_TIMEOUT_MS`（把 30s 硬熔断直接降到 2s）** — 落选：硬熔断会 **abort** 并丢弃内层结果（且现在还会触发 `raceAbort` 的丢弃路径），等于「纯后台 + 永不暖缓存」，慢检索永远进不来。注入预算与硬熔断是正交的两层，不能合并。

## Consequences

**换来**：首 token 的最坏等待从 30s 降到注入预算（缺省 2s）；快路（缓存命中、同步检索）行为逐字不变、本轮即注入；被中止/陈旧的检索结果不再污染 TTL 缓存；幽灵内层调用虽无法真停，但其结果被确定性地丢弃、不再注入后续回合；超时/中止这条主链路唯一的「静默降级」分支首次有了回归保护（fake-timer 超时用例 + abort 竞速用例 + 负控制锚点）。

**付出**：

- **慢冷检索的首轮注入延迟到第二轮**。同一 turn 的工具循环里 query 稳定、缓存 30s TTL，第二轮起即命中；但「单轮、冷、且检索慢于 2s」的问答本轮拿不到记忆（下一轮才有）。这是 best-effort 记忆的既定降级面，已用 `memory_retrieval_deferred` info 诊断显式化。
- **`DefaultContextRuntime.ts` 增长 +51 行（902 → 953）**，撞上 P2（#527）刚落地的 file-size 棘轮——该文件是存量豁免文件，棘轮判其「不得再增长」。本次按棘轮设计的**承认动作**处理：`--update-baseline` 显式追认并打印 Δ（`902 → 953（+51）`），在此处与 PR 说明理由。这是棘轮上线后**第一次在真实功能 PR 上转红并被显式承认**，示范了它期望的形态（合法增长必须写进 PR，而不是被顺手刷新绕过）。增量主要是编码「预算 vs abort 解耦」这一非显然契约的注释；若后续该文件继续增长，应优先考虑把记忆装配段拆出独立模块，而非反复追认。
- 新增配置项 `memory.injectionBudgetMs`（正整数，缺省 2000）：进入 `KNOWN_FIELDS`、经 `readOptionalPositiveInteger` 解析。

**未变（刻意）**：`MemoryAttachmentBuilder` 的硬熔断（30s）与 fail-soft 降级语义不动；vendored 子包不动；缓存命中路径逐字不变（既有 15 条 builder 用例 + 4 条 tail-injection 用例全绿）。

## 相关

- issue [#536](https://github.com/xujian519/sati/issues/536)（本 note 关闭）· 登记项 `TD-CONTEXT-N03`
- 棘轮先例（本次 +51 的承认动作依它而定）：`docs/notes/implemented/2026-09-24-gate-ratchet-file-size-and-lower-is-better.md`（#527/#530）
- 源码：`src/context/DefaultContextRuntime.ts`（`raceWithInjectionBudget` + 注入块）、`src/context/memory/EdgeClawMemoryProvider.ts`（`raceAbort` + 丢弃语义）、`src/pilot/config/{types,parseMemoryConfig}.ts`（`injectionBudgetMs`）
- 测试：`tests/context/memory-nonblocking.spec.ts`（预算行为 + 不 abort 内层）、`tests/context/memory/memory-attachment-builder.spec.ts`（超时/中止熔断）、`tests/context/memory/edgeclaw-memory-provider.spec.ts`（abort 竞速丢弃 + 不污染缓存）
- 实施方案：`docs/open-issues-remediation-plan.md` §3.3（P3）
