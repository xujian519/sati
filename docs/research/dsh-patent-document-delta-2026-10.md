# deepseek-harness → Sati 引入差集分析：专利域 与 文档模式

> 调研日期：2026-10-15
> 对照仓：`/Users/xujian/projects/deepseek-harness`，基线 commit **`ced0da27c6`**（2026-10-15 16:37，`dsh-v0.2.1-alpha.3-1046-gced0da27c6`）
> 本仓基线：Sati `3cdbb9dcf`（Merge PR #684，`feat(patent): 申请文件 docx 输出`）
> 方法：两侧源码逐模块阅读 + `grep` 存在性判定 + **对已构建产物跑真实探针**（见 §5）；不采信 README 承诺，只采信读到的代码与跑出的结果
> 定位：本文件是**方向反转**的一份——既有 `docs/sati-as-dsh-plugins-plan.md`（在 dsh 仓内）把 Sati 专利域**正向移植进 dsh**；本文件评估的是 dsh 侧**后来长出的、Sati 没有的**部分**反向回移**进 Sati 的价值与代价

---

## 0. 与既有研究的关系（避免重复劳动）

| 既有文件 | 覆盖范围 | 与本文件的关系 |
|---|---|---|
| `docs/research/patent-figure-dsh-delta-2026-10.md`（2026-10-01） | **附图**域差集（矢量几何量测、字体独立、illustrator 角色…） | 本文件**不重复**附图域；仅在 §7 标注其结论仍然有效 |
| `docs/research/dsh-ecosystem-research.md`（2026-08-18） | dsh 宿主/插件**生态** | 本文件聚焦仓内源码能力，不涉生态治理 |
| `docs/deepseek-harness-phase1/2/4-plan.md`（2026-08） | loop/上下文/测试基建**工程纪律** | 已落地（单调 guard、遮蔽压缩、重放测试、请求重建…）；本文件不重复 |
| `docs/sati-as-dsh-plugins-plan.md`（dsh 仓内，2026-08-17） | Sati→dsh **正向移植**清单与耦合面 | 本文件是**反向**；其 §2.1 耦合面表恰好是反向回移的"接缝地图" |
| 本文件 | **专利域业务闭包 + 文档模式（preset/模板/风格/交付门禁）** | 前四者未覆盖 |

**范围排除**：dsh 的 Cordis/profile/bundle 插件框架、gateway 协议、Web/Electron 壳、IM 渠道、白盒记忆、智能路由——Sati 已有自有分叉，不在本文件评估范围。

---

## 1. 结论摘要

### 1.1 一句话

dsh 的专利树在 2026-08 是 **Sati 的移植产物**（`patent-core`/`patent-rule`/`patent-workflow`/`patent-document` 全部来自 Sati），但**此后 dsh 长出了 6 个 Sati 没有的包**——它们的共同特征是**「随包索引 + 机械核验 + 拒绝无据输出」**：`patent-deadline`（期限算术）、`patent-fees`（官费）、`patent-law`（引用核验）、`patent-index-asset`（索引资产底座）、`patent-filing`（DOCX 成品核验）、`writing-patterns`（撰写模式编译）。这正是 Sati 专利域当前最完整的缺口面：**Sati 的强项在"生成与工作流门禁"，缺的是"数值/条文/成品三类可核算事实的核验闭环"**。

文档模式（`document` preset）则是一整套 Sati 完全没有的形态：**写作风格模型 + 类型化模板变量 + 交付登记与确定性核验 + 交付前置门禁 + 交付工作室 UI**。其中 Sati 有一处**同名不同义**的关键误解需要先纠正（见 1.2）。

### 1.2 必须先纠正的一处同名不同义

| | Sati `DocumentStyle` | dsh `DocumentStyle` |
|---|---|---|
| 管什么 | **排版**：字号/行距/页边距/字体/颜色/品牌 | **文风**：语气、语态原则、禁用词、免责声明、引用格式、输出约定 |
| 证据 | `src/patent/document/style.ts:1-4`（"排版参数编译…编译为 CSS 变量覆盖"）、`stylePreset.ts`（预设目录的存取） | `packages/document/doc-style/assets/styles/*.yaml`（六段：`tone`/`voice`/`anti_patterns`/`disclaimers`/`citation`/`output_conventions`） |
| 产物 | CSS 变量插进 HTML | 注入系统提示的**风格指南段落**，且是 `document_deliver` 机械核验的同一张禁用词表 |

**两者互补，不重叠**。Sati 当前**没有文风层**（`grep styleGuide|风格指南|安全声明` 全仓零命中；`免责声明` 只出现在 `quality-gate.ts`/`output-gate.ts` 的零散逻辑里）。若只按名字判断，会误以为"已有、不必引入"。

### 1.3 分层结论

| 层 | 内容 | 判断 |
|---|---|---|
| **A. 直接可引入（高价值 / 低耦合）** | `patent_deadlines`（⚠️ 需先扩日历资产）、`patent_fees`、`law_verify`（⚠️ 只拦条号不拦命题）、`patent-index-asset`、`document_deliver` + 文风资产、`patent-filing` 的**成品核验**、`workspace-changes` | 建议排期；A2–A4 的断言**已实测**（§5.5–5.7），两处 ⚠️ 见 §8 |
| **B. 机制引入（换 Sati 语料）** | `writing-patterns` 的 `<writing_skills>` 确定性编译 + 四维质量评估；`doc-template` 的类型化变量表 + 残余占位符/警告上报 | 建议排期，语料用 Sati 自有内容 |
| **C. 需适配后再引入** | `docx-kit` 的 **DOCX→文本投影**（Sati 核验 docx 的前提）；`patent_teams_wait`（事件驱动等待）；`office-to-pdf`（有界队列+缓存） | 视 Sati 侧需求 |
| **D. 不建议引入** | `patent-filing` 的 Python 引擎（`assets/engine/*.py`）；`doc-template` 的模板语料（Sati 自己的 5 个中文模板更贴实务）；document preset 的 OpenDesign 挂载；`patent_teams_claim_task` | 见 §4 / §6 |

