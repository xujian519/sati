# Agent Note: 检索质量门按检索源数量分层阈值

Status: implemented

## Problem

`quality-gate` 的确定性门槛固定为「对比文件 ≥ 3 篇、全文 ≥ 2 篇」，与检索源数量无关。`paperSearch: false` 时只剩 nuo 一个专利库，3 篇对比文件与 2 篇全文并不总能达到；门禁仍然判未通过并挂 HITL。后果有两类：合法检索被反复退回，或模型为了过门而凑数/把同一篇拆成多篇——后者比放宽门槛更糟。

## Decision

- `StageProvider` / `WorkflowProviderDeps` 新增可选 `sourceCount`。语义是**装配时启用的检索源数量**（`createBuiltinRegistry` 传 `searchSources.length`，`paperSearch: false` 时为 1），不是本次运行成功源数。
- `checkSearchQuality(text, { sourceCount })` 按源数选门槛：
  - `sourceCount === 1` → `minDocs: 2`、`minFulltextMarks: 1`（相关度标注 1 处、布尔检索式、IPC 限定不变）；
  - 缺省、`0`、`≥2` → 沿用多源严格门槛（`3 / 1 / 2`）。
- 返回值新增 `sourceCount`、`thresholdsAdjusted` 与实际使用的 `thresholds`，供报告与审计；`quality-gate` 在放宽时输出「单源检索，阈值已调整」并写出具体门槛。
- 只有装配时恰好一个源才放宽：运行期某个源失败**不会**把源数改成 1（否则失败越多门槛越低）。

## Alternatives considered

- **全局放宽到 2 篇 / 1 篇全文** — 多源检索本来能拿到更多证据，统一放宽会降低门槛且掩盖检索失败；分层才有意义。
- **按本次成功源数动态放宽** — 听起来更「准」，但激励反向：一个源挂了反而更容易过门。要做对需要每次运行记录源级成败并把结果写进 run 审计，超出本卫生项；如确有必要另开 issue。
- **保持严格，只把失败降级为警告** — 门禁的用途就是阻止证据不足的产出进入 HITL；改成警告等于取消门槛，还会让「未通过」与「通过」不可区分。
- **把 sourceCount 放进 `PipelineState`** — state 是模型可见、可写的运行数据；装配配置放进 provider 注入点，模型无法通过写 state 放宽门槛。
- **用公式缩放（如 `max(2, 3 - (sources - 1))`）** — 只有 1 源与多源两种形态，公式增加理解成本，报告里也难以一句说清；两组常量更直接。

## Consequences

- 单源运行的 HITL 报告会明确写出「阈值已调整」与调整后的数字，审计能解释为什么 2 篇通过。
- 未注入 `sourceCount` 的路径（自定义 `deps.search`、flexible-plan 的 provider 装配）继续按严格门槛，避免把未知源数误判为单源。
- 无工具 schema、manifest、事件面变更，无需重录 llm-replay。
- 单源放宽只影响检索质量门，不改变检索源本身的行为。
