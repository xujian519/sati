# P2.3 — emitSessionTelemetry switch → 查表（telemetry.ts）

- 日期：2026-10-14
- 批次：issue #646 sweep · P2.3（计划 D9–D18 段）
- Commit：见本 PR

## 变更

`src/gateway/client/telemetry.ts` 的 `emitSessionTelemetry`（333 行 switch）改为
`AGENT_EVENT_TELEMETRY` 查表 + 三个打点 helper，与 P2.2（eventMapping）同构：

- **required Record**：`{ [K in AgentEvent["type"]]: SessionTelemetryMapper<K> }`，
  AgentEvent union 新增种类时 typecheck 强制补表项；旧 switch 的 `default: return`
  静默吞新事件，收敛为 `emitSessionTelemetry` 里唯一的防御分支。
- **helper 投影公共字段**：`sessionTrackContext`（module="session" + context 投影）、
  `trackLoopStage` / `trackSessionError`（表项只写差异字段）、
  `trackModelStreamTelemetry`（model_event 与 subagent_model_event 共用，
  差异仅为 executionKind / extraMetadata / permissionMeta）。
- **行为不变**：逐分支对照旧 switch（含 `post_tool_execute` 失败时才带
  `errorCategory`、`tool_result` 仅 error 打点、`subagent_tool_result`
  error 不打 success stage 等条件分支）。
- 测试：`tests/gateway/client/telemetry.spec.ts` 7 → 10（新增 failed tool /
  subagent 身份 metadata / permission_denied 形状三条表路径回归）。

## Alternatives considered

1. **保留 switch，只抽 helper**：能减行数但保留 default 静默吞新事件的缺口；
   required Record 把「新增事件种类必须显式决定打不打点」变成编译期义务，选查表。
2. **按 loopStage 建第二层表**（model_request/tool_call/… → 参数模板）：两层间接
   后单分支理解成本高于收益，且 metadata 形状各异，模板化会引入条件拼装。
3. **不合并 model_event / subagent_model_event 两个分支**：重复 ~80 行；
   差异点（executionKind、extraMetadata、permissionMode/channelKey）参数化后
   一处定义，行数换可读性，可接受。

## 验收

- 判据：`emitSessionTelemetry` ≤150 行 → 实测 ~16 行（helper 最大 ~55 行）。
- god function 计数：61 → 60（metrics 快照随本 PR 更新）。
- 事件矩阵：telemetry.ts 不在 producer-consumer 矩阵内，无需重生成。
