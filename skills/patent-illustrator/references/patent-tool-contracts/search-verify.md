# 检索/核验族工具契约（search-verify）

本分片是 `patent` 域「检索/核验族」工具的**口径与失败模式权威副本**。工具的顶层
`description` 只保留「做什么 + 硬约束 + 只读提示」三件事（预算 ≤ 200 字符），其余细节
（输出字段清单、输入枚举全表、兄弟工具导航、示例、边界、法条依据）全部下沉到这里。

覆盖工具（10 个，均为只读）：

| 工具 | 一句话用途 |
|---|---|
| `patent_search` | 关键词/布尔检索 Google Patents |
| `patent_metadata` | 按专利号点查元数据 |
| `patent_legal_status` | 批量查法律状态与预计到期日 |
| `patent_kg_query` | 查专利知识图谱节点与关系 |
| `patent_case_search` | 检索本地判例全文 |
| `patent_wiki_search` | 检索专利 wiki 撰写标准卡片 |
| `patent_fees` | 计算 CNIPA 官费 |
| `patent_deadlines` | 计算法定期限与指定期限 |
| `evaluate_evidence` | 证据三性确定性判定 |
| `claim_chart_build` | 构建权利要求要素对照表 |

> 变更纪律：顶层描述与本分片必须同步改。顶层删掉的任何**实质信息**（口径、边界、
> 失败模式、条件编号含义、法条依据）都要在本文件里找得到对应文字。

---

## patent_search

**用途**：按关键词或布尔检索式检索 Google Patents，返回结构化命中列表。

**关键入参**：`query`（Google Patents 原生检索语法）、`limit`（最大命中数，1–50，默认 10）。

**硬约束与失败模式**：
- **零结果 ≠ 报错**：没有命中时返回 `hits: []` + `warnings`，是 `success` 的数据，不是异常；
  模型据此判断「没查到」，不得当作调用失败重试。
- **解析失败抛错**：源页面结构变化导致解析失败（`PARSE_ERROR`）时抛 `tool_execution_failed`；
  检索超时抛 `tool_timeout`；空查询抛 `invalid_tool_input`。这三种与「零结果」语义不同，
  不可混为一谈。
- **同族去重**：按基号（去 kind code，如 `CN115690481A` → `CN115690481`）分桶，同基号只保留
  `publicationDate` 最新的一篇（无日期视为最旧），被合并的篇数写入 `warnings`。
  **跨号分案不识别**（已知边界）。
- **只读**：不写任何外部状态。

**口径与依据**：
- **检索语法**（`query` 字段）：关键词、布尔（`AND` / `OR` / `NOT`）、字段限定
  （`assignee:` / `inventor:`）、日期范围（`after:` / `before:`）。示例：
  `'(phase change OR PCM) AND thermal'`、`'assignee:(Samsung) after:20200101'`。
- **输出字段**（逐项见 `outputSchema`）：`query`、`total`、`hits[]`（`patent` / `title` /
  `assignee` / `publicationDate` / `priorityDate` / `abstract` / `url`）、`warnings`、
  `dataSource`、`cache`（`hit` / `ageMs`）。
- **`dataSource` 取值**：`ego-json`（ego-browser 取回 XHR JSON，主路径）→ `native-json`
  （ego 不可用时原生 fetch 直取 XHR JSON）→ `vendor`（JSON 主路径失败后 nuo-patent 回退，
  XHR + HTML 搜索页）→ `unknown`（调用方注入的检索实现未声明来源）。
- **缓存 TTL 分层**：零命中 1 分钟 / 法律状态类关键词（`法律状态`、`无效`、`revoked` 等）
  5 分钟 / 其余 2 小时。

**边界**：不做专利法律状态判断、不做三性评价、不返回全文（只给 `abstract` + `url`）；
不下载 PDF。要全文与法律状态分别走 `patent_metadata` / `patent_legal_status`。

---

## patent_metadata

**用途**：按专利号点查 Google Patents 元数据（单件，不检索）。