---

## 2. 专利域差集（逐项）

### 2.1 总览

| dsh 包 | 体量（src / assets / tests） | Sati 对应 | 差集性质 |
|---|---|---|---|
| `patent-index-asset` | 4 文件 / **251 行** / 0 / 1 | **无** | 底座缺失 |
| `patent-deadline` | 10 文件 / **2 225 行** / 1 / 10 | **无**（`patent_docket` 不是期限） | 能力缺失 |
| `patent-fees` | 7 文件 / **1 487 行** / 1 / 6 | **无** | 能力缺失 |
| `patent-law` | 8 文件 / **1 428 行** / 3 / 6 | 只有 `law_search`（全文检索） | 核验闭环缺失 |
| `writing-patterns` | 8 文件 / **1 248 行** / 10 / 8 | **无** | 机制缺失 |
| `patent-filing` | 10 文件 / **1 320 行** / 9 / 11 | 有 docx 渲染（1 455 行），**无核验** | 核验缺失 |
| `patent-teams` | 16 文件 / **4 950 行** / 0 / 15 | `src/agent/team/` + 11 个 `team_*` 工具 | 底座同源，**模型面工具集有差** |
| `patent-tools` 增量 | `parse-office-action.ts` 102 行、`patent-analysis-report.ts` 225 行 | **无** | 小工具缺失 |
| `patent-core` / `patent-rule` / `patent-workflow` / `patent-document` / `patent-knowledge` / `patent-data` / `methodology` / `tool-literature` | — | **Sati 已有**（且为正向移植源头） | 已覆盖 |

### 2.2 `patent-deadline` —— Sati 最硬的空白

**Sati 现状**：`patent_docket`（`src/tool/builtin/patentDocketTool.ts:157`）是**案卷轮次控制**——gap 清单 → 派发 → 有界修订循环 → finalize 门；**不算任何日期**。全仓 `grep 顺延|法定节假日` 只命中 `src/web/server/injectWebMessages.ts` 与 wiki 正文，**没有期限计算代码**。

**dsh 提供**：
- 实施细则的**期限算术**（期间起算、对应日、休息日顺延）+ **送达日**确定；
- 随包节假日日历 `assets/work-calendar/cn-holidays.yaml`（**仅 2025-2026**，超出年份报 `calendarCaveat` 并给未顺延值——降级不静默）；
- 两类**故意不由工具推断**的输入：是否主张优先权（决定实审请求的起算日）、顺延判据（法定读法与未顺延读法**两个末端日期都返回**）；
- 通知起算的期限（授权通知的登记/分案、驳回决定的复审、通知书的答复期…）**一律报"待定"并指名仍缺哪条送达记录，绝不从申请日近似**；
- 年费从授权公告日推出的专利年度编号。

**为什么值得引入**：这是专利实务的**刚需且可机械判定**的领域，而 Sati 的撰写 SOP（`patent_drafting_v1`、`patent_oa_response_v1` 等 manifest）目前**没有期限输入**——dsh 的 `patent-oa-response` 技能明确"期限一律由 `patent_deadlines` 给出"。Sati 有 SOP 却无期限源，是链条上的一处悬空。

**代价估计**：2 225 行 TypeScript，依赖面干净（仅 `schemastery` + `yaml` 用于配置/资产读取，**无 Cordis、无 dsh 内部包**），无 `locale/`（无 i18n 成本）。核心可搬；配置层（Schemastery）需换成 Sati 的配置形态。**⚠️ 但有一条前置数据工作**：随包节假日日历只覆盖 2025–2026，实测一个 2026 年申请的发明案 8 条期限里 5 条越界（含必然越界的 20 年专利期限）——见 §5.7。

### 2.3 `patent-fees` —— 官费/年费/减缴

**Sati 现状**：`grep 官费|减缴|缴费` 在 `src/` 零命中（只命中 wiki 正文）。

**dsh 提供**：随包费用索引 `assets/fees/cn-fees.yaml`；按**计数基准**计价（每件 / 超过免费基数的每项权利要求 / 每页 / 每项优先权 / 每个专利年度 / 每请求月数）；减缴（个人 85%、企业 70%）；**任一项适用而无金额即扣住合计**（`说明书附加费`、`延长期限请求费`分档收费、条目模型承载不了 → 不给总额）。每条都记**抄录文书 + 抄录日期**，并首行声明"无人回读过副本"。

**关键设计**：`patent_fees` **不自己算日期**——年费年度与滞纳月数作为入参，由 `patent_deadlines` 提供。两个包**共享同一个口径**，避免"期限一套算法、费用另一套"。这对 Sati 的落地顺序有硬约束：**先 deadline 后 fees**。

### 2.4 `patent-law` 的 `law_verify` —— 引用核验闭环

**Sati 现状**：`law_search`（`src/knowledge/legal/law-search-tool.ts:102`）做**法规全文检索**；`rule_check` 有 `PAT-*` 关键词门禁。**没有任何一处判定"这个条号是否存在、所引命题是否与该条相符"**。dsh 的 README 直言它解决的正是这个"此前散落四处"的问题（静态主题表 / 规则资产里的条号上限 / 145 个规则文件的 `legalBasis` 散文 / 一个未随包的基线文件）。

**dsh 提供**（可搬的要害）：
- 三类判定：`valid` / `not-indexed`（条号有效但索引没抄）/ **`未核验`**（指南只索引主题词、未抄正文 → **永远是未核验，绝不放行**）；
- **条文上限已核验**：专利法 82 条、实施细则 149 条；超上限判"条号超出有效范围"，与"索引中不存在"**区分**；
- 覆盖是**部分**的且自己说清：《专利法》索引 37/82、《实施细则》26/149；
- 五处自我纠错记录在 Known Limitations（含"抄正文后发现 26 条里有 9 条挂着别人的主题词"）——**这是"索引可信度靠内容而非运行时承诺"的诚实样本**。

