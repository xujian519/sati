# P2.4 — dispatchRequest switch → methodDispatchers 查表（GatewayWsConnection）

- 日期：2026-10-14
- 批次：issue #646 sweep · P2.4（计划 D9–D18 段）
- Commit：见本 PR

## 变更

`src/gateway/server/GatewayWsConnection.ts` 的 `dispatchRequest`（353 行 switch）
改为 `methodDispatchers` 查表，与 `methodGuards.ts` 的 `METHOD_PARAM_GUARDS`
**同构的 `Record<WsGatewayMethod, dispatcher>`**（守卫表反推分发，计划 P2.4 判据）：

- **required Record**：`WsGatewayMethod` union 新增方法名时 typecheck 强制补表项；
  旧 switch default 的「Unknown gateway method」收敛为 `dispatchRequest` 唯一防御分支。
- **两个调用 helper** 消掉逐 case 样板：
  - `callMethod`：必实现直连（结果原样回，可选 map 变换——`abort_turn`/`close_session`
    的 `{ok:true}` 包装）；
  - `callOptional`：可选方法未接线时回退 `fallback(params)`（not_configured 降级或
    合成默认），回退形态留在表项里一眼可见。
- **保留的特例**（不进 helper，避免过度抽象）：
  - `close_project_sessions`：未接线抛 `GatewayMethodUnavailableError`（显式失败，
    调用方据结果决定能否删目录——不得降级）；
  - `skill_*` 八个：经 `requireSkillMethod` 绑定（未接线抛结构化 `SkillManagerError`）；
  - `kanban_subscribe`/`kanban_unsubscribe`：走连接级 subscriber 与连接持有的 manager；
  - `submit_turn`：由 `handleRequest` 事件流分支（16ms 缓冲 + final 帧）特判处理，
    不进入本表，表项为占位（语义对齐旧 default 抛错）。
- **行为对照**：逐 case 核对旧 switch 的 74 个方法名映射、fallback 文案与默认值
  （含 `prepare_weixin_login` 分发时合成时间戳、`active_turn_snapshot` 回显
  sessionKey 的合成默认）。
- 测试：dispatch.spec 10 → 15（新增合成默认快照 / prepare_weixin_login 时间戳 /
  kanban_get not_configured / kanban_subscribe 已接线订阅 / 守卫先行拦截五条表路径回归）。

## Alternatives considered

1. **按「可选/必填」从 Gateway 接口类型推导回退形态**：`Gateway` 的可选性
   （`method?:`）在类型层可见，但回退是 not_configured 还是合成默认、文案是什么，
   都是行为契约，无法用类型表达——保留显式表项，选运行时可读。
2. **双层表（method → 形态枚举 → 统一执行器）**：形态差异（map 包装 / fallback
   参数化 / 抛错）杂度高，统一执行器会变成条件拼装，单分支理解成本高于收益。
3. **把表外置为模块级函数（传 gateway/kanban）**：kanban_subscribe 依赖
   连接级 `kanbanSubscriber` 字段，外置需把 subscriber 作为参数穿透，反而更绕；
   类字段箭头保持 `this` 闭包，表项即原 case 体的直接搬运。

## 验收

- 判据：「守卫表反推分发」——dispatch 表与 METHOD_PARAM_GUARDS 同为
  `Record<WsGatewayMethod, …>` required，新增方法名两处编译期同时强制补项。
- `dispatchRequest` 353 → 11 行；god function 60 → **59**（metrics 基线随本 PR 刷新）。
- 文件 658 → 619 行（<800 棘轮不受影响）。
