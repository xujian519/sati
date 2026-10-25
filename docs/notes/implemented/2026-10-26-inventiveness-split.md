# inventiveness 子图按 Schema / 提示词 / 节点拆分（#725）

## Problem

`src/patent/graph/domains/inventiveness.ts` 有 717 行：8 个 JSON Schema、9 段内联提示词、检索反思回路、引用校验与规则门、声明式节点/边表、装配与结果提取混在一个文件。改提示词要在图拓扑里翻找，Schema 也无法被测试或文档单独引用。

## Decision

- `inventiveness-schemas.ts`：8 个 JSON Schema 常量（`PARSE_SCHEMA` … `COMBINATION_SCHEMA`），可独立引用。
- `inventiveness-prompts.ts`：9 个提示词构建函数，模板从 `llmNode` 内联数组逐字提取；入参是已读出的普通字符串/对象，不读 `GraphState`，保持纯函数、避免与图模块循环依赖。
- `inventiveness-nodes.ts`：LLM 节点装配、检索反思回路（轮次/收敛/补检/路由）、领域注入、引用校验、规则门收口。
- `inventiveness.ts`：只保留图拓扑与装配（`StageSpec`/`EdgeSpec` 表、开关解析、`buildInventivenessGraph`）、`extractInventivenessResult`、`INVENTIVENESS_INPUT_DECLARATIONS`，272 行。
- 新增 `tests/patent/graph/inventiveness-prompts.spec.ts`：固定输入下对 9 段提示词做 sha256 快照，另断言时间基准缺失与领域要点缺省分支。

与计划的两处差异（以验收线为准）：

1. 计划只列 schemas + prompts 两个新文件。仅拆这两块后 `inventiveness.ts` 约 450 行（节点装配与检索回路本身约 250 行），达不到「< 300 行／只保留拓扑装配」；因此把节点实现放进第三个文件 `inventiveness-nodes.ts`。
2. 提示词函数接收显式字符串而非 `GraphState`：若提示词模块读 state，就需要把 `priorArtForPrompt` / 收敛键常量跨模块共享，或让 prompts 反向 import 图模块形成循环。改由节点读 state、提示词只拼文本。

## Alternatives considered

1. **只拆 Schema 与提示词，接受 450 行**：不满足 #725 验收清单，导航问题只解决一半。
2. **把节点装配留在 `inventiveness.ts`、把检索回路另拆一文件**：仍需 ~350 行，且规则门/引用门等节点实现继续混在拓扑里。
3. **提示词函数直接读 `GraphState`**：模板最接近原样，但 `formatPriorArt` / `priorArtForPrompt` / 收敛键要么重复定义，要么形成 prompts ↔ 图模块循环依赖。
4. **用完整字符串快照代替 digest**：可读性更好但 9 段长文约 3.6 KB，评审噪音大；digest 已能精确发现任何字节变化。
5. **把 State 键常量集中到 schemas 文件**：名实不符（Schema 文件不该放检索回路状态键），故留在 nodes。

## Consequences

- 公开面不变：`buildInventivenessGraph`、`extractInventivenessResult`、`INVENTIVENESS_INPUT_DECLARATIONS` 仍从 `inventiveness.ts` 导出；barrel 未改。
- 提示词逐字保留；快照测试为基线，若有意改文案须同时更新 digest 并在 PR 说明原因。
- `inventiveness.ts` 272 行、nodes 286 行、prompts 179 行、schemas 97 行，均单一职责；`pnpm measure:update` 更新行数/文件数基线。
- 行为零变更：节点顺序、边顺序、开关语义、回路阈值均未改；既有 `tests/patent/graph/*`、`drafting-sop` 保持绿。