**关键入参**：`patent`（专利号，如 `US11452699B2`，自动校验并规范化）、`timeout`（毫秒，
默认 30000）、`returnAbstract`（默认 true）、`returnLegal`（默认 true）。

**硬约束与失败模式**：
- **号先校验后规范化**：专利号非法（`validatePatentNumber` 不通过）抛 `invalid_tool_input`；
  通过后统一大写去空格再抓取。
- **「不存在」是数据不是异常**：源返回 `NOT_FOUND` 时以 `success: false` + `errorCode:
  "NOT_FOUND"` 返回，不抛错。超时抛 `tool_timeout`，其余源错误抛 `tool_execution_failed`。
- **必需字段全空 ⇒ 抛错，不伪装成功**：标题/发明人/受让人/申请日全部解析不到时抛
  `PARSE_ERROR`（`tool_execution_failed`）。**不许**用一串 `N/A` 冒充成功返回。
- **部分缺失只标 degraded**：个别字段缺失时 `degraded: true`，缺失清单落在
  `data.missingFields`，原因落在 `degradedReason`，非致命解析提示落在 `parseWarnings`。
- **只读**：不写任何外部状态。

**口径与依据**：
- **输出字段**（逐项见 `outputSchema`）：`success`、`patent`、`url`、`data`（`title` /
  `inventors` / `assigneesOriginal` / `assigneesCurrent` / `filingDate` / `grantDate` /
  `legalStatus` / `pdfUrl` / `classifications` / `abstractText` / `missingFields`）、
  `errorCode`、`errorMessage`、`parseWarnings[]`、`degraded`、`degradedReason`、
  `dataSource`（当前仅 `html-microdata`，即 HTML microdata 解析路径）。

**边界**：只做单号点查，不做检索（检索走 `patent_search`）；不下载 PDF（只给 `pdfUrl`）；
不判断权利要求有效性。

---

## patent_legal_status

**用途**：批量查询专利法律状态与预计到期日（数据源 Google Patents）。

**关键入参**：`patents`（专利号数组，1–20 件）、`maxConcurrency`（并发请求数，默认 4）。

**硬约束与失败模式**：
- **批量不因单件失败中断**：某一件查询失败/缺失只在该条上体现（`error` 字段 +
  `status: "UNKNOWN"` + `degraded: true`），其余件照常返回。
- **核心字段缺失才判 degraded**：`degraded` 仅当核心字段（`title`、`status`、`filingDate`、
  `grantDate`）缺失时为真；非核心字段缺失只进 `missingFields`。
- **查询结果缺失有明确标记**：`error: "查询结果缺失"`，不是「查不到就没有这条」。
- **只读**：不写任何外部状态。

**口径与依据**：
- **状态取值**：`Active` / `Expired` / `Abandoned`（等，取决于源页面文案）；无法认定时为
  `UNKNOWN`。
- **输出字段**（逐项见 `outputSchema`）：`results[]`（`patentNumber`、`title`、`status`、
  `ifiStatus`、`estimatedExpiration`、`filingDate`、`grantDate`、`applicant`、`inventor`、
  `events`（事件历史）、`url`、`error`、`degraded`、`degradedReason`、`missingFields`、
  `dataSource`）。
- **预计到期日是估算**（`estimatedExpiration`），不是权利期限的终局认定。

**边界**：不判断权利要求有效性、不判断年费是否已缴、不预测法律状态变动。

---

## patent_kg_query

**用途**：查询专利知识图谱（`knowledge.db` 的 `kg_nodes` / `kg_edges`）的节点与关系。

**关键入参**：三选一 —— `query`（关键词检索）、`id`（节点展开）、`node_type`（类型浏览）；
另有 `expand`（关系扩展，默认 true）、`include_content`（附正文片段，默认 false）、
`limit`（默认 5，最大 10）、`node_types`（类型过滤）、`min_score`、`rerank`（LLM 二阶段精排）。

