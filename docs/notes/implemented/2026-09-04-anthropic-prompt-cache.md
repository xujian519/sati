# Agent Note: Anthropic prompt cache 稳定布局（system + recent3）

Status: implemented

## Problem

Anthropic 按前缀缓存计价（命中读约 0.1x、写 1.25x）。Sati 此前只在微压缩边界间歇产生 `cacheBreakpoints`（`CachedMicroCompactionEngine`），多数请求没有任何打点、请求间布局不稳定——缓存命中率低，长会话（专利管线单会话 token 量巨大）付全价输入。移植自 PilotDeck `desktop-v2026.09.02` #527（`CachePlan.ts` system+recent3 布局）。

## Decision

**布局**：每个 Anthropic 请求固定打 4 个 `cache_control` 块（Anthropic 单请求上限）：system prompt 尾块 + 最近 3 条消息的尾块。逐层实现：

- `src/model/protocol/canonical.ts`：`PromptCachePlan` 协议类型（provider/model/system/messages/fingerprint/generation）+ `CanonicalModelRequest.cachePlan?`（存在时优先于 `cacheBreakpoints`）；
- `src/context/cache/CachePlan.ts`（新模块）：
  - `buildPromptCachePlan`：布局 + 稳定指纹（key 排序序列化 + sha256；工具按 name 排序后入指纹，避免注册顺序漂移导致缓存失效）+ 单调 generation；
  - `resolveRequestCachePlan`：禁用（`SATI_PROMPT_CACHE=off`）/存在显式微压缩断点/空消息 → undefined（回退旧行为），否则产出计划；
- `anthropic/request.ts`：`cachePlan` 优先消费（system 打点由 `plan.system` 决定），无 plan 时保持 `cacheBreakpoints` 旧语义；
- `AgentLoop.createModelRequest`：接线 `resolveRequestCachePlan`——启用条件 = 环境开关开 + provider 协议为 anthropic（经新增可选依赖 `AgentRuntimeDependencies.getProviderProtocol`，gateway 装配处接 `runtime.model.getProviderProtocol`）+ 无显式断点；
- `streaming/continuationRequest.ts`：流续传请求清空 `cachePlan`/`cacheBreakpoints`（消息序列已变，旧断点必错位）。

**前缀稳定性约束（Sati 特有）**：逐调用可变的 synthetic 注入（J-Space 账本 `<workspace-state>` 块、repeatToolReminder 提醒、未来的 steer 消息）必须位于最近 3 条断点之后（消息尾部注入）。现状核实：repeatToolReminder 与账本注入均为尾部追加（`workspaceLedgerBlock` 经 injections 通道），天然满足；该约束作为 CachePlan 模块文档约定，后续新注入点必须遵守。

**可观测**：不新增遥测面——`CanonicalUsage.cacheReadTokens/cacheWriteTokens` 已有解析与透出，配合 plan 的 fingerprint/generation（log-only 场景可从请求对象读取）即可验证命中率。

## Alternatives considered

- **微压缩断点之外补打 system 断点（最小改）** — 落选：消息侧断点仍间歇、布局不稳定，命中收益有限；上游验证的固定布局一次到位。
- **工具列表也打点（tools: true）** — 落选（上游同样 tools: false）：Sati 工具集大且按域裁剪（visibleDomains），工具段内容随角色变化频繁，打点反而制造写 miss（1.25x 写费）。
- **把 prompt cache 观测并入 request_header 快照** — 落选：request_header 是 digest-only 契约，加字段涉及快照类型与对拍器联动；usage 的 cacheReadTokens 已足够验证，需要时再扩展。
- **在 DefaultContextRuntime（prepare 层）构造 plan** — 落选：prepare 层不知道目标 provider/model（路由后才知道），plan 构造必须在 loop 的 createModelRequest（provider 已定）；CachePlan 模块保持纯函数、loop 一行接线。