**为什么值得引入**：Sati 有 `patent-provenance-claim-coverage-plan.md` 的溯源体系与 `rules/patent/*.yaml`（96 条）的 `legalBasis` 散文，但**没有任何机械判据**能拦住一个编造的条号。这是"输出门禁"能不能真正闭死的关键一环。**但边界要说清（§5.5 实测）**：它能拦"条号不存在"，**拦不住"条号与命题不匹配"**——命题句里塞进任一主题词即判通过。

### 2.5 `patent-filing` 的成品核验（Sati 最便宜的一刀）

**Sati 现状**：`src/patent/document/docx/`（`renderApplicationDocx.ts` 298 + `applicationTemplate.ts` 337 + `htmlToOoxml.ts` 347 + `ooxml.ts` 291 + `imageInfo.ts` 127 + `index.ts` 55 = **1 455 行**）已能"复用母版整包 + 按件重建 `w:body` + 补图片关系"，模板缺件 `fail-closed`。**但 `grep verify|校验|反推|sha256|fingerprint` 在 `src/patent/document/docx/*.ts` 零命中**——产物**没有对照**。

**dsh 提供**：`verify_patent_filing` 断言成品与模板一致——逐项比对**格式参数、节边界与内容**，并返回**模板 SHA-256** 与"从模板反推出的格式"（字号/行距/首行缩进/节数/页眉）。另有两个诚实的边界声明：**页数不核验**（Word 实际分页取决于字体度量，LibreOffice 给的不是仲裁）；**模板没有表格**，故 `table_size_pt` 是唯一不能反推的值、改由 spec 声明并经 `max_sizes_pt` 断言。

**为什么这是最便宜的一刀**：Sati 已经有渲染器与母版，**缺的只是"写完再读回来对一遍"**。不需要引入 dsh 的 Python 引擎（§6），只需按 `verify.py` 的断言清单在 Sati 现有的 JSZip/TS 管线上补一个校验器。判据明确、收益直接（申请文件是交给 CNIPA 的正式件）。

### 2.6 `patent-tools` 的两个小工具

- `parse-office-action.ts`（**102 行**）：审查意见通知书解析。Sati 的 `patent-oa-response` 技能（在 `skills/`）依赖人工读通知书；dsh 把它做成了确定性解析步骤（`patent_oa_response_v1` manifest 的入口）。
- `patent-analysis-report.ts`（**225 行**）：分析报告产物。

体量小、判据清楚，可与 2.5 同批。

### 2.7 `patent-teams` 的真实差异面（不要把底座差异说大）

**必须说清**：Sati 的团队底座**不落后**。`src/tool/builtin/team/teamTasks.ts:4,131,274` 显示 Sati 已有 **attemptId + stale-attempt fail-closed**（写入 attempt 陈旧即拒）与 **scheduler 自动领取就绪任务**、依赖解锁、`maxAttempts`（默认 3）。这与 dsh 的"原子领取 + attempt 撤销"**语义同源**。

真实差异只在**模型面工具集**：

| 工具 | dsh | Sati |
|---|---|---|
| `claim_task` | 有（模型显式领取） | 无（**调度器自动领取**——设计取向不同，不是缺陷） |
| `wait`（事件驱动等待） | 有（`tools.ts:386`，`teams.wait(agent, timeout, signal)`，**阻塞至团队下一次变化**——任务流转/成员报告/名册变更/成员起停；返回后要求重读 status；**明确禁止轮询**） | **无**（`teamStatus.ts` 无 subscribe/onChange/wait 命中） |
| `delete` | 有 | 无（有 `team_archive`） |

**值得引入的只有 `wait`**：dsh 本轮基线提交正是 `feat(patent-teams): wait for team changes instead of polling`——这是一个**真实痛点**（Sati 的队长会话只能轮询 `team_status`）。`claim_task` 属设计取向差异，**不建议**照搬（会与既有自动派发形成双写）。

### 2.8 `writing-patterns` —— 机制值得，语料不值得

**Sati 现状**：**无**。Sati 的撰写知识在 `skills/`（`patent-draft-claims`、`patent-draft-specification`、`patent-drafting-general/mechanical/chemical/software` 等），是**给人/模型读的散文式检查清单**。

**dsh 提供**（要害在机制，不在语料）：
- 语料：`assets/patterns/*.yaml` **10 个文件、共约 274 行**（源出 MIT 项目 `Mady/domains/writing`）——**明显少于 Sati 的 skills 内容**，不值得搬；
- 机制（值得）：
  1. **确定性词法选择**：评分表固定（命中 name +3 / summary +2 / context +1.5 / step name +1 / 规则 +0.5，再乘 pattern 质量），同分按 id 升序 → **同一查询永远同一结果**，不经过模型；
  2. **`<writing_skills>` 确定性编译**：`compileWritingSkills` 是 pattern 的**纯函数**，输出与注入提示的块逐字一致 → **调用方可断言注入文本**（这对 Sati 的 llm-replay 重放缝是天然契合）；
  3. **四维质量评估**：结构 / 引用 / 论证 / 术语，词法表打分取均值——README 自己声明"是启发式建议，不是判断"，**不冒充审校**；
  4. **资产 fail-loud**：目录不可读/无 pattern 文件/YAML 语法错/重复 id/字段缺失或超范围 → 加载期抛 `PatternAssetError` 并指名文件与字段（"资产失败在加载，不在调用"）。

**对 Sati 的落地形态**：把机制（选择器 + 编译器 + 资产校验）引入，`patternDir` 指向 Sati 自有的撰写要点集合（可从 `skills/patent-draft-*` 的结构化部分抽取）。

### 2.9 `patent-index-asset` —— 上面三个包的底座

**251 行**，依赖仅 `schemastery` + `yaml`。定义"随包索引资产"的格式契约：YAML 映射步骤、**严格字段读取器**、以及**每条转录项必须记录的 source + verification date**、以及畸形索引的加载错误。