**硬约束与失败模式**：
- **库缺失即报错**：找不到图谱库时 `checkAvailability` 返回 `setup_required`，执行时返回
  错误文本 + `metadata.error = "patent_kg_db_not_found"`。库路径默认
  `~/.sati/knowledge/knowledge.db` 的 `kg_nodes`，可用 `SATI_KNOWLEDGE_DIR` 或
  `SATI_PATENT_KG_DB` 指定。
- **模式优先级**：`id` > `query` > `node_type`；三者都不给 → `metadata.error = "invalid_input"`。
- **精排降级不静默**：`rerank: true` 但缺模型/精排失败时，保持原序并返回
  `rerank.applied = false` + `rerank.degraded = true` + `reason`，不假装已精排。
- **只读**：不写图谱库。

**口径与依据**：
- **三种模式**：
  1. `query` 关键词检索（FTS5，短词自动降级 LIKE），默认带相似/引用关系扩展，
     命中方式 `via` 标注为 `keyword` / `similar` / `cites`；
  2. `id` 节点展开：返回节点详情 + 相似/引用邻居（沿引用关系追查判例），引用类关系为
     `CITES` / `CITES_LAW` / `FREQUENTLY_CITES` / `REFERENCES`；
  3. `node_type` 类型浏览。
- **节点类型全表**：`Case` / `SupremeCourtJudgment` / `RegionalCourtJudgment` /
  `GuidelineRule` / `Clause` / `WikiCard` / `Concept`（实际库内类型为准，未命中别名时按库内
  实际类型透传）。
- **别名展开**（`Judgment` / `LawArticle` / `Concept` 为可写别名，大小写不敏感匹配）：
  `Judgment` → `SupremeCourtJudgment` + `RegionalCourtJudgment`（最高法院 + 地方法院判决）；
  `LawArticle` → `Clause` + `Chapter`（法条条款）；`Concept` → `Concept` / `ConceptDetail` /
  `一级概念` / `二级概念` / `三级概念`。
- **规模**：图谱节点与关系边随 `knowledge.db` 版本变化（工具描述原文曾记「116K 节点 +
  关系边」）；当前事实源见 `docs/code-facts.md`。
- **正文片段截断**：约 600 字。
- **输出字段**（逐项见 `outputSchema`）：`total`、`hits[]`（`id`、`nodeType`、`name`、`title`、
  `score`、`tier`、`via`、`relation`、`content`、`neighbors[]`）、`dbPath`、`rerank`。

**定位（与兄弟工具）**：图谱节点与引用关系 → 本工具；wiki 卡片正文 → `patent_wiki_search`；
法条原文 → `law_search`；判例全文 → `patent_case_search`。

**边界**：只读既有图谱，不建图、不改边；不做三性判断、不给法律结论。

---

## patent_case_search

**用途**：检索本地专利判例全文（无效复审决定、专利判决），供无效宣告分析与 OA 答复取证。

**关键入参**：`query`（检索关键词，如「创造性 三步法」「技术启示」「区别特征 预料不到的效果」）、
`doc_type`（`case` = 无效复审决定 / `judgment` = 专利判决，缺省全部）、`court`（审理法院，
子串匹配，如「最高人民法院」）、`limit`（默认 5，最大 10）、`include_content`（附命中片段，
默认 true）。

**硬约束与失败模式**：
- **默认排除 wiki 审查标准卡片**：固定 `excludeSource = "wiki"`，只返回 raw 判例全文。
  审查标准卡片要另走 `patent_wiki_search`。
- **FTS5 优先、LIKE 降级**：FTS5 trigram BM25 不可用时退化为 LIKE 降级检索，
  `results[].via` 标注实际路径（`fts` / `like` / `semantic`）。
- **语义路失败不阻断**：语义召回（knowledge.db embeddings）异常时回退纯 FTS，只记日志，
  不让整个调用失败。
- **库缺失即报错**：默认 `~/.sati/knowledge/knowledge.db`，可用 `SATI_CASE_DB` 指定；
  缺失时 `setup_required` + `metadata.error = "case_db_not_found"`。
- **只读**：不写判例库。

