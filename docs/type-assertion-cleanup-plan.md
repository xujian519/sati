# 类型断言收敛分步切片计划（TD-TYPE-002 / #163）

> 定位：`docs/*-plan.md` 实施计划（决策背景见 `docs/notes/implemented/2026-08-23-type-assertion-cleanup-priority.md`）。
> 遵循排期：`docs/technical-debt/next-batches-schedule.md` §7 复评结论 ① —— **全项目 ROI 最高的单项**，纯机械、`typecheck` 自验证、无 UI、不触碰 `inputSchema`、不使 llm-replay fixture 失配。

## 目标与边界

- **目标**：把全源码 >90 处类型强转/断言收敛为类型守卫、row-mapper 或精确结果类型，让入参/结果/DB 行在编译期恢复形状校验。
- **不做**：不改任何工具 `inputSchema`（含描述文本）；不改运行时行为（守卫只在类型层收窄，若守卫失败须 fail-loud，不得静默降级）；不做事件面改版（不触及 `check:event-matrix`）。
- **验证**：每片 `pnpm typecheck`（自验证）+ 相关模块单测；整批复排后 `pnpm check`（含 lint/biome/格式）。涉及核心模块（`tool/` `gateway/` `model/` `knowledge/` `patent/` `router/`）每片须附测试（AGENTS 铁律 8）。

## 分片（每片独立 PR，按顺序）

### 片 1 · `gateway/GatewayWsConnection.ts`（`as never` ×43，最大块）

- **位置**：`dispatchRequest` 内约 40 处 `frame.params as never`（`:150 submit_turn`、`:228-380 ` 的每个 case）+ 服务端 method 调用。
- **根因**：`WsRequestFrame.params` 是 `unknown`（`frames.ts:73`），而各 method 需要精确的入参类型，分发器用 `as never` 绕过类型系统。
- **修法**：为每个 method 引入**入参窄化守卫**（`isXParams(value): value is XParams`），分发器改为按 method 窄化；对 `submit_turn`/`fork_session` 等带返回类型的，由 `Gateway` 接口方法签名回推。若无守卫的依据，退一步用**精确结果类型**替换 `as never`（如 `as GatewaySubmitTurnInput`），并在无法构造时 `throw` 而非静默。
- **测试**：`tests/gateway/` 补 `dispatchRequest` 的 per-method 守卫正/反用例（复用现有 gateway spec 基础设施）。

### 片 2 · `gateway/client/RemoteGateway.ts`（`as XResult` ×29）

- **位置**：`:90-278`，每方法 `(await this.client.request(...)) as XResult`。
- **根因**：`GatewayWsClient.request()` 返回 `Promise<unknown>`（`GatewayWsClient.ts:134`），客户端侧逐方法强转结果。
- **修法**：给 `GatewayWsClient.request` 增加结果类型参数——`request<T>(method: WsGatewayMethod, params: unknown): Promise<T>`，`RemoteGateway` 各方法改 `this.client.request<XResult>(...)`，消除 `as XResult`。
- **测试**：`tests/gateway/` 已有 client 层测试；补一个「`request<T>` 泛型类型回推」编译期用例（`satisfies` 或赋值断言）即可，运行期行为不变。

### 片 3 · `knowledge/**` DB 行强转（`as X`/`as X[]` ×40）

- **位置**：`shared/kg-store.ts:103`（`as NodeRow | undefined`）、`case-law-search.ts`（多处）、`legal-search.ts`、`knowledge-law-search.ts`、`shared/knowledge-embeddings.ts`。
- **根因**：node:sqlite / better-sqlite3 的 `get()/all()` 返回行类型被裸 `as` 假定。
- **修法**：为 COUNT/PRAGMA/行读取加**轻量 row-mapper**（已存在 `shared/kg/row-mapper.ts` 的 `toNode`/`NodeRow`，遵循同模式）或窄化守卫；`as []`/`as X[]` 处统一改走 mapper 返回类型。若某查询确实可空，用显式 `mapRow` 返回 `T | undefined` 供调用方判别。
- **测试**：`tests/knowledge/` 为每次改动的 mapper 补行级用例（已知 kg/fts 已有地基）。

### 片 4 · `model/` 双强转（`as unknown as X`）