**判断**：引入 `patent-deadline`/`patent-fees`/`patent-law` 三者时**建议连带引入**——否则三个包各写一套"读 YAML + 记来源 + 校验字段"，正是 dsh 批评的"同一约束的第二套口径"。

---

## 3. 文档模式差集

### 3.1 dsh 的「文档模式」到底是什么

它是一个 **agent preset**（`packages/bundle/web-app/presets/document.patch.yml`，`name: 文档模式`，`order: 6`），而不是一个工具或一个 UI 页。装配内容：

| 组成 | 内容 |
|---|---|
| persona | 文档交付工程师人设（六条作业纪律：交付物即文件 / 无来源即撤回 / 不发明品牌 / 自包含 / HITL 不可跳过 / 质量门强制） |
| plan-mode 章节 | 文档版计划纪律：交付规范、大纲、模板选择、导出清单都属"计划"，**获批前不得生成对外交付文件** |
| 6 个技能 | `document-brief`（需求→交付规范）、`document-html`、`document-report`、`document-deck`、`document-word`、`document-quality-gate`（P0/P1 清单 + 工具侧确定性核验） |
| 工具行 | `document_deliver`、`doc-template`（`list_doc_templates`/`render_doc_template`）、+ standard 行集 |
| 风格行 | `doc-template` 的 `styleGuide: assistant-neutral` 把风格指南注入系统提示；`document_deliver` 的 `defaultStyle: assistant-neutral` **必须同名**，且 `tests/document-preset.spec.ts` 在两名漂移时失败 |
| 交付门 | **无**（与专利模式刻意不同，理由见其 README：`document_deliver` 是终端声明，其后没有工具可被前置） |
| UI | `ui-document-studio`（22 文件 / 2 520 行）：`conversation.view` 的"交付物"页，从会话日志折叠出文件列表 + 门禁徽标 + 机器核验徽标；会话 preset 是文档模式时自动切到该页 |
| 治理 | `scripts/preset-mode-baseline.json`：逐模式记 `class`、`personaMaxChars`、`requiredRows`——**人设正文设上限，增长必须是一次有意的改动** |

### 3.2 逐项差集

| # | dsh 能力 | 证据 | Sati 现状 | 判断 |
|---|---|---|---|---|
| D1 | `document_deliver`：交付登记 + 5 类**确定性核验**（`placeholder`/`anti_pattern`/`empty_section`/`broken_anchor`/`length_budget`），`block` 级**拒绝登记** | `packages/document/document-deliver/src/checks.ts:28`（检查 id 清单）、`:414`（`checkDocumentText`） | **无**（`ui/src/components` 无 delivery/deliverable；chat 只有 `fileArtifacts` 事件） | **引入**（见 §5 探针的适配代价） |
| D2 | 文风模型 `doc-style`：`tone`/`voice`/`anti_patterns`(带 replace + block/warn)/`disclaimers`/`citation`/`output_conventions`；4 份随包风格；**加载 fail-loud**（上游"缺目录跳过、坏文件跳过"被改为错误） | `packages/document/doc-style/assets/styles/*.yaml` | **无**（Sati 的 `DocumentStyle` 是排版，见 §1.2） | **引入** |
| D3 | 类型化模板变量：YAML front-matter + 变量 schema + **残余占位符与警告上报** + MD/HTML/DOCX 三渲染器 + 12 个模板语料 | `packages/document/doc-template/src/{loader,vars,renderers}` | Sati 模板是**元素 id 替换 + CSS 变量注入**；`grep "{{"` 在 `assets/templates/patent/` **零命中**——**无变量表、无残留上报** | **引入机制**，语料用 Sati 自有 5 模板 |
| D4 | `docx-kit`：**MD→DOCX** + **DOCX→文本投影**（6 级标题/段落/列表/表格/行内粗体与代码；纯 Node 标准库，无依赖），解析失败**返回结构化问题**而非抛出 | `packages/document/docx-kit/src/{markdown,docx-write,docx-read,zip,xml,ooxml}.ts` | Sati 有**申请文件专用** DOCX（JSZip，1 455 行），**无通用 MD→DOCX，无 DOCX→文本读取**（`AttachmentResolver.ts:67` 只把 `.docx` 列为附件类型） | **引入 DOCX→文本投影**（D1 核验 docx 的前提）；MD→DOCX 视需要 |
| D5 | `office-to-pdf`：有界队列 + 缓存的 Office→PDF | `packages/document/office-to-pdf/src`（656 行） | **无**（Sati 走 Chrome headless 出 PDF） | 视需要 |
| D6 | `workspace-changes`：**逐轮工作区文件变更**——git 工作树快照 + 整文件捕获 + 逐文件比较（`numstat`） | `packages/deliverables/workspace-changes/src`（1 295 行） | **无** | **引入**（"这一轮改了哪些交付文件"在 Sati 缺机械判据） |
| D7 | 交付前置门禁 `deliveryGate`：声明"某交付工具被调用前，本会话内必须已成功执行过哪些工具"，未满足即**拒绝该次调用**；台账按 agent 归属、跨会话不继承 | `packages/patent/patent-rule/src/runtime/delivery-gate.ts`（**126 行**）+ `presets/patent.patch.yml:366-393`（`render_patent_document` ⟸ `[rule_check, law_verify, matter_log_append]`） | Sati 有 `rule_check` 与**输出**门禁（后置）+ `ToolGuard`（单调 deny）；**无"前置交付门"** | **引入**（机制 126 行，Sati 的 guard 体系是现成落点） |
| D8 | 交付型**模式装配**（persona + 计划章节 + 技能组 + 工具行集 + baseline 测试 + 人设字数上限） | `presets/document.patch.yml`、`scripts/preset-mode-baseline.json` | Sati 有 `products/`（白标）、`skills/`（含 `type: role`）、`rules/` 分层包；**无"交付型模式"这一层** | **引入理念**（见 §6 判断） |
| D9 | 交付工作室 UI | `packages/client/ui-document-studio`（22 文件 / 2 520 行） | **无** | 视 Sati 的 patent 面板投入意愿 |