**口径与依据**：
- **语料规模**：无效复审决定 ~7.4 万篇 + 专利判决 ~6.9 千篇（随库版本变化）。
- **双路融合**：FTS 命中与语义命中按 `documentId` 做 RRF 融合；去重时 FTS 命中优先保留
  （`via` / `ftsRank` 不丢），语义只填充 FTS 未覆盖的文档。
- **语义命中同样受 `doc_type` 过滤**（否则 `doc_type=case` 会混入 personal_note）。
- **输出字段**（逐项见 `outputSchema`）：`total`、`results[]`（`documentId`、`docType`、
  `title`、`decisionNumber`、`caseNumber`、`court`、`source`、`charCount`、`snippet`、
  `ftsRank`、`via`）、`dbPath`。
- **片段截断**：约 800 字。

**边界**：只检索已入库判例全文，不做案情判断、不生成论证结论；不联网取判例。

---

## patent_wiki_search

**用途**：检索专利 wiki 知识卡片（撰写标准参考），用于撰写说明书、权利要求书时核对标准。

**关键入参**：`query`（卡片标题/概念/领域子串匹配；空串 = 按目录列出全部卡片）、`dir`
（目录过滤：`specification` 说明书 / `claims` 权要 / `drafting` 撰写 / `figures` 附图，
缺省全部）、`limit`（默认 5，最大 10）、`include_body`（附卡片正文片段，默认 false）。

**硬约束与失败模式**：
- **撰写说明书前先检索「撰写必查卡片清单」中的卡片**（工作流要求，不是可选项）。
- **同标题重复卡片只留最高分**：先超取（`limit × 3`，上限 30）再按标题去重，避免重复项挤占
  `limit`。
- **库缺失即报错**：默认内置 `src/knowledge/patent/wiki`，可用 `SATI_WIKI_DIR` 覆盖；
  缺失时 `setup_required` + `metadata.error = "wiki_dir_not_found"`。
- **只读**：不写卡片库。

**口径与依据**：
- **四目录**：`specification`（说明书）/ `claims`（权利要求）/ `drafting`（撰写）/ `figures`（附图）。
- **卡片覆盖的撰写标准**：充分公开、实施例、数值范围、以说明书为依据等。
- **输出字段**（逐项见 `outputSchema`）：`total`、`results[]`（`id`、`title`、`relativePath`、
  `concept`、`domain`、`body`、`score`）、`wikiDir`。
- **正文片段截断**：约 600 字。

**边界**：只读本地卡片库，不联网；卡片是撰写标准的整理件，不替代审查指南原文——引条文
仍须走 `law_search` 核验。

---

## patent_fees

**用途**：计算 CNIPA 官方费用（申请费、实审费、年费、附加费、滞纳金等）。

**关键入参**：`patentType`（`invention` / `utility-model` / `design`）、`triggers`（收费环节，
必填）、`claims`（权利要求总数）、`specificationPages`（说明书页数）、`priorityClaims`
（优先权要求项数）、`annuityYears`（年费年度数组，如 `[1,4,13]`）、`extensionMonths`
（延长月数）、`lateMonths`（年费滞纳月数，0 = 按期）、`reduction`（减缴：
`kind` `individual`/`enterprise`/`institution`、`applicants` 申请人数量、`filed` 是否已备案、
`grantPatentYear` 授权当年所处的专利年度）。

**硬约束与失败模式**：
- **`triggers` 为空是错误，不是「本案无费用」**：返回 `no_triggers`；未知环节返回
  `unknown_trigger` 并列出全部可用取值。**不许**把空触发当成零费用结论。
- **金额只来自费率索引**：`assets/patent/fees/cn-fees.yaml`（国家知识产权局《专利收费、
  集成电路布图设计收费标准》，2024-08-06 发布）。每条金额带 `sourceDoc` / `sourceUrl` /
  `publishedOn` / `verifiedOn`；**没有 `verifiedOn` 的金额是「未核验」**，按未核验处理，
  不是默认已核验。
