# Agent Note: 工具描述瘦身——操作细节交给技能，描述只留触发与契约

Status: implemented

## Problem

固定启动开销里工具 schema 是最大一块（79 个工具 24.6k tokens），其中**顶层描述文本 9.6k**。最贵的是 `ego_browser`（924）与 `patent_figure_check`（324）：它们把 helper API 清单、V1–V11 规则目录、整段可运行范例写进描述——而这些内容与 `skills/ego-browser`、`skills/patent-illustrator` 想表达的操作说明是同一件事，被写了两遍。

描述与 inputSchema 的**计价地位与阅读时机都不同**，这决定了能改哪一边：

| | 顶层 `description` | `inputSchema`（含参数描述） |
|---|---|---|
| 模型何时读 | 决定"要不要调用"时 | 构造实参时 |
| 是否进入重放请求键 | **否**（`replayRequestKey` 只取 `name + inputSchema`） | 是 |
| 是否进入 transcript 的 `toolSchemaDigest` | **否**（`requestInvariant.ts` 同口径） | 是 |

因此改描述**不动任何请求键**，无需重录 llm-replay fixture；改 inputSchema 必须重录（#450 契约栏已注明）。

## Decision

按一条判据收口：**描述只保留触发条件、结果契约与边界；步骤、API 目录、范例属于技能**。落地五处（均为顶层描述改字）：

| 工具 | 描述 tokens | 移出的内容去了哪 |
|---|---|---|
| `ego_browser` | 924 → 130 | helper API 清单、`page` 门面、站点技能、可运行范例、任务空间会话纪律 → `skills/ego-browser/SKILL.md` |
| `patent_figure_check` | 324 → 229 | V1–V11 规则目录 → 依赖报告自身（每条发现都带规则 id + 法条原文）与 `patent-illustrator` 技能 |
| `patent_figure_project` | 258 → 205 | 剖切与标注的操作细节 → 本就在 `section_offset_mm` / `annotations` 的参数描述里 |
| `agent` | 344 → 213 | 与 inputSchema 重复的 `description` / `prompt` / `subagent_type` 说明、供开发者看的运行时内部行为 |
| `web_fetch` | 353 → 246 | 与 inputSchema 重复的 url/prompt/mode 说明、6 条自述式开场 |

合计 **−1,180 tokens**（79 个工具的描述总计 9,562 → 8,382；工具面总计 25,377 → 24,149，含 JSON 外壳；system prompt 侧本轮未动）。交接契约由 `tests/tool/builtin/tool-description-skill-handoff.spec.ts` 锁住：声明"细节见某技能"的工具，其技能文件必须存在且仍含被移走的关键 token（防的是"两处都没了"）。

## Alternatives considered

- **连 `inputSchema` 的参数描述一起瘦身** — 落选（本轮）：池子大得多（24,149 − 8,382 描述 − 1,025 JSON 外壳 ≈ **14.7k**），但参数描述是在**构造实参**时被读的，把它挪进技能意味着模型在决定往 `image_paths` 里放什么时看不到"不做 OCR、图号要靠文件名声明"这类约束——省的是窗口，损的是调用正确率。且动 inputSchema 要重录 `tests/fixtures/llm-replay/deepseek-v4-flash-basic`（可用 `PILOT_AGENT_MODEL` 覆盖录制模型，技术上可行），把一个纯文本改动升级为真实模型调用 + 提交重录产物。要做应单独一条决策，而不是夹在描述瘦身里。
- **一并瘦身 `bash` / `read_file` / `todo_write` 等核心高频工具描述**（合计 1.3k，最大的剩余板块） — 落选：这些描述承载的是行为契约（文件观测三态、`BASH_RESULT` 的 `retrieved_data_available`、待办只做检查表不做计划），没有可转移的技能落点，删字即删约束。收益与风险不成比例。
- **给描述加 token 预算门禁（断言总量 ≤ N）** — 落选：散文预算靠魔数守不住，正常新增一个工具就会误红；真正要守的是"细节没丢"（见上表与交接用例），而不是"字够少"。
- **把描述压到一句话（只说"做什么"）** — 落选：触发条件与结果契约（"fail 级发现即不得定稿"、"优先于 web_fetch"）是工具选择与收敛判据，删掉会让模型更容易漏用或错用。
- **顺手合并 `patent_workflow_run` / `patent_workflow` / `flexible_plan` 三个编排工具** — 落选（超出本条范围）：它们是三条真实路径（manifest / 清单 / 阶段级计划），合并是行为变更而非文本瘦身；#450 第 1、2 条的域裁剪与工具组开关已能让非专利项目整体卸掉它们。

## Consequences

- 换来 1,180 tokens 的固定开销削减，且**零契约变更**：请求键、`toolSchemaDigest`、事件矩阵、网关协议、UI 均不变，llm-replay fixture 无需重录。
- 代价一：`ego_browser` 的 helper API 与范例现在只在技能里，模型必须先 `read_skill("ego-browser")` 才能拿到——技能列表里该条目本就在（描述含"当你需要浏览器时默认先读这个技能"），但这是把"必然付费"换成了"按需付费"，若实测发现模型不读就直接写脚本，应把关键 helper 名放回描述而不是把技能内容再复制一份。
- 代价二：`patent_figure_check` 不再预告 V1–V11 的编号与含义，模型要靠报告里的规则消息理解失败原因。规则消息自带法条出处，理解成本低，但**调用前的**规则预判能力确实下降了（原来可以直接照着描述规避 V5/V7）。
- 剩余最大板块仍是 inputSchema 参数描述（约 14.7k）。本条的判据为它划了线：参数描述属于"调用期契约"不搬。若后续仍要削，应先有"参数描述可外移"的独立论证与 fixture 重录流程，而不是把它并进描述瘦身。
- 测量口径：`createLocalGateway({ __testModelFactory })` 跑一个真实回合，对捕获到的 `CanonicalModelRequest` 用 `src/context/budget/tokenizer.ts` 的 `countTokens` 分段计数（与 #450 正文同口径）。
