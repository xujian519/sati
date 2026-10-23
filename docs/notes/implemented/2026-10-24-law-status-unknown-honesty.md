# Agent Note: 法条效力状态未知不再伪造成现行有效

Status: implemented

## Problem

`knowledge.db` 的 `documents` 表没有 `expired` / `valid_from` 列，但 `KnowledgeLawSearch.toRecord()` 为每条记录写死 `expired: 0`。工具层与记忆渲染层把 `0` 当作「现行有效」的硬数据，于是 2008 版《专利法》也会被呈现为现行法。这不是查询过滤缺失，而是输出欺骗：调用方无法区分「数据源确认有效」与「数据源没有这个字段」。

## Decision

`LawRecord.expired` 改为可选；knowledge.db 后端省略该字段，只有 laws-full 的 legacy 行继续透传 `0` / `1`。`law_search` 的结果逐条携带 `statusSource`：

- `db`：`expired` 或 `publish` 日期来自数据源；
- `version-meta`：离线版本沿革文件覆盖；
- `unknown`：数据源未提供效力字段。

当 `expired` 缺失且没有版本位置可判定时，`status` 标为「待核验」，不再留空让下游自行默认成现行有效。记忆渲染层只在 `expired === 1` 时派生「已废止」，`undefined` 不参与失效判定。

## Alternatives considered

- **保留 `expired: 0` 并在工具描述里提示不可信** — 提示词约束挡不住下游程序按字段值判断，伪事实仍会传播。
- **把 `expired` 改为必填并让 knowledge.db 抛错** — 会让没有该列的后端整体不可用，代价远大于收益。
- **只把 `expired` 改为可选、不补 `status` / `statusSource`** — 下游仍会把缺失当现行有效；没有来源字段也无法审计「这条状态从哪来」。
- **对所有 `expired` 缺失的记录一律标「已废止」** — 方向相反，同样是编造事实。

## Consequences

knowledge.db 的单版本检索结果会显式显示「待核验」，比此前的静默留空更吵，但可被检索与审计。新增 `statusSource` 是输出字段，`law_search` 的 `inputSchema` 未变，不需要重录 llm-replay。legacy laws-full 的行为保持不变。