- **未核验项阻断合计**：条目状态为 `unverified`（金额未转录 / 超出补缴窗口）或 `unrecorded`，
  以及连份数都算不出来的适用条目，一律进 `pending`（指名 `requiredInput`）**并进入
  `unverifiedIds`**；`total.complete` 只在 `unverifiedIds` 为空时为真。策略
  `failOnUnverified: true` ⇒ 未核验时不报一个看起来完整的合计。
- **减缴必须已备案**：`reduction.filed` 为假时，仅对不以此为前提的费种适用，其余按全额计；
  官方口径为「个人或单位减缴 85%」「两个或以上共同申请人/共有专利权人减缴 70%」
  （`applicants = 1` → 85%，`≥ 2` → 70%）。
- **只读**：只算钱，不代缴、不下缴费单。

**口径与依据**：
- **计数基准**（`basis`）：`per-case` 每件；`per-claim-beyond` 超过免费基数的项数；
  `per-page-beyond` 超过免费基数的页数；`per-priority` 每项优先权要求；`per-annuity-year`
  每个专利年度；`per-month` 每请求月数。
- **典型条目**：权利要求附加费自第 11 项起每项 150 元（免费基数 10）；优先权要求费每项
  80 元；说明书附加费免费基数 30 页，但官方分两档（第 31 页起 50 元/页、第 301 页起
  100 元/页），条目模型只有单一单价，故该条**不给金额**（`unpriceableReason`），须人工按
  官方分档表核价。
- **年费与滞纳**：年费按专利年度分档（`tiers`）；滞纳金按细则第 115 条的滞纳窗口，
  每月加收当年全额年费的规定比例（`latePayment.monthlyPercent`）。
- **上下游依赖**：`annuityYears` 来自 `patent_deadlines` 的公告后年费年度；
  `grantPatentYear` 来自 `patent_deadlines` 的授权年度（用于判定年费减缴覆盖的「授予专利权
  当年起十年内」区间；不给时退化为「第 10 年度及以前」的保守近似，只少给不多给）。
- **输出字段**（逐项见 `outputSchema`）：`patentType`、`currency`、`triggers`、`lines[]`
  （`id`、`name`、`basis`、`quantity`、`quantityBasis`、`unitAmount`、`subtotal`、`payable`、
  `status`、`reduction`、`legalBasis`、`sourceDoc`、`sourceUrl`、`publishedOn`、`verifiedOn`、
  `notes`）、`pending[]`（`id`、`name`、`requiredInput`、`reason`）、`total`（`amount`、
  `complete`、`unverifiedIds`）、`reduction`、`notes`、`report`。

**边界**：只算官费，不含代理费/翻译费/官费以外支出；不代缴；不预测官方调价——费率以索引
为准，调价后须更新并重新核验索引。

---

## patent_deadlines

**用途**：计算中国专利的法定期限与指定期限（申请费、实审请求、办登与分案、公告后年费、
优先权、PCT 进入国家阶段、答复一通/后续通知、复审请求），输出届满日、细则第 5 条休假日
顺延后的届满日、剩余天数与状态，并附法条依据。

**关键入参**：`kind`（`invention` / `utility-model` / `design`）、`filingDate`、
`claimsPriority`（必须显式给 true/false）、`priorityDate`（`claimsPriority` 为真时必填）、
`isPctNationalPhase`（30/32 个月期限）、`authorizationPublicationDate`（授权公告日，年费年度）、
`notices`（启动期限的通知，含 `kind` 与送达信息）、`restDayRule`（`apply` 默认 / `omit`）、
`today`（参考日，默认今天）。

**硬约束与失败模式**：
- **以通知送达起算的期限须有送达记录**：答复一通/后续通知/驳回决定/复审通知等期限必须靠
  `notices` 里的送达信息起算。缺送达记录时返回 `pending` 并**指名缺哪个输入**；**不许**用
  申请日起的固定年数代替。
