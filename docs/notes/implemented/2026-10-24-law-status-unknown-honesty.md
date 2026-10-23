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

状态来源按固定优先级合成，冲突时保留更强证据：离线 meta 的「已废止 / 待核验」→ `expired === 1` → 同名多版本的位置判定（现行有效 / 已被修订）→ 离线 meta 的「现行有效 / 已被修订」→ `expired === 0`（不标状态）→ 无来源时「待核验」。因此单版本记录可以采用 meta 的明确结论，但 meta 不能把 `expired === 1` 改写成「现行有效」；单版本 meta「已被修订」也不会生成指向自己的 `supersededBy`。

## Alternatives considered

- **保留 `expired: 0` 并在工具描述里提示不可信** — 提示词约束挡不住下游程序按字段值判断，伪事实仍会传播。
- **把 `expired` 改为必填并让 knowledge.db 抛错** — 会让没有该列的后端整体不可用，代价远大于收益。
- **只把 `expired` 改为可选、不补 `status` / `statusSource`** — 下游仍会把缺失当现行有效；没有来源字段也无法审计「这条状态从哪来」。
- **对所有 `expired` 缺失的记录一律标「已废止」** — 方向相反，同样是编造事实。

## Consequences

knowledge.db 的单版本检索结果会显式显示「待核验」，比此前的静默留空更吵，但可被检索与审计。新增 `statusSource` 是输出字段；`law_search` 的 `inputSchema` 未变，且当前 llm-replay fixture 没有执行该工具，因此不需要重录（若未来 fixture 实际调用 `law_search`，输出字段变化会进入下一轮请求消息，届时需重录）。

legacy laws-full 的 `expired` 0/1 仍原样透传；单版本记录遇到离线 meta 的明确结论时，`status` 会按上述优先级采用 meta（此前只采用「已废止 / 待核验」），这是让已有离线结论不被「待核验」掩盖的有意收窄。`expired === 1` 的失效结论始终优先于正向 meta。
