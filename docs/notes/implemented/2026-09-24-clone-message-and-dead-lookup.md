# Agent Note: 历史重建克隆改用共享 `cloneMessage` + 删两处零消费 `lookup()`（#535 · #541）

Status: implemented

## Problem

`docs/open-issues-remediation-plan.md` §3.8（P8·微优化与去重）的两条独立小债，同批交付、各自成提交面：

### #535（TD-WEB-N01 + TD-GATEWAY-003）

- **TD-WEB-N01（代码面）**：`src/web/server/readSessionMessages.ts` 在缓存 miss 的历史重建热路径上，用一个**局部** `cloneMessage` 对每条 `CanonicalMessage` 做 `JSON.parse(JSON.stringify(message)) as CanonicalMessage`。该实现：① 丢弃 `undefined` 值的自有键；② 对 BigInt/循环引用抛错；③ 每条消息一次全量序列化 + 反序列化；④ `as CanonicalMessage` 裸断言绕过类型检查。仓内**早已有**结构化克隆工具 `src/model/protocol/clone.ts` 的 `cloneMessage`（经 `src/model/index.ts:104` barrel 导出），按 content block 逐块克隆、`tool_call.input` 走 `structuredClone`、类型完备。
- **TD-GATEWAY-003（登记面）**：`backlog.md` 的 active-turn 重放缓冲条目**位置失效**（写 `:1082-1095`，实际 `recordActiveTurnEvent` 在 `:1268-1283`），且描述「维护可能无人读的重放缓冲」**与代码矛盾**——该缓冲有完整消费链（`getActiveTurn`/`activeTurnProjectionPayload :824-858` 服务断线重连的 active-turn 恢复），照字面「仅在存在消费者时维护」删除会破坏重连恢复。

### #541（TD-EXTENSION-N08）

`ModelWindowStore.lookup()`（`src/model/window/store.ts:135`）与 `HookTrustStore.lookup()`（`src/extension/plugins/trust/HookTrustStore.ts:78-80`）是一对同构的一行便捷查询（`this.read().entries[key(...)]`）。二者**零生产调用者**（`grep -rn "\.lookup(" src/` 命中的全是 patent 的 atom/handler 注册表，属不同类的同名方法），只有测试在用；而每次调用都触发一次**整表** `readFileSync` + parse。`store.ts:134` 的注释还写着「单条查询（解析期热路径）」——这是一条**误导性诱导面**：它邀请后来者在热路径「照注释接线」，而每次接线都是一次整表重读。

## Decision

### #535(a)：删局部 JSON 深拷贝，改用共享 `cloneMessage`

删除 `readSessionMessages.ts` 的局部 `cloneMessage`，改从 `../../model/index.js` 导入共享实现。语义差异已核实**无回归面**：

- 下游 `flattenCanonicalMessage` 对 `CanonicalMessage` **只读不改**（仅取 `message.role`、`message.metadata?.compactReplacement`），故共享 `metadata` 引用安全；
- `src/web/server/` 无对这些消息的写回路径；
- `content: undefined → []` 的归一语义由 `messageContent` 提供，已有测试锚定；
- transcript 是 JSON 产物，`structuredClone` 对其中的 `undefined`/嵌套结构均可处理，不会像 JSON 深拷贝那样丢键或抛错。

### #535(b)：只更正登记文字，不动网关代码

`TD-GATEWAY-003` 是**伪优化陷阱**（plan §6.1 fork 2）：`cloneGatewayEvent`(`structuredClone`) + 字节计量 `JSON.stringify` ≈ 1.1 µs/事件，2000 个 delta 累计约 2.3 ms CPU，实测开销小；真实成本中心在**投影全文累积**（`block.text += event.text`）与**快照整段复制**，那是改数据结构的重构，超出本 issue 登记范围（另立条目评估）。故本项**仅**：把 `backlog.md` 的位置更正为 `:1268-1283`、删除「可能无人读」的错误描述、补充消费链事实、按实测定级 **P3**、并把状态注明「仅更正登记不改行为」。同步把 `TD-WEB-N01` 标 `done`。

### #541：删 `lookup()`（删除优于改注释）

删除两处 `lookup()`，测试调用点改为直接 `store.read().entries[key(...)]`（`modelWindowKey`/`hookTrustKey` 均已从各自 barrel 导出）。**删除优于「改注释」**：零生产调用者 + 每次调用整表重读，删除同时消灭死代码与「照注释接线」的诱导面；改注释只是把诱导面换了措辞。

**同批明确不做**（各留理由，防反复提出）：