- **电子送达不加 15 日**：送达日认定（专利法实施细则第 4 条）——
  - 电子（第 7 款）：以文件进入当事人认可的电子系统的日期为送达日；未举证进入日时按发文日
    认定（**不加 15 日**）；
  - 邮寄（第 4 款）：自发出之日起满 15 日推定收到（**只有邮寄才有满 15 日推定**）；
    有实际收到日证据的以实际收到日为准；
  - 直接送交（第 5 款）：以交付日为送达日；
  - 公示：以公示日为送达日。
  推定送达日本身遇休假日**不顺延**（细则第 5 条末句只顺延「期限届满日」），故邮寄的
  `+15 日` 直接加，不调用工作日历。电子送达进入日与发文日不一致时按进入日认定并显式提示
  复核（细则只规定以进入日为送达日，未规定不一致时的推定）。
- **工作日历未覆盖的年份 ⇒ 办事期限降级为 pending**：输出 `pending[].requiresFullCalendar`
  与 `calendarCaveat`；**参考性期限**只给按周末顺延的下界（`dueDateLowerBound`），不冒充
  确定届满日。
- **缺哪类通知，哪类期限就 pending**：`pending[]` 指名 `requiredInput`。
- **只读**：不算钱、不代缴。

**口径与依据**：
- **`notices[].kind` 六类**：`acceptance-notice` 受理通知书 / `office-action-first` 第一次
  审查意见通知书（一通）/ `office-action-subsequent` 后续审查意见通知书 / `rejection-decision`
  驳回决定 / `grant-notice` 授权通知书 / `reexamination-notice` 复审通知书。
  `mode` 送达方式：`electronic`（默认）/ `postal` / `personal` / `publication`；送达信息字段
  `dispatchDate`（发文日）、`enteredDate`（进入电子系统日）、`actualReceiptDate`（实际收到日）、
  `handedOverDate`（交付日）、`publicationDate`（公示日）、`designatedMonths`（指定期限月数）。
- **期限种类与法条依据**（节选）：申请费（细则第 36 条）；实审请求（细则第 37 条）；
  优先权（专利法第 29 条第 1 款；外观设计为第 29 条第 2 款）；办登与分案（细则第 112 条、
  专利法第 35 条）；公告后年费（细则第 115 条、第 114 条）；缴费滞纳（细则第 120 条）；
  答复（细则第 48 条、第 60 条第 1 款）；复审（专利法第 41 条第 1 款）；指定期限
  （专利审查指南第五部分第七章）；PCT 进入国家阶段（细则第 67 条）。
- **顺延规则**：`restDayRule = "apply"`（默认）按细则第 5 条顺延至休假日结束日；
  `"omit"` 不顺延。
- **恢复权利**：输出字段 `restorationExcluded` 给出「该期限不适用细则第 6 条恢复」的法条依据
  （空 = 可请求恢复）。
- **输出字段**（逐项见 `outputSchema`）：`kind`、`filingDate`、`today`、`claimsPriority`、
  `priorityDate`、`restDayRule`、`calendarCoveredYears`、`computed[]`（`id`、`label`、
  `legalBasis`、`rawDueDate`、`dueDate`、`dueDateLowerBound`、`rollForward`、`daysRemaining`、
  `daysRemainingBasis`、`status`、`rolledForward`、`requiresFullCalendar`、`calendarCaveat`、
  `triggerBasis`、`triggerCaveat`、`patentYear`、`restorationExcluded`、`latePaymentWindow`）、
  `pending[]`（`id`、`label`、`legalBasis`、`requiredInput`、`reason`、`requiresFullCalendar`）、
  `report`。

**边界**：只算期限，不预测审查意见内容、不判断答复可行性；不代缴、不代办；
起草答复、缴费、办登前先用本工具核对期限。

---

## evaluate_evidence

**用途**：对单条专利证据做**确定性**三性判定（相关性 / 合法性 / 真实性）与类型特定检查，
输出综合评分、举证责任分配与实际适用的证据规则。