---

## 4. 明确不引入 / 已被覆盖（防重复劳动）

| 项 | 判定 | 理由 |
|---|---|---|
| `patent-core` / `patent-rule` / `patent-workflow` / `patent-document` / `patent-knowledge` / `patent-data` / `methodology`(TRIZ) / `tool-literature` | **已覆盖** | 它们本就是 Sati→dsh 正向移植的产物；Sati 侧是源头 |
| `patent-filing` 的 `assets/engine/*.py`（`build.py`/`style.py`/`verify.py`）+ `申请文件模板.docx` + `spec/申请文件.json` | **不引入** | Sati 已有等价 TS 渲染器（1 455 行，JSZip）。引入 Python 引擎＝在同一能力上开出**第二套渲染口径**（AGENTS.md 禁止的"同一约束两套口径"）。**只取其 `verify.py` 的断言清单** |
| `doc-template` 的 12 个模板语料（`oa-response/*`、`specification/{机械,化学,软件,电学}`…） | **不引入语料** | Sati 的 `assets/templates/patent/` 5 个中文模板是实务件（含 `manifest.json` + `tokens.css` + `example.html` + `references/`），更贴交付场景；dsh 语料是英文工程模板形态 |
| `writing-patterns` 的 10 个 pattern YAML（274 行） | **不引入语料** | 少于 Sati 的 `skills/patent-draft-*`；且源出 `Mady/domains/writing`，Sati 另有 Mady 移植记录 |
| document preset 的 OpenDesign 技能挂载（`OPEN_DESIGN_DIR`，276 个技能/模板目录） | **不引入** | Sati 已有 `frontend-design`/`html-*` 系列交付技能与 `assets/prompts/html/` 约束资产；再挂一套会形成两套 HTML 交付口径 |
| `patent_teams_claim_task` / `patent_teams_delete` | **不引入** | Sati 是"调度器自动领取"取向（`teamTasks.ts:131`），照搬模型面显式领取会与自动派发**双写** |
| dsh 的 Cordis/profile/bundle/`--dump-config` 框架 | **不引入** | 属宿主框架，Sati 已有 `src/extension/` 自有分叉（`docs/research/dsh-ecosystem-research.md` §7 早有结论） |

---

## 5. 实测探针记录（不静默）

按"安全网/门禁类资产不读注释、要构造最小反例跑一次"的纪律，对最关键的 D1（`document_deliver` 核验器）与 A2–A4（`patent-law`/`patent-fees`/`patent-deadline`）做了真跑。**探针使用 dsh 已构建产物**（`packages/**/lib/index.js`），**只读、未写入 dsh 工作树**。

### 5.1 探针 1：核验器能否独立运行？（可以）

```
loaded styles: assistant-neutral, chat-friendly, legal-standard, patent-standard
```
→ `doc-style` + `document-deliver` 的 lib 可被独立 `import`，**不依赖 Cordis 上下文**，即可脱离 dsh 宿主试跑。**这是它们"可搬"的直接证据。**

### 5.2 探针 2：禁用词门禁真的会拦？（会，负控制通过）

| 风格 | 禁用词条数 | 其中 `block` |
|---|---|---|
| `patent-standard` | 10 | 6 |
| `legal-standard` | 6 | 5 |
| `assistant-neutral` | **1** | **0** |
| `chat-friendly` | **1** | **0** |

- 负控制：`"本方案绝对优于现有技术，完全解决了该问题。"` → 2 条 `block`（"绝对"→建议"通常"；"完全"→建议"基本"）；改成替换词后 → **0 条**。门禁有效，不是空壳。
- ⚠️ **但文档模式默认风格 `assistant-neutral` 只有 1 个 `warn` 级词**——即**文档模式出厂状态的"禁用词门禁"实际拦截力≈0**；真正有内容的是专利风格（10 词 / 6 block）。引入时应把 Sati 需要的禁用词补进风格资产，否则会得到"装了门但没有门框"的错觉。

### 5.3 探针 3：Sati 随包模板过 dsh 门禁会怎样？（5 个模板 5 个告警，且含 1 个误报）

```
claims-spec            block=0 warn=1 | empty_section: "说明书" 下没有任何内容
invalidation-opinion   block=0 warn=3 | empty_section: "四、无效理由" …
oa-response            block=0 warn=2 | empty_section: "三、争辩意见" …
patentability-opinion  block=1 warn=1 | placeholder: 第 487 行仍有残余占位符 "待补充"
search-report          block=0 warn=1 | empty_section: "二、检索策略" …
```

**结论（两个都重要）**：

1. **`empty_section` 的系统性误报源于"每一级标题都是节边界"**：读实现（`checks.ts:368-378`）——判据取 `heading.end` 到**下一个标题**（`headings[index+1].start`）之间的文本，剥掉 HTML 注释与标签后若为空即判"空章节"；而 `headingSpans`（`checks.ts:248-259`）**同时**收集 Markdown `#` 标题与 HTML `h1`–`h6` 标题。因此 `<h2>五、创造性判断（三步法）</h2>` 紧跟 `<h3>5.1 …</h3>` 时，二者之间只剩空白 → 被判空。**这不是 HTML/Markdown 形状不匹配（判据确实剥了 HTML 标签），而是"父标题只含子标题"在文档语义上并非空章节**，判据却认为它空。→ **引入时须把"节边界"限定到同级或更高级标题（或把父子标题折叠为一个节）**，否则 Sati 的 5 个模板会全部带着噪声告警交付。
2. **`patentability-opinion` 的 `block` 是误报**：第 487 行 `无直接文献支撑（待补充检索）` 是**示例件里的"假设"行内容**（同格带 `badge-assumption "假设"` 标注），语义完整，不是未填的槽位。→ 说明占位符判据**无法区分"示例/演示文本"与"未填模板"**；Sati 若保留带"待补充"字样的示例件，会被自己的交付门拒绝。