- **① 抽共享存储层——不做。** issue 自设触发条件是「下次改动这两个 store 之一，或需要新增第三个」——**今天不满足**；且两段实测 diff 172 行、两实体语义差异大（`store.ts` 另有 `forget`/`mergeModelWindowEntry`/取小合并等专属逻辑）。若将来触发，方向是**纯函数层** `src/shared/persist/versionedJsonFile.ts`（`parseVersionedFile<T>` + 写函数）而**非继承基类**（避免为复用而耦合两条独立演化线）。
- **③ barrel 收敛——不做。** 实测 196 个导出中 84 个模块外零消费（issue 写 225/92，已更正），issue 点名的 6 个常量全部零命中✓；但 barrel 收敛是**公开面变更**（须走决策记录 + 可能牵动下游 import），**收益为 0 而成本最高**，不满足「微优化」批次的性价比门槛。

## Alternatives considered

- **#535(a) 保留局部实现但换成 `structuredClone(message)`** — 落选。仓内已有语义更精确、类型完备且被多处复用的 `cloneMessage`（对 content block 分类处理、`raw` 刻意共享）；再养一个局部克隆是重复实现，且 `structuredClone` 整条消息会连 `metadata` 一起深拷贝（比必要的更深）。复用共享工具面更小、语义单一源。
- **#535(b) 照 issue 字面「仅在存在消费者时维护」改网关代码** — **否决**。重放缓冲**有**完整消费链（重连恢复），字面执行会破坏断线重连；且真实成本中心不在这里（伪优化）。只更正登记。
- **#541 改 `lookup()` 的注释而非删方法** — 落选。见 Decision：删除同时消灭死代码与诱导面，改注释只换措辞、诱导面仍在，且零生产调用者意味着删除无破坏面。
- **#541 本批顺带抽共享基类** — **否决**（plan §6.1 fork 1）。触发条件未满足、语义差异大、继承会耦合两条独立演化线。
- **#541 本批顺带做 barrel 收敛** — **否决**。公开面变更、收益为 0、成本最高。

## Consequences

- **正向**：① 历史重建热路径不再对每条消息做 JSON 序列化往返，`undefined` 值字段不再丢失，BigInt/循环引用不再抛错，且去掉了裸 `as` 断言；② 两处零消费的整表重读死方法及其误导注释被消灭；③ `TD-GATEWAY-003` 登记与代码事实一致（位置 + 消费链 + 定级）。
- **行为等价**：`readWebSessionMessages` 对同一 transcript 的输出与替换前逐字等价——由既有 `tests/web/read-session-messages-cache.spec.ts`（`deepEqual` 断言 + 分页/内容序）作为回归护栏覆盖；克隆语义的**改进面**（undefined 保留、逐块新引用、input 深克隆隔离、raw/metadata 共享契约）由新增 `tests/model/protocol/clone.spec.ts` 直接钉住，其中「保留显式 undefined 值字段」是**负向对照**——若有人把 `cloneMessage` 回退成 JSON 深拷贝，`"signature" in`/`"b" in` 两处断言立即转红。
- **公开面**：`ModelWindowStore`/`HookTrustStore` 各少一个方法。因零生产调用者，仅测试受影响（4 个测试文件、9 处调用点已同步改为 `read().entries[key(...)]`）。`clone.ts` 公开面不变。
- **门禁联动**：无事件 emit 行移动（`recordActiveTurnEvent` 未改）、无协议方法/版本变更、无 i18n、无 `inputSchema` 改动（不触发 llm-replay 重录）。改动文件均不在 `architecture-baseline.json` file-size 豁免清单，`store.ts`/`HookTrustStore.ts` 因删方法**净减行**、`readSessionMessages.ts` 净减 3 行 ⇒ 不触棘轮。行数变动跑 `pnpm measure:update`；`backlog.md` 登记更正属文档面。
- **验收对照 plan §3.8**：① 输出逐字等价（cache spec 覆盖）✓；② `undefined` 不再丢失（clone.spec 负向对照）✓；③ 两个 store 的 `.lookup(` 在 `src/` 归零、4 个测试文件同步绿 ✓（注：`src/patent/**` 的 atom/handler 注册表 `.lookup()` 是不同类的同名方法，不在本 issue 范围，保留）。

## 相关

- 议题：`#535`（TD-WEB-N01 + TD-GATEWAY-003）· `#541`（TD-EXTENSION-N08）。两条独立、各自成提交面（plan §5）。
- 代码：`src/web/server/readSessionMessages.ts`（删局部 clone、导入共享）· `src/model/protocol/clone.ts`（被复用，未改）· `src/model/window/store.ts` / `src/extension/plugins/trust/HookTrustStore.ts`（删 `lookup()`）。
- 测试：`tests/model/protocol/clone.spec.ts`（新增）· `tests/web/read-session-messages-cache.spec.ts`（既有等价护栏）· `tests/model/window/{store,probe}.spec.ts`、`tests/extension/plugins/hook-trust-gate.spec.ts`、`tests/cli/hook-trust-service.spec.ts`（同步改调用点）。
- 方案：`docs/open-issues-remediation-plan.md` §3.8 · §2.3 第 5/6 条 · §6.1 fork 1（#541 三项）/ fork 2（#535 是否顺带优化投影）。
