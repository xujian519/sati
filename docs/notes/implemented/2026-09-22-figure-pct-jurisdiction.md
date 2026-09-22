# Agent Note: `jurisdiction` 增 pct（唯一一次 inputSchema 变更 + fixture 重录）

Status: implemented

## Problem

三个制图工具（`patent_figure_generate`/`patent_figure_check`/`patent_figure_project`）的 `jurisdiction` 只接受 `cn`/`us`，没有 PCT 国际申请这一档；同时缺三类入参：本案附图总幅数（图号条件性的输入）、附图页序号/总数（页码声明的输入）、是否落版（整页视图的输出开关）。另一方面，改动 `inputSchema` 会让 llm-replay 的请求键失配（`toolSchemaDigest` = 工具 name+inputSchema 的哈希，见 `src/agent/loop/requestInvariant.ts`），所以**所有 schema 变更必须集中在一次**。

## Decision

**一次 schema 变更 + 一次重录**，三工具同步：

| 字段 | 变更 |
|---|---|
| `jurisdiction` | enum `["cn","us"]` → `["cn","us","pct"]`（**保留字段名**，语义是"目标受理局/指定局"） |
| `figure_count` | 新增 integer（缺省取本次调用渲染的幅数） |
| `sheet_index` / `sheet_total` | 新增 integer（成对声明；缺省不落页码） |
| `fit_to_page` | 新增 boolean（默认 `false`；`true` 时额外产落版页） |

实现细节：字段值域与归一化收在 `src/tool/builtin/patentFigureSchema.ts`（`JURISDICTIONS`/`toJurisdiction`/`toFigureCount`/`toSheet`），避免三处各写一遍收窄逻辑后漂移；`sheet_index`/`sheet_total` 必须成对且序号不越界（否则 `invalid_tool_input`），因为"只有一项"时无法判断页码体例。工具顶层 `description` 同批更新（不进 digest，但改了避免"只改半个 schema"的错觉）。

**fixture 重录**：`tests/fixtures/llm-replay/deepseek-v4-flash-basic` 按既有手册重录（删除 `records.jsonl` → `PILOT_AGENT_MODEL=deepseek/deepseek-v4-flash SATI_LLM_REPLAY_RECORD_ROOT=<fix> node --import tsx scripts/record-real-fixture.ts "<同一任务文本>"` → `pnpm record:replay <fix>` 结构校验 → 无 key 重放测试转绿）。重录前后对比：`events` 519 → 1166，工具名集合不变（仍 47 个）。

**sidecar 不升版本**：新增可选字段 `office`/`caption`/`sheet`/`layout`；`parseFigureSidecar` 只校验最小结构、对额外字段宽容，升版会让既有案卷的 sidecar 直接抛错（解析器对版本不等即抛），弊大于利。

**pct 下的规则处置**（不猜法条）：V10/V11（CN 细则第 22 条的括号按面判定）在 pct 下**整族跳过**，并在报告里如实声明"pct 未适用 CN 括号规则"（PCT Rule 6.2(b) 只规定权利要求"可以"带括号标记，正文惯例未核验）；V8/V9（摘要附图、实用新型）同样跳过；V12 的比例标注、V14 的括号连用改为对非 cn 生效（依据是 IP 5.150 与 Rule 11.13(e)/1.84(p)(1)）。

## Alternatives considered

- **把 `jurisdiction` 改名为 `target_office`** — 落选。改名要同步 SKILL/文档/sidecar/三个工具/多处测试，收益只是措辞更贴切；而 `jurisdiction` 的语义（"按哪个法域判"）已经够准确。
- **新增独立字段 `target_office` 与 `jurisdiction` 并存** — 落选。两个字段表达同一件事，必然出现"一个说 cn 一个说 uspto"的矛盾输入，还得定义优先级。
- **分多次 PR 改 schema（每次重录）** — 落选。每次改 `inputSchema` 都要重录一次真实模型会话（约 12s 录制 + 校验），且重录 PR 必须排在 main 绿时；集中一次把变更面与重录次数都压到最小。
- **新增工具承载落版页** — 落选。新增工具会改变工具列表 ⇒ 同样触发重录，且会把"落版"从"生成的一个选项"变成需要模型另行调度的一步；`fit_to_page` 是同一动作的附加产物。
- **`format` 加 `"page"` 值** — 落选。`format` 管的是"图形产物形态"（svg/html/both），落版是附加页而不是另一种形态；塞进 `format` 会让值域交叉（`format: "svg"` 与 `fit_to_page` 的关系难以描述）。
- **sidecar 升到 v2** — 落选。见上：会让历史案卷的 sidecar 全部解析失败，而新增字段全是可选的。
- **pct 下沿用 CN 的 V10/V11** — 落选（纪律问题）。那两条依据的是 CN 细则第 22 条与中文正文惯例，PCT 体例下未核验；"照着 CN 判"会把 CN 条文伪装成 PCT 条文，宁可在报告里明说"未适用"。
- **给 pct 也写英文附图说明** — 未做（保留中文）。PCT 申请的语言由申请人选择（CNIPA 作受理局时常见以中文提出），本模块按"中文文字面 + `Fig. N` 图号"组合：图号前缀是 IP 5.141 明文规定"whatever the language"的，与文字语言无关。

## Consequences

- **本轮之后任何 PR 若再改这三个工具的 `inputSchema`（含字段描述文本）都会再次让 fixture 失配**——评审时把"本 PR 是否改了 inputSchema"作为固定检查项。
- 重录是**本地行为**（CI 无 key），录制产物随 PR 提交；fixture 只含 `manifest.json` + `records.jsonl`，不含 API key。
- pct 的图号写法是 `Fig. N`（不是 `FIG. N`），页码体例是 `1/3`，字高下限 3.2mm，页边距下边距 10mm——这些差异都在档案里、有条文出处。
- 新增 183 项 figuregen 测试中的 5 项工具层用例（`tools-offices.spec.ts`）覆盖"法域 × 图幅 × 页码 × 落版"的接线。
