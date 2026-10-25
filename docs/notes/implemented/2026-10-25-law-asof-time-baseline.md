# Agent Note: law_search asOf 时点过滤 + time_baseline 截止日显式产物

Status: implemented

## Problem

`law_search` 只能回答「现在有哪些法条」，不能回答「截至申请日/优先权日，这条法条是否有效」。`expired` 是当前状态而不是行为时点状态；knowledge.db 没有 `valid_from`，只有可空的 `publish_date`。时间基准此前只存在于证据层的日期工具与主代理的自由文本里，`patent_inventiveness_v1` 的 manifest 与图都没有可直接读取的截止日事实，下游无法确定性消费。

## Decision

**检索侧（`src/knowledge/legal`）**

- `law_search` 新增 `asOf?: string`（严格 `YYYY-MM-DD`，含日历合法性）；非法值返回 `metadata.error = "invalid_as_of"` 且不执行检索。
- `LegalSearchSource` 新增 `timeFilter` 与 `searchAt(keyword, options & { asOf })`；`search` / `findByName` 的 options 都接受 `asOf`，缺省行为不变。
- knowledge.db 后端（`KnowledgeLawSearch`）：无 `valid_from`，用 `publish_date IS NOT NULL AND publish_date <= asOf` 作**下界近似**，输出 `timeFilter: "approximate"`；`publish_date` 空的行不返回，计入 `unknownDateCount`。
- laws-full 后端（`LegalSearchEngine`）：用 `valid_from <= asOf AND expired = 0` 精确过滤，输出 `timeFilter: "exact"`；`valid_from` 空的行不返回，计入 `unknownDateCount`。`expired = 1` 一律排除——失效日期不可知，宁可漏报也不把已废止法当行为时法。
- 工具输出新增 `asOf` / `timeFilter` / `unknownDateCount`；`unknownDateCount` 的口径是**本次查询命中的候选**（判定用 LIKE 匹配，FTS 分词可能略有差异），不是全库计数。摘要文案与工具描述同步说明 exact/approximate。
- SQL 条件只在 `asOf` 提供时追加；无 `asOf` 继续走原热路径（行为不变）。

**时间基准（patent 域）**

- 新增确定性原子 `time-baseline`（`src/patent/atoms/handlers/builtin/timeBaseline.ts`）：
  - 输入 `priority_date` / `filing_date`（显式 state 键优先），其次解析 `inventiveness_parse` / `parse` 的 JSON；逐个候选尝试解析，单个坏值不阻断后续候选。
  - 优先级 `priority_date` > `filing_date`；日期归一复用 `evidence/date.ts` 的解析与月级→月末规则（新增 `normalizeToCutoffDate`）。
  - 输出 `time_baseline`（JSON：`{ cutoffDate, basis, degraded, note? }`）+ `cutoff_date` / `cutoff_basis` / `cutoff_degraded`。缺两者时 `cutoffDate: ""`、`basis: "unknown"`、`degraded: true`、note 明示「不得假定今天」。
- `patent_inventiveness_v1` 在 `parse` 与 `search` 之间新增 `time_baseline` 阶段（`atom: "time-baseline"`）；`parse` 描述改为「解析时间字段」。
- 创造性图拓扑改为 `parse → time_baseline → domain_inject → build_query`（不绕过 `domain_inject`）；`PARSE_SCHEMA` 增 `priority_date`；`build_query` 直接消费 `cutoff_date` 生成 `after:YYYYMMDD`，缺失时明确写「时间基准未确定」而不是假定今天。
- `INVENTIVENESS_INPUT_DECLARATIONS` 增 `time_baseline` 与 `build_query` 的 `cutoff_date` 依赖。

**重放**

- `law_search.inputSchema` 变化使旧 fixture 失配，已按测试钉住的 `deepseek/deepseek-flash` 重录（`PILOT_AGENT_MODEL=deepseek/deepseek-flash`，任务文本与 spec 一致），`pnpm record:replay` 校验通过，`llm-replay-real.spec` 无 key 重放绿。

## Alternatives considered

- **knowledge.db 也标 `exact`** — 只有公布日期，不能证明该日仍有效；标 exact 会把近似伪装成精确。
- **laws-full 把 `expired=1` 的行按 `publish <= asOf` 保留** — 失效日期不可知，会把 1992 年已废止版本当成 1990 年的行为时法；保守排除并在 `unknownDateCount` 之外单独由 `expired` 语义承担。
- **`valid_from` 为空时回退 `publish`** — 公布日通常早于施行日，会引入「尚未施行」的假阳性；改为排除并计入 unknown。
- **`unknownDateCount` 做全库精确计数** — FTS 与 LIKE 的候选口径不同，全库精确计数需要复制两套匹配 SQL；当前口径如实回答「本次漏了多少条候选」，成本与收益更匹配。
- **在新的 manifest 阶段里用 LLM 解析日期** — 时间基准是确定性事实，LLM 只负责解析字段；归一/优先级/月未规则放在原子内，可单测、可复现。
- **time_baseline 缺失时用今天** — 违反行为时点语义；显式 `degraded` + note。

## Consequences

- 本地 knowledge.db 的 96 条法规文档中 83 条 `publish_date` 为空（`asOf` 检索会大量落到 `unknownDateCount`）；这是数据源限制，输出如实标注，不静默当作已过滤。
- `patent_inventiveness_v1` 从 8 阶段变为 9 阶段；`patent_workflow` 收口路径需为 `time_baseline` 提供输出（缺省会进 `degradedSteps`），`patent_workflow_run` 图路径自动执行原子。
- `LegalSearchSource` 是新增必填成员（`timeFilter` / `searchAt`）：两个内置引擎与测试 fake 已同步；第三方实现需补这两个成员。
- `law_search` 的 `inputSchema` 变更已重录 llm-replay；后续再改描述仍需重录。
