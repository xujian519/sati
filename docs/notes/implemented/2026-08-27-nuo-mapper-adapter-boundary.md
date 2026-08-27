# Agent Note: nuo 数据适配层边界确认与坏 JSON 告警

Status: implemented

## Problem

技术债一句：「`src/patent/data/nuo/*` 的 mapper 解析 PatentData JSON，需确认领域逻辑是否散落在数据适配层。」即 `src/patent/data/nuo/` 作为 nuo-patent 数据引擎的适配层，是否把专利领域业务规则混进了纯数据映射里。同一债还有相邻一条（账本 TD-PATENT-N06）：`parseJsonArray` 解析失败静默返回 `[]` 且无告警，vendor 字段漂移被无声掩盖。

## Decision

- **边界确认：适配层没有散落领域业务逻辑。** 逐文件审阅后结论：
  - `mapper.ts`（`mapPatentData`）只做 JSON 字符串字段解析、snake_case→camelCase 改名、`[{inventor_name:...}]` 取字符串、合并 family/non-family 引证；**不做**日期/法律状态解释、有效/到期推算、引证或发明人排序去重、按领域过滤、领域规则裁决（这些都在 `src/patent/checker|evidence|graph|evaluate|clarity/` 层）。
  - `searchProvider.ts` 只做通用检索归一化（按 url/title 去重、`normalizeTitle` 与文献源共享、`publication_date` 空串转 undefined 保形）。
  - `egoSession.ts` 的 `normalizePatentNumber` 是编号格式归一化（trim/大写/去 `\s\-:/`），属数据边界职责。
  - `patentCache.ts` 唯一「域感知」是法律状态类检索式命中→TTL 5min，属缓存策略启发式且有注释，非业务裁决。
  - 仅 `mapPatentData` 的 family/non-family 引证合并一处为「跨字段语义合并」，但它是有文档的记录格式定义，不构成领域规则泄漏，故**不上移分层**（避免为纯适配器引入多余领域层）。
- **修复 TD-PATENT-N06**：`parseJsonArray` 新增 `field`（告警定位）与可注入 `onError` 诊断回调，缺省走结构化 `createLogger("nuo-mapper").warn`（含字段名+压缩空白截断到 80 字符的样本），坏 JSON 不再静默吞掉。
- **回归测试锁定契约**：`tests/patent/data/nuo/mapper.spec.ts` 新增「纯结构契约」（字符串原样透传、发明人保留顺序不去重、引证按 non-family→family 合并且不按日期排序）与「N06 告警」（坏 JSON 触发 onError 携带字段名+样本；合法/空输入不触发；超长样本压缩+截断）。

## Alternatives considered

- **把 family/non-family 引证合并、名称提取等半语义决策上移到新领域层** — 需为纯适配器引入领域模型层，改动大、无实际业务规则可承载，超出本债务范围；确认结论表明无领域逻辑泄漏，故弃（只留回归测试锁边界）。
- **注入 logger 让 `parseJsonArray` 直接打日志** — 使纯函数耦合具体日志器、难测；改为可注入 `onError` 回调（缺省结构化 warn），既满足告警又保持可测。
- **用裸 `console.warn`** — 那正是另一条债 TD-PATENT-N05（审计/审批关键路径裸 console），弃；统一走 `createLogger`。

## Consequences

换来：适配层边界有了明确审计结论与回归测试，未来领域逻辑回流会被「纯结构契约」测试拦截；vendor 字段漂移从静默变可见（结构化 warn，含字段名+样本）。付出：`mapPatentData` 各解析点需带字段标签（可读性略增）；坏数据在测试输出中会多一条 stderr warn（不影响断言）。映射输出结构完全不变，消费端 `patent_metadata` 行为不变；不改任何工具 inputSchema/outputSchema，LLM replay fixture 不失效；不改 AgentEvent/gateway frames，事件矩阵不需重生成。