- **位置**：`streamModel.ts:361,402`（`as unknown as GoogleRequestBody`）、`providers/google/request.ts:107`（`as unknown as GenerateContentConfig["thinkingConfig"]`）。
- **根因**：`buildModelRequest` 产出通用 protocol body，传到 Google SDK 具体类型时双强转。
- **修法**：为 per-protocol 提供带类型 build 入口（如 `buildModelRequest(request, ...)` 已泛型），调用点使用 `satisfies GoogleRequestBody` 校验或在 build 侧返回窄化类型，去掉双强转。
  - ⚠️ 落地时发现 `google/request.ts:107` 的 `as unknown as thinkingConfig` 实际掩盖了**大小写失配**（本地 `"low"|"medium"|"high"` vs SDK `ThinkingLevel` 大写枚举），已改为显式映射 `GOOGLE_THINKING_LEVEL` 并补 decision note（`docs/notes/implemented/2026-08-23-gemini-thinkinglevel-enum.md`）。
- **测试**：`tests/model/` provider 协议已有 fixture；补 `streamModel.ts` 单测断言 `generateContent(body)` 收到形状正确的 body。

### 片 5 · `patent/` 双强转与行断言

- **位置**：`provenance/provenance-store.ts:250`（`as unknown as AgentRow[]`）、`evidence/receipt.ts:224,232`（`as unknown as TeamEvidenceDeclaration`/`Receipt`）、`evidence/engine.ts:783-784`（`weights[i]!`）、`graph/adapter.ts:97`（`manifest.stages[0]!.id`）。
- **修法**：为 DB 行/账本行加 row-mapper 或边界守卫；`!` 非空断言改为显式取值 + 失败时 `throw`（正确性关键路径不应因缺项而静默错位）。
- **测试**：`tests/patent/` 对应模块（provenance/receipt/graph）补守卫用例。

### 片 6 · `router/`、`tool/` 零散断言

- **位置**：`router/config/parseRouterConfig.ts:338,465,492,505`（`as string[]`）；`tool/userInteractionConstraints.ts:39`（`{} as never`）、`tool/builtin/readFile.ts:116`（`as ReadFileInput`）、`tool/askModeConstraints.ts:39`（`{} as never`）、`tool/builtin/web/urlFetcher.ts:126-127`（`as unknown as ...`）。
- **修法**：`as string[]` 用窄化守卫（`Array.isArray` + 元素类型判别）；`{} as never` 改为读取具体字段或 `satisfies`；`ReadFileInput` 用类型守卫；urlFetcher 的 `as unknown as` 用 `satisfies` / 守卫。
  - ⚠️ `userInteractionConstraints.ts:39` 与 `askModeConstraints.ts:39` 的 `{} as never` 属**存在性探测**（「是否只读」），收敛时须保留探测语义，只换成类型化访问，不改变返回结果（否则破坏读工具白名单行为）。
- **测试**：`tests/router/`、`tests/tool/` 对应模块补守卫用例。

## 每片提交清单

1. 改动类型守卫/row-mapper + 调用点。
2. 附对应模块单测（守卫正/反用例）。
3. `pnpm typecheck` 绿；`pnpm lint` + `pnpm format:check` 过；涉及模块 `pnpm test` 绿。
4. **不触碰** `inputSchema`（含描述文本），无需重录 llm-replay fixture；不攻事件面。

## 风险与回退

- **守卫失败向量**：本计划强调「守卫失败须 fail-loud」，与部分现状「静默降级」语义不同。逐片评审时确认目标路径期望：数据损坏/缺项属「应报错」，而非「悄悄为空」——这与 `TD-*` 若干「静默吞错」条目互为表里，属同源安全收束。
- **`tool` 的存在性探测**（片 6）行为最敏感，单独评审，默认先做不改语义。
- 若某片改动导致 `pnpm check` 出现既有 `check:event-matrix` 或 `check:patent-*` 门禁异动，回退该片并记录——本计划预期零事件面/零资产变更，出现异动即说明越界。

## 排期对齐

- 与 `next-batches-schedule.md` §2 阶段一（#163 独立切片先行）一致。
- 片 1–2（gateway）与片 3（knowledge）为最大两片，优先；片 4–6 可穿插 `#162` 的 `cli` 部分。
