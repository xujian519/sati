# Contract 与 Parity 测试

本文定义如何证明适配后的 Web UI 与旧 UI 行为一致。核心规则：没有双实现共享场景，就不能声称 parity passed。

## Contract 测试

Contract 测试验证协议形状，不要求同时运行新旧实现。

需要覆盖：

- WebSocket frames：`hello`、`hello_ok`、`request`、`response`、`event`。
- Gateway methods：输入、输出、错误码。
- Gateway events：每种事件的最小字段。
- Web DTO：project、session、message、tool、permission、cron。
- HTTP Web adapter：status code、JSON body、auth、workspace boundary。

Contract fixture 示例：

```json
{
  "id": "submit-turn-basic-stream",
  "method": "submit_turn",
  "input": {
    "sessionKey": "web:test-session",
    "channelKey": "web",
    "projectKey": "fixture-project",
    "message": "hello"
  },
  "events": [
    { "type": "turn_started" },
    { "type": "assistant_text_delta", "text": "hello" },
    { "type": "turn_completed" }
  ]
}
```

## Parity 测试

Parity 测试同时运行 legacy runner 和 new runner：

```text
shared scenario
  -> legacy old_ui runner
  -> normalized legacy report
  -> new PolitDeck runner
  -> normalized new report
  -> deep compare
```

建议目录：

```text
tests/fixtures/web-ui/dual-parity/
  contractScenarios.ts
  executionScenarios.ts

tests/helpers/web-ui/
  legacyReport.ts
  newReport.ts
  normalizeWebUiReport.ts

tests/web-ui/
  parity-dual-contract.test.ts
  parity-dual-execution.test.ts
```

## Scenario 状态

每个 scenario 必须有状态：

- `compare`：旧实现和新实现都运行，归一化输出必须一致。
- `intentional_difference`：输出不同，必须写原因、风险和用户影响。
- `deferred`：旧行为存在，新实现未覆盖，必须写补齐条件。
- `not_applicable`：不迁移，必须写原因。

禁止：

- 没有状态。
- `deferred` 没有原因。
- `intentional_difference` 没有风险说明。
- 失败的 `compare` 被测试静默跳过。

## 必备 Scenarios

第一阶段至少覆盖：

1. `project-list-basic`
2. `session-list-basic`
3. `session-history-text-only`
4. `session-history-tool-call`
5. `submit-turn-text-stream`
6. `submit-turn-tool-call`
7. `submit-turn-error`
8. `abort-turn`
9. `permission-request-allow`
10. `permission-request-deny`
11. `history-pagination`
12. `background-task-session`

Files/Git/Shell/Cron 迁移时追加：

- `file-tree-basic`
- `file-read-text`
- `file-write-text`
- `file-binary-metadata`
- `git-status-basic`
- `git-diff-basic`
- `terminal-open-input-resize`
- `cron-list-create-delete`
- `always-on-run-history`

## 归一化规则

可以归一化：

- 绝对路径中的临时根目录。
- timestamp。
- duration。
- PID。
- UUID 的随机部分。
- WebSocket `seq` 起始值，只要相对顺序一致。

不能归一化：

- success vs error。
- error code。
- permission allow vs deny。
- tool name。
- tool input 的语义字段。
- tool result 是否为 error。
- assistant 文本中对用户可见的关键内容。
- 文件写入后的内容。
- session 是否可恢复。

## Contract Parity 与 Execution Parity

术语必须精确：

- Contract parity passed：协议字段、状态、错误码、schema 级行为一致。
- Execution parity passed：旧实现和新实现执行同一个场景，归一化输出一致。

如果只跑了 fake Gateway 或单边实现，只能说 contract test passed，不能说 execution parity passed。

## 报告格式

每个 parity report 至少包含：

```json
{
  "scenarioId": "submit-turn-tool-call",
  "status": "compare",
  "runner": "new",
  "ok": true,
  "events": [],
  "messages": [],
  "errors": []
}
```

测试必须校验：

- scenario id 唯一。
- legacy 和 new report 的 scenario set 一致。
- 非 `compare` scenario 有 reason。
- `compare` scenario 的 normalized output 深比较一致。
- intentional difference 不进入深比较，但进入 summary。