### 5.4 探针过程中的一次自我纠错（记录在案）

第一次读风格对象时用了 `style.antiPatterns` → 全部风格报 **0 条禁用词**，几乎据此写出"dsh 的禁用词门禁是空的"这一**错误结论**。复核 `JSON.stringify` 后发现真实字段是 **`style.sections.antiPatterns`**，资产原文（`patent-standard.yaml:22-34`）确有 10 条。**已更正**——这正是"数字必须自己复查"的又一例：探针能证伪，也能造假，取决于字段没读对。

### 5.5 探针 4：`patent-law` 的 `law_verify`

`patent-law` / `patent-fees` / `patent-deadline` 的库 API 同样可脱离宿主 `import`（`lib/index.js` 导出 `verifyCitations` / `computeFees` / `evaluateDeadlines`）。实测结果：

| 断言 | 结果 |
|---|---|
| 编造条号被拦、且与"未索引"可区分 | ✅ `《专利法》第一百二十条` → **`out-of-range`**「共 82 条，第 120 条不存在」；`《专利法实施细则》第二百条` → `out-of-range`「共 149 条」；`《专利法》第一条`（条号有效、未索引）→ **`not-indexed`**「第 1 条不在索引中」——**两者确实分得开** |
| 指南引用**永远**"未核验" | ✅ `《专利审查指南》第二部分第四章第3.2节` → **`unverified`**「已索引，但章节内容尚未转录核验」；假节号 → `not-indexed` |
| 命题不符即 `mismatch`（默认策略 `block`） | ✅ 可达。无关命题「该商标应当核准注册」→ `mismatch`，理由回显该条主题词「新颖性、创造性、实用性、现有技术」 |
| compact 形式 `A22.3` | ✅ → `valid`，按《专利法》第 22 条判 |

**⚠️ 新发现（dsh 的 Known Limitations 未记载）：`mismatch` 有一个明显的**漏放方向**。`matchProposition`（`src/verify.ts:274-280`）是**双向 `includes` 包含**判定：

```js
const matched = entry.topics.some(topic => needle.includes(topic) || topic.includes(needle))
```

只要命题句里**出现任一主题词**即判通过。实测：`"该商标应当核准注册，但本申请具备创造性"` → **`valid`**（前半句与第 22 条无关）。README 只声明了反方向的误报（同义改写 → `mismatch`，实测确认：`"本申请非显而易见"` → `mismatch`），**没有声明"把主题词塞进句子即可放行"这个漏放方向**。→ 引入时须知道：`law_verify` 拦得住"条号不存在"，**拦不住"条号与命题不匹配"**；后者仍要靠人/更强判据。

### 5.6 探针 5：`patent-fees`（计价与拒绝出数都成立）

| 断言 | 结果 |
|---|---|
| 计数基准（超免费基数的每项权利要求） | ✅ 发明专利申请、12 项权利要求 → 申请费 900 + 公布印刷费 50 + 权利要求附加费 2×150 = **合计 1 250.00**（免费基数 10，超出 2 项） |
| 任一项无金额即**不给合计**，且**指名** | ✅ 含"延长期限请求费"时 → `total.amount = null`、`complete: false`、`unverifiedIds: ["extension-fee"]` |
| 减缴（个人 85%） | ✅ 实用新型申请费 `filed: true` → **75.00**（`reduction.applied = true`）；年费第 4 年 → 1200×15% = **180.00** |
| 备案缺失时**降级不静默** | ✅ `filed: false` → 仍报 500.00，但 `reduction.reason` 写明「未办理费减备案：仅对不以此为前提的费种适用」，`notes` 另起一行「本次减缴请求未办理费减备案」 |
| 年费**分档**可计价 | ✅ 第 1/4/13 年 → 900+1200+6000 = **8 100.00**。**修正一处我先前的误读**：索引里 5 个条目顶层 `amount: null`，其中 3 个「年费」条目的价格在 **`tiers`**（分档）里——**顶层无金额 ≠ 不可计价**；README 说的"两项承载不了"指的是**连分档也表达不了**的 `说明书附加费` 与 `延长期限请求费`，与实测一致 |

**一处小瑕疵（不影响正确性）**：按专利类型过滤时，`notes` 只报条目**名称**。实测发明案过滤掉两个年费条目，输出为「已按专利类型过滤：**年费、年费** 不适用本次类型」——同名条目无法区分是哪一条（缺类型限定）。这属"报告的可用性"而非计算错误。

### 5.7 探针 6：`patent-deadline`（期限算术与"不近似"纪律都成立）

| 断言 | 结果 |
|---|---|
| 通知起算的期限**不从申请日近似** | ✅ 未给授权通知时，「办理登记手续并缴纳授权当年年费」进 `pending`，`requiredInput = "grant-notice（授权通知的送达记录）"`，`reason` 明写「未记录该通知送达日即无法计算，**不以申请日起算的固定年数替代**」 |
| 送达日驱动期限 | ✅ 授权通知电子送达 2026-09-01 → 登记手续/分案期限 `rawDueDate = 2026-11-01`（2 个月），`dueDate = 2026-11-02`、`rolledForward: true`、`status: urgent` |
| 优先权声明与日期必须成对（双向 fail-loud） | ✅ 主张优先权但无日期 → `DeadlineQueryError`「实审请求等期限自优先权日起算」；**给了优先权日却声明不主张** → 也抛 `DeadlineQueryError`「两者矛盾，请按案卷事实改其…」 |
| 顺延开关与"两个末端日期都返回" | ✅ `restDayRule: 'apply'` → due 2026-11-02；`'omit'` → due **= raw** 2026-11-01；`rawDueDate`/`dueDate` **始终都给** |
| 日历覆盖缺口**诚实标注** | ✅ 落在 2027+ 的期限带 `calendarCaveat: "calendar-uncovered-year:2027"` |

