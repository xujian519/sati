# Agent Note: 网关协议方法台账与版本门禁

Status: implemented

## Problem

网关「协议方法」这一事实曾有三处手写副本：`frames.ts` 的 `WsGatewayMethod` 联合、`methodGuards.ts`
的参数守卫表、`version.ts` 顶部的散文变更表。它们靠人工保持同步，而 MINOR 版本号恰好是
`feature-detect` 与 `not_configured` 降级的依据——漏登记会让旧客户端对不存在的方法乐观发帧。

核代码发现「三处都没有门禁」是错的：守卫表早已由 `satisfies Record<WsGatewayMethod, ParamSpec>`
编译期把关。**真正完全无门禁的只有散文变更表**，而它已经漂移两次，只是没人发现：

| 方法 | 进入 `frames.ts` | 当时版本常量 | 散文变更表 |
|---|---|---|---|
| `knowledge_capabilities` | 2026-08-06（`4963184ed`） | 1.1 | 从未登记 |
| `kanban_reorder_columns` | 2026-08-26（`28f8b119c`，Phase 5.1 列拖拽排序） | 1.5 | 从未登记 |

两种既有「覆盖」都没有牙齿：`discovery-protocol.spec.ts` 用
`assert.ok(["1.1",…,"1.8"].includes(V))`（对 8 个取值全部通过，1.9 发布时也会通过）；
`steer-protocol.spec.ts` 用 `startsWith("1.")` 与自比 `isProtocolCompatible(V, V)`。

## Decision

`src/gateway/protocol/version.ts` 的散文变更表升级为**机器可读台账**，三处把关：

1. **编译期**：`PROTOCOL_METHOD_VERSION` 以
   `satisfies Record<WsGatewayMethod, GatewayProtocolVersion>` 声明。实测三种形态全部报错——
   缺键 `TS1360`、版本值越界 `TS2322`、多余键（幽灵方法）`TS2353`。
2. **运行期**（`pnpm check:protocol-version`，`scripts/check-protocol-version.ts`，挂 `pnpm lint` 链尾）：
   从 `frames.ts` 的 AST **重新提取**联合成员，与台账模块值做两向集合相等，并检查守卫表覆盖；
   解析不到成员时**显式 exit 1**（静默空集会让门禁变成恒真）。判据的两侧是独立生产点
   （声明侧 AST / 数据侧模块值），非同一份入参派生。
3. **纯函数**：`protocolLedgerIssues()` 校验版本序列严格升序且连续（1.0…当前无空洞）、
   每个 MINOR 都被 credit（有新方法或有 `changes` 说明）、方法登记在已声明的版本上、
   版本常量等于台账末条。副作用是**版本常量改为由台账末条派生**，bump 与登记不可能各改一处。

两处历史漂移按引入时点回溯登记（`knowledge_capabilities` → 1.1，`kanban_reorder_columns` → 1.5）
⇒ 台账末条仍是 1.8，**本次不需要 bump 协议版本**（无契约变更）。

两处弱断言替换为强断言：`discovery-protocol.spec.ts` 钉字面量 `"1.8"`；
`steer-protocol.spec.ts` 改为断言 `常量 === 台账末条` + 跨版本兼容语义（低 MINOR 双向可连、
异 MAJOR 拒连），删掉 `startsWith` 与自比。

## Alternatives considered

- **按 issue 原文「三份副本都没有门禁」直接加一个 union ⊆ 散文表 的断言** — 散文表是注释、不是数据，
  唯一可解析方式是正则匹配中文句子。既不稳健（改标点即失配），也无法覆盖「幽灵方法」方向。
  落选：把注释换成数据才是根治，注释只保留人类可读的 `note`。
- **只留编译期 `satisfies`，不写运行期脚本** — 实测把 `satisfies` 写成 `as Record<…>` 即整体绕过，
  typecheck 全绿而漂移照旧。落选：运行期 AST 复核是独立机制，不是冗余（已用负控制单独证明）。
- **只留运行期脚本，台账写成普通 `Record<…>`** — 失去「漏键 = 编译失败」这一最便宜的反馈（写代码时即报，
  不必等 CI）。落选：两者互补，代价只有约 100 行。
- **引入「冻结基线」以判定「登记在当前版本却未 bump」** — 需要发布历史（git tag / 上一个 package 版本）
  作为第二事实源才能判定；用生成器产基线是自派生（生成物由台账算出 ⇒ 恒真，正是 #360 的教训）。
  落选并**登记为残余缺口** `TD-GATEWAY-N02`，而不是用假判据掩盖它。
- **借本次把 `knowledge_capabilities`/`kanban_reorder_columns` 报到当前版本（1.8）** — 会让「自 1.8 起可用」
  这一事实对被 1.8 语义服务的旧客户端失真。落选：按引入时点回溯才诚实，且恰好不需要 bump。
- **把台账拆成独立文件 `protocol/releases.ts`** — 能减小 `version.ts`，但会让「版本常量」与「变更台账」
  分居两文件（正是本次要消除的分离）。落选：同文件才看得出两者必须一致。

## Consequences

- 新增 gateway 方法若漏登记，`pnpm typecheck` 与 `pnpm lint` **都会红**，且运行期门禁会**逐一点名**；
  本轮负控制即从台账摘掉那两个方法，门禁与编译期各点名同样两条。
- `version.ts` 从 67 行增至约 300 行，其中约 70 行是方法→版本映射（数据）；`pnpm lint` 新增一次
  AST 解析（同 `check:event-matrix` 量级，非瓶颈）。
- 已发布条目的 `note` 允许补正文字，但**不得搬动版本号**——搬动会让旧客户端对不存在的方法乐观发帧。
- 残余缺口（已登记）：把新方法登记在**当前**版本而不 bump，本判据**无法**判定（需要发布历史）。
  这与「漏登记」是两回事，前者已堵死。