**关键入参**：`snippet`（待判定证据描述，原文摘录）、`sourceUri`（`web:` / `patent:` /
`file:`）、`docVersion`（证据日期）、`contentHash`（内容哈希）、`direction`
（`supporting` / `contradicting` / `neutral`）、`claimRefs`（绑定的结论 id 列表）、
`evidenceType`（15 种证据类型，缺省按 `sourceUri` scheme 推断）、`filingDate`（公开日判定用）、
`caseType`（`invalidation` / `infringement` / `new_product_method`），以及下列规则条件开关。

**硬约束与失败模式**：
- **条件未提供的规则进 `rulesPending`，不误判为失败**：条件含未提供输入的规则既不进
  `rulesMatched`（实际适用的规则），也不判为「违反」，只进 `rulesPending` 并列出
  `pendingInputs`。
- **`rulesMatched` 只给实际适用的规则**，不是全量规则表。
- **评分是确定性加权**：权重 `relevance 0.35` / `legality 0.30` / `authenticity 0.35`
  （可经 `rules/patent/evidence-rules.yaml` 配置）。
- **只读**：不写证据库。

**条件编号含义（EVI-xxx）** —— 属性描述里出现的编号，含义在此：

| 编号 | 规则 | 法条依据 | 条件（对应输入） |
|---|---|---|---|
| EVI-001 | 证据相关性审查 | 专利法实施细则第 65 条 | 有绑定结论 id + 方向明确 |
| EVI-002 | 证据合法性审查 | 民事诉讼法第 63 条、最高院证据规定 | 来源明确 + 收集合法（`collectionLegal`） |
| EVI-003 | 证据真实性审查 | 最高院证据规定第 90 条 | 内容哈希可用 + 来源可追溯 |
| EVI-010 | 电子证据审查 | 最高院互联网法院规定 | 有 `sourceUri`；平台可信度分级（gov/court/cnipa 0.95 … 社交平台 0.25） |
| EVI-011 | 域外证据审查（action=notify） | 最高院证据规定第 16 条 | 已公证（`notarized`）+ 已认证（`legalized`）+ 已附中文译本（`translated`） |
| EVI-012 | 证人证言审查 | 民事诉讼法第 72–75 条 | 利害关系已披露（`witnessDisclosed`） |
| EVI-013 | 公知常识免证（action=exempt） | 最高院证据规定第 10 条 | 公知常识（`isWellKnown`）+ 无争议（`isUncontested`） |
| EVI-020 | 举证责任分配 | 民事诉讼法第 64 条 | 案件类型明确（`caseType`）；invalidation=请求人/优势证据，infringement=专利权人/高度盖然性，novelty_challenge=质疑方/优势证据 |
| EVI-030 | 证明标准 | 民诉法解释第 108 条 | 支持性证据已计数（`supportingCount`）+ 矛盾证据已计数（`contradictingCount`）；高度盖然性 ≥80%、优势证据 >50% |
| EVI-040 | 公开日期认定 | 专利法第 22 条第 2/3 款 | 有公开日（`docVersion`）+ 有申请日（`filingDate`） |
| EVI-050 | 证据链完整性 | 最高院证据规定 | 保管链可追溯（`custodyChainTraceable`）+ 完整性已核验（`integrityVerified`） |
| EVI-051 | 举证期限（action=notify） | 民事诉讼法第 65 条 | 举证期限已定义（`deadlineDefined`）+ 期限内提交（`submissionWithinDeadline`） |
| EVI-060 | 电子证据完整性 | 电子签名法、最高院电子数据证据规定 | 有内容哈希（`contentHash`） |
| EVI-070 / EVI-071 | 审查指南证据规则参照 | 指南第二部分第三章 2.1 节 / 3.2 节 | 仅供参考，不作条件判定 |

**口径与依据**：
- **类型特定检查**：电子证据（平台可信度 + 内容完整性 + 取证合法性）、互联网公开（首次公开日
  与完整性）、使用公开四要件、域外证据（公证/认证/译本）、公知常识免证。