**⚠️ 新发现（影响"能不能真用"）：日历只覆盖 2025–2026，而它影响的是**大多数**期限，不是边缘情况。** 实测一个 2026 年申请、带授权通知与一通的发明案：`computed` 共 **8** 条，其中 **5** 条带 `calendar-uncovered-year` 告警（优先权期限 2027、恢复优先权 2027、答复一通 2027、实审请求 2029、**专利权期限届满 2046**）。**20 年专利期限必然越界**，所以几乎所有案件都会带着告警交付。→ **Sati 若要引入，必须先解决日历资产的覆盖**（否则"顺延"对绝大多数期限只是装饰，虽被诚实标注但不可用）。这是 §2.2 的成本之外的**前置数据工作**，容易在排期时被漏掉。

### 5.8 本轮三次自我纠错（记录在案）

探针能证伪，也能造假——本轮有三次"差点写出错误结论"的时刻，全部更正：

1. **字段读错（§5.4）**：`style.antiPatterns` 实为 `style.sections.antiPatterns`，一度得出"dsh 禁用词门禁是空的"。
2. **参数漏字段**：`ReductionRequest` 必填 `filed`，首测漏传 → 实用新型申请费报 **500.00**（减缴未生效）。补齐 `filed: true` 后为 **75.00**。**若不复核，会写成"减缴不生效"的假缺陷**。顺带记录它降级时的诚实度：`filed: false` 时不仅报原价，还给出「未办理费减备案：仅对不以此为前提的费种适用」。
3. **类型契约读错（本节）**：`CalendarDate` 是对象 `{year, month, day}` 而非字符串，首测传 `'2026-01-05'` → `rawDueDate` 打印为 **`0NaN-NaN-NaN`**、`calendarCaveat: "calendar-uncovered-year:NaN"`，第一反应是"dsh 的期限工具有 NaN 缺陷"。用 `parseCalendarDate()` 转换后全部正常（§5.7 的 ✅ 即此）。

**第 3 次误操作本身暴露了一个真实的安全网边界**：给错类型时 `evaluateDeadlines` **不抛错**，而是返回 NaN 日期 + `status: "normal"` + 一条诡异告警——**校验守卫在 `parseCalendarDate`（对字符串严格抛 `CalendarDateError`），不在求值器**。所以任何绕过解析器、直接构造 `DeadlineQuery` 的调用方（未来新增的代码路径、或从 JSON 反序列化的输入）都会拿到"看起来正常"的 NaN 期限。→ 回归 Sati 时，**在求值器入口补一道 `Number.isFinite` 断言（fail-loud）**，成本极低，能关掉这条静默路径。

---

## 6. 建议批次

> 成本为**按源代码行数与依赖面估算**（非实测工时）；依赖面已逐包用 `package.json` 核实。

### 批次 A（P0）—— 核验闭环，不改架构

| 序 | 项 | 来源 | 依赖面 | 成本估计 | 判据 |
|---|---|---|---|---|---|
| A1 | **申请文件 DOCX 成品核验**（`verify_patent_filing` 的断言清单） | `patent-filing` | 仅 Sati 现有 `src/patent/document/docx/` | **小**（在现有管线补读回比对 + 模板指纹） | 产出件能对照母版逐项自证 |
| A2 | **`law_verify`**：引用形式 + 索引收录判定，"未转录=未核验"不放行 | `patent-law`（1 428 行）+ `patent-index-asset`（251 行）→ **复核后改为不搬** | `yaml`（Sati 已有） | 中 | 编造条号被拦；`not-indexed` 与"条号超范围"可区分（**§5.5 已实测**）。⚠️ 拦不住"条号与命题不符"，别当命题正确性门禁 |
| A3 | **`patent_deadlines`**：期限算术 + 送达 + 节假日顺延 | `patent-deadline`（2 225 行） | 无内部包依赖 | 中（**+ 前置：从零建日历资产并逐年维护**，比"扩"重） | 通知起算期限报"待定并指名缺口"，不从申请日近似（**§5.7 已实测**）。⚠️ 日历只到 2026，8 条期限 5 条越界——见 §7 |
| A4 | **`patent_fees`** | `patent-fees`（1 487 行） | 依赖 A3 的口径 | 中 | 任一适用项无金额即**不给合计**（**§5.6 已实测**：`unverifiedIds: ["extension-fee"]`、减缴 85% 生效、备案缺失有显式理由） |

**顺序硬约束**：A4 依赖 A3（年费年度/滞纳月数由期限包提供）；A2 与 A1 可并行。

> **2026-10-15 复核（随实施计划回写）**：A2 的"来源"列经复核后**不再搬随包索引**——Sati 已有 `~/.sati/knowledge/knowledge.db`，实测《专利法》82 条、《专利法实施细则》149 条均 `1..N` 无缺号，比 dsh 的摘要级索引更全（见 `docs/patent-verification-plan.md` §2.1）。A3 的前置工作由"扩日历资产"改为**"从零建日历资产并逐年维护"**——Sati 侧此前完全没有节假日设施（同计划 §2.3）。A 批的落地细节（落点、判定表、重放契约成本、反例清单）见 `docs/patent-verification-plan.md`。

### 批次 B（P1）—— 文档模式

| 序 | 项 | 成本 | 说明 |
|---|---|---|---|
| B1 | **文风资产 + 风格指南注入**（D2） | 小 | 4 份 YAML 资产形态可直接照搬；**必须补足禁用词**（见 §5.2：出厂 `assistant-neutral` 只有 1 个 warn 词） |
| B2 | **交付登记 + 确定性核验**（D1） | 中 | 需**改"节边界"判据**（§5.3：父标题只含子标题被判空），并明确"示例件含『待补充』"这类误报的处置（fence 该文本或收窄词表） |
| B3 | **DOCX→文本投影**（D4 的一半） | 小 | B2 要能核验 `.docx` 交付件的前提；纯 Node 标准库实现可读 |
| B4 | **前置交付门 `deliveryGate`**（D7） | 小 | 126 行机制；Sati 的 `ToolGuardRegistry` 是现成落点；先接 `render_patent_document` ⟸ `rule_check` + `law_verify`（+ Sati 的留档工具） |
| B5 | **`workspace-changes` 逐轮文件变更**（D6） | 中 | 为"本轮交付了哪些文件"提供机械判据 |