- **证据类型枚举（15 种）**：`general` / `foreign_language` / `overseas` / `electronic` /
  `witness_testimony` / `expert_opinion` / `common_knowledge` / `notarial_certificate` /
  `burden_of_proof` / `standard_of_proof` / `prior_art_date` / `procedural` /
  `internet_publication` / `public_use` / `design_comparison`。
- **输出字段**（逐项见 `outputSchema`）：`judgment`（`spanId`、`overallScore`、`confidence`、
  `relevance`/`legality`/`authenticity` 的 `score`+`level`、`typeSpecific`、`flaggedIssues[]`、
  `reasoning`）、`burden`（`burdenHolder`、`standard`、`hasShifted`、`reasoning`）、`claimRefs[]`、
  `rulesMatched[]`、`rulesPending[]`。

**边界**：只做确定性规则判定与评分，不替代律师对证据的实体论证、不给胜负结论；
在 OA 答复、无效宣告论证引用证据前调用，用于提前发现证据缺陷。

---

## claim_chart_build

**用途**：构建权利要求对照表（claim chart）——把权利要求拆为编号要素，逐要素映射到对比文件
或产品证据（每行带 pin-cite 引用），并输出 gap list（证据薄弱的要素）。

**关键入参**：`mode`（`infringement` / `invalidity` / `oa-response` / `reexamination` /
`patentability`）、`claim_text`（权利要求原文，可含多条）、`targets[]`（`id` 如 D1/D2/产品A、
`kind` 为 `prior-art` 对比文件 / `accused-product` 被控产品、`title`、`source_path` 目标全文
文件路径）、`case_id`（案卷 ID）。

**硬约束与失败模式**：
- **要素必须是权利要求原文的逐字连续子串**：改写即不合格。
- **要素编号连续**：形如 `1a` / `1b` / `1c`，按顺序连续。
- **三关校验，不通过打回重做**：① 形状（行必须有 `elementId`/`targetId`/`quote`/`pinCite`/
  `mapping`）→ ② 要素校验（逐字 + 编号）→ ③ 引用完整性（未知 `elementId`/`targetId` 是幻觉
  引用，不得进入 chart 与 gap 推导）+ pin-cite 格式 + quote 是否真在源文里。
- **无目标对象时不得产出映射行**：`targets` 为空 ⇒ `rows` 必须为空数组（幻影引用行会被打回）。
- **mapping 合法性按 mode 校验**：`doe`（等同）仅侵权场景可用；`anticipation`（单篇公开）与
  `obviousness-combination`（组合公开）仅对比文件可用。
- **未提供 `source_path` 时只校验 pin-cite 格式**，不校验段号存在性与 quote 子串。
- **失败不静默**：构建失败返回 `ok: false` + `error`（content 带失败原因），不返回半成品 chart。
- **只读**：不写任何外部状态（仅在给出 `case_id` 时把产物落到案卷输出目录）。

**口径与依据**：
- **适用场景**：撰写（可专利性布局）、OA 答复、无效/复审、侵权比对。
- **mapping 取值**：`literal`（字面对应）/ `literal-construction-dependent` /
  `doe`（等同，仅侵权）/ `anticipation`（单篇公开，仅对比文件）/ `obviousness-combination`
  （组合公开，仅对比文件）/ `partial` / `not-found` / `needs-evidence` /
  `construction-dependent` / `unevaluated`（未评估，仅当确无结论时显式标注）。
- **pin-cite 格式**：`[D1 段[0032] 图3]`。
- **gap list**：证据薄弱的要素（未找到 / 证据不足 / 部分覆盖等）。
- **落盘**：给出 `case_id` 时产物写到 `data/cases/<case_id>/outputs/`（JSON + Markdown），
  工具返回 `jsonPath` / `mdPath`；未给出 `case_id` 不落盘。
- **输出字段**（逐项见 `outputSchema`）：`ok`、`chart`、`jsonPath`、`mdPath`、`error`。

**边界**：只做要素级映射与缺口清单，不作法律结论（不判断等同/显而易见是否成立）；
pin-cite 与 quote 的真实性校验依赖目标全文文件，未提供 `source_path` 时该层校验不生效。