### 批次 C（P2）

| 序 | 项 | 说明 |
|---|---|---|
| C1 | `writing-patterns` 机制（确定性选择 + `<writing_skills>` 编译 + 四维评估 + 资产 fail-loud），语料换 Sati 自有 | 与 Sati 的 llm-replay 重放缝天然契合（编译是纯函数、可断言注入文本） |
| C2 | `doc-template` 的类型化变量表 + **残余占位符/警告上报** | 让 `render_patent_document` 报出"哪个变量没解析、还剩什么占位" |
| C3 | `patent_teams_wait`（事件驱动等待，替代轮询） | 底座同源，只补模型面工具 |
| C4 | `parse_office_action`（102 行）+ `patent_analysis_report`（225 行） | 小工具，可与 A 批顺带 |
| C5 | `office-to-pdf` 有界队列 + 缓存 | 视 Sati 的 PDF 管线是否需要排队与缓存 |

---

## 7. 已知缺口（不静默）

| 缺口 | 谁因此漏了什么 | 处置 |
|---|---|---|
| 本文件只覆盖**专利域与文档模式** | 附图域、loop/上下文/测试基建的差集不在此处 | 附图域沿用 `docs/research/patent-figure-dsh-delta-2026-10.md`（2026-10-01，其结论按当时基线有效；本文件未复核其 09-24 之后条目是否已被 Sati 补齐） |
| dsh 是 **developer preview**，无兼容性承诺 | 本文件所有体量/行号为 **2026-10-15 快照**；dsh 明确"THERE WILL BE COMPATIBILITY-BREAKING CHANGES" | 回移应**按语义移植**（Sati 的既有做法，见 `pilotdeck-2026-10-upstream-port-plan.md` 的方法论"成本在判定不在搬"），不建立长期跟版机制 |
| 成本为**估算**，非实测工时 | 排期若按此数字执行可能偏乐观 | 每一项落地前先做"最小反例探针"（如 §5），再定工时 |
| `patent-filing` 的 `verify_patent_filing` 断言**仍未实测** | `patent-filing` 随包的是 Python 引擎（`assets/engine/verify.py`），与本机 Node 探针不同栈，未在本轮跑通 | 若 A1 按其断言清单在 TS 侧重写，重写后需用同一批申请文件样张对拍；本轮已实测的 `patent-law`/`patent-fees`/`patent-deadline` 见 §5.5–5.7 |
| `patent-law` 的**索引抄录正确性**不可由运行时证伪 | §5.5 证明 `law_verify` 拦得住"条号不存在"，但**拦不住"条号与命题不匹配"**（主题词塞进句子即放行）；索引条目本身是否抄错也只能靠人工复核 | 该包自己的 Known Limitations 已声明"机械抄录、非复核"；Sati 引入时应把"命题是否真由该条支撑"留给更强的判据（如 `evaluate_evidence` 链路），**不要**把 `law_verify` 当成命题正确性门禁 |
| `patent-deadline` 的节假日日历**只到 2026** | §5.7 实测：一个 2026 年申请的发明案 8 条期限里 5 条带 `calendar-uncovered-year` 告警（含必然越界的 20 年专利期限） | 引入前须先扩日历资产（含"某年政策未发布时如何降级"的口径）；这是**前置数据工作**，不是代码工作 |
| Sati 侧不存在"文风层"的结论基于 `grep` | 若有以别名词汇实现的文风逻辑，可能漏判 | 已在 §1.2 列出检索词；落地前用 `styleGuide`/`anti_patterns`/`disclaimer`/`citation` 再确认一次 |
| OpenDesign 挂载的 skill 数量（276）为其自身文档口径 | 未实测 | 本文件结论**不依赖**该数字（已判定不引入） |

---

## 8. 一句话给决策者

**Sati 的专利域不缺"生成"，缺"核验"**：期限、官费、条号、成品格式这四类**可机械核算的事实**目前在 Sati 全部悬空，而 dsh 已把每一类做成"随包索引 + 机械判据 + 无据即拒绝出数"的独立小包（合计约 5 400 行，依赖面干净、无 i18n 成本）。**文档模式**则带来一个有独立价值的形态：写作风格模型与交付门禁共用**同一张禁用词表**（"被告知避开的词"就是"门禁会拦的词"），加上 126 行的**前置交付门**——Sati 有后置输出门禁与单调 guard，把门**前移**的机制是现成的。最便宜的一刀是给 Sati 已有的 1 455 行 DOCX 渲染器补一个"写完读回来对一遍"的核验器。

**实测后的两处修正（会影响排期，值得单独看）**：
1. **`patent-deadline` 不能直接搬来就用**——随包节假日日历只覆盖 2025–2026，而 20 年专利期限必然越界；实测一个 2026 年申请案 8 条期限里 **5 条**带 `calendar-uncovered-year` 告警。引入前必须先做**日历资产扩充**（数据工作，含"某年安排未发布时如何降级"的口径）。
2. **`law_verify` 的边界比它的名字窄**——它拦得住"条号不存在"，**拦不住"条号与命题不符"**（命题句里出现任一主题词即判 `valid`，实测：「该商标应当核准注册，但本申请具备创造性」→ 通过）。它是**引用形式门禁**，不是**命题正确性门禁**；后者仍须由更强判据承担。

其余断言（编造条号/未索引/指南恒未核验、官费不给无据合计、减缴与备案降级、期限"不从申请日近似"、优先权双向 fail-loud、顺延开关）**均已实测通过**，详见 §5.5–§5.7。
