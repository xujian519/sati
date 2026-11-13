# 专利撰写 / 证据 / 文档族工具契约（drafting-evidence）

本分片覆盖 patent 域 10 个「撰写 / 证据 / 文档族」工具的完整口径：
`render_patent_document` / `patent_pdf_download` / `recognize_chemical_structure` /
`validate_specification` / `knowledge_note_save` / `patent_eval` / `draft_claims` /
`draft_specification` / `search_patent_figure` / `analyze_patent_figure`。

工具 `description` 只保留「做什么 + 硬约束 / 失败模式 + 只读性」；完整口径（模板清单、
入参取值域与联动、失败返回什么、法条/标准依据、适用与不适用边界）在此下沉。
目录总说明见 [index.md](index.md)。

---

## render_patent_document

**用途**：从内置模板渲染专业专利文书（可专利性意见 / 检索报告 / OA 答复 / 权利要求+说明书 / 无效意见），
产出 HTML / PDF / 申请文件 docx。

**关键入参**：
- `template`：模板 id，取值 `patentability-opinion` / `search-report` / `oa-response` /
  `claims-spec` / `invalidation-opinion`（与 `assets/templates/patent/manifest.json` 保持一致）。
- `format`：`html` / `pdf` / `both` / `docx` / `all`，默认 `both`。
- `sections`：分节内容映射。**HTML/PDF 路径**的键是模板 HTML 里的元素 id；
  **docx 路径**的键是申请文件件 id，共 5 件：`abstract`（说明书摘要）/ `abstract-figure`（摘要附图）/
  `claims`（权利要求书）/ `specification`（说明书）/ `drawings`（说明书附图）。
- `output_name`：输出文件名主干（不含扩展名）。
- `case_id`：案卷 id；提供时结果落盘 `data/cases/<caseId>/outputs/`。
- `output_dir`：显式输出目录（覆盖默认目录）。
- `brand`（内联品牌覆盖，优先级最高）/ `brand_path`（theme.json 路径）/ `style`（结构化排版覆盖）/
  `style_preset`（样式预设名）：品牌与排版四件套。

**硬约束与失败模式**：
- **总是产出 HTML**；HTML 是唯一无条件成功的产物。
- `pdf` / `both` / `all` 需 headless Chrome 可用，**否则不出 PDF**——此时输出行报
  `PDF 未生成: <原因>`，HTML 仍照常交付。
- `docx` / `all` **仅 claims-spec 模板**可填申请文件 .docx（取模板自带的 Word 母版
  `assets/template.docx`）；其余模板不产出 docx。
- docx 的三种状态必须在输出里可区分（`未核验` ≠ `已核验且无问题`）：核验通过给一行实测摘要
  （节数 / 段数 / 图数）；生成失败 / 成品核验未过 / 核验未能执行由 `docxError` 报出——
  **有产物 ≠ 可用**，有文件也要报未核验。
- 模板 id 或 `format` 非法 → `invalid_tool_input`（fail-closed，绕过 schema 校验也会在执行入口拦截）；
  其它渲染异常 → `tool_execution_failed`。
- 写盘工具（`isReadOnly: false`），且 `alwaysAsk: true`：默认 skipPermissions 下不该无人值守地落盘。

**口径与依据**：
- 模板目录 `assets/templates/patent/<template>/`；模板清单与版面参数见
  `assets/templates/patent/manifest.json`（A4；页边距上 16mm / 右 18mm / 下 18mm / 左 18mm；
  `renders.default = both`，`renders.supported = html/pdf/docx`）。
- 品牌注入：读 theme.json（默认 `products/_example/brand/theme.json`）的 `documents.patent`
  命名空间并映射为 CSS 变量；theme.json 解析失败回退为空品牌覆盖（不报错）。
- 品牌优先级：内联 `brand` > `brand_path` 指向的 theme.json > 默认 theme.json；
  `style`（结构化排版）优先级高于 brand / theme.json；
  `style_preset` 加载 `products/<产品>/brand/style-presets/<name>.json`，显式 `style` 覆盖预设。
- 渲染核心在 `src/patent/document/`（templateResolver / brandInjector / pdfRenderer / docx）。

**边界**：不做内容审查（不判断权利要求是否被说明书支持、是否充分公开）；不替代理师做法律判断；
不自动生成权利要求 / 说明书内容——分节内容一律由调用方提供。

---

## patent_pdf_download

**用途**：批量下载 Google Patents 的专利公开 PDF 到工作区（逐篇一个文件）。

**关键入参**：
- `patents`：专利公开号列表，1–50 篇（`MAX_PATENTS = 50`）。
- `outputDir`：绝对路径或相对工作区路径；默认 `<workspace>/专利原文/YYYY-MM-DD`。
- `pageTimeoutSec`：单页打开超时秒，默认 20。
- `downloadTimeoutMs`：单篇下载超时毫秒，默认 60000。
- `timeoutMs`：整体超时毫秒，默认 180000，硬上限 300000。
- `record`：录屏保存到 `<outputDir>/recording.webm`，默认 false。
- `force`：忽略 `.MANIFEST.jsonl` 续跑状态，默认 false。

**硬约束与失败模式**：
- 优先走 **ego-browser 会话**（复用 ego lite 登录态，`page.waitForEvent("download")` + `saveAs`）；
  拦截失败则**回退**「提取 CDN URL + fetch 直下」；两者都失败 → 该篇 `status: "failed"` 且
  **保留 `pdfUrl` 供手动重试**，**不中断其余专利**（整批继续）。
- 单篇失败不抛错：失败是**逐篇状态**，不是整批异常。
- ego-browser 不可用时，`checkAvailability` 直接返回不可用（工具被门禁拦下），不是运行期失败。
- 默认整体超时按每篇 25s 推算（下限 60s / 上限 180s）；用户显式给的 `timeoutMs` 最高可到 300s。
- 续跑：输出目录下的 `.MANIFEST.jsonl` 记录已完成篇目；`force=true` 忽略该状态重新下载。
- 输出超 `MAX_OUTPUT_BYTES`（500000）会被截断 / 溢出存储。
- 写盘 + 破坏性工具（`isDestructive: true`）：每次调用都请求授权（allow_once / deny）；
  输出目录解析后落在 workspace 之外时，授权理由会追加越界提示。

**口径与依据**：
- 依赖 ego-browser v1.2.6 的下载拦截能力：在浏览器上下文内下载，复用登录态 / Cookie，
  授权类下载比「提取 CDN URL + urllib 直下」更稳。
- 输出文件名 `<outputDir>/<专利号>.pdf`；逐篇 status：`ok` / `failed`。
- 单次任务在空间会话内批量完成，并以 `PROGRESS` 行输出进度；可选 screencast 留证。

**边界**：**只下载不解析**——不抽取 PDF 文本、不做检索、不做评估；需要全文解析的走 PDF 文本层工具。

---

## recognize_chemical_structure

**用途**：从化学结构式图（图片模式）或文档文本（文本模式）提取**多候选** SMILES、分子式与化合物名称。

**关键入参**：
- `mode`：`image`（图片两步法）/ `text`（文本三级流水线）/ `auto`（按输入分派，默认）。
- `image_path`：化学结构图图片路径（工作区相对或绝对），支持 jpg/png/gif/webp。
- `text`：文档文本片段（说明书 / 权利要求），或单独的化合物名称（走 name→SMILES）。
- `claim_context`：权利要求或技术方案文本（图文对齐，可提高识别准确率）。

**硬约束与失败模式**：
- **不直接解析 PDF**——图片模式的输入须为已导出的图片（jpeg/png/gif/webp）；
  文本模式可传 PDF 文本层提取结果。
- 需要多模态模型：未注入模型客户端 → 返回「当前运行环境未注入模型客户端」错误
  （`metadata.error = unsupported_tool`，`hint = model_client_missing`）。
- `image` 模式必须给 `image_path`；`text` 模式必须给非空 `text`，否则 `invalid_tool_input`。
- 图片字节预算默认 5 MiB；图片路径必须存在（`mustExist`），否则报错。
- **识别失败 / 置信不足按未知处理，不臆造结构**：置信低于阈值、候选被否决或管线降级时，
  `needHumanReview = true` 且 `usable = false`；候选 SMILES 逐个经 RDKit 校验，非法者记
  `validationError`，不产出「看起来合法但没校验过」的结构。
- 识别结果**自动写入化学索引** `.sati/chemistry-index.json`（供后续检索 / 校验管线消费）；
  索引为可选增强，**写入失败静默降级**，不阻断本次识别结果返回。
- **plan 只读模式不写盘**（plan 模式对只读工具自动放行，索引写入会静默绕过只读约束，故显式门控）。

**口径与依据**：
- 图片模式：多模态模型两步分析 + RDKit 校验（默认 provider `moonshot` / model `kimi-k3`）。
- 文本模式：正则候选 → LLM 复核 / 化合物名称转 SMILES → RDKit 校验。
- 置信阈值 `CHEMISTRY_MIN_CONFIDENCE = 0.6`。
- `kind` 分类：`formula`（化学式）/ `structure`（结构式）/ `markush`（Markush 广义结构）。
- 触发场景：交底书 / 说明书 / 权利要求含化学结构式（含 Markush 广义结构）、分子式，
  或化合物名称需要转 SMILES。

**边界**：只做结构识别与校验，不做新颖性 / 创造性判断，也不替人确认结构；
含 `needHumanReview` 的结果**须人工确认后再采信**进权利要求。

---

## validate_specification

**用途**：校验专利说明书是否符合撰写要求，输出违规清单（violations）与评分。

**关键入参**：
- `text`：说明书全文。章节标题支持 **Markdown（#–######）/ 纯文本 / 编号（一、/ 1./（一））/ 方括号（【技术领域】）** 四种格式。
- `title`：发明名称（可选，单独校验长度）。
- `abstract`：摘要（可选，校验长度 / 关键词 / 摘要附图）。
- `claims`：权利要求书全文（可选，提供后启用特征覆盖实质校验）。
- `tech_domain`：`mechanical` / `electrical` / `chemical` / `software` / `general`；
  `chemical` 时附加化学表征数据校验。
- `figure_analysis`：`analyze_patent_figure` 的输出数组（可选），提供时执行图文一致性校验
  （附图说明中的标号 vs 附图分析出的标号）。

**硬约束与失败模式**：
- **缺必备分节判不合格**：五部分（技术领域 / 背景技术 / 发明内容 / 附图说明 / 具体实施方式）
  缺任意一节 → `severity = error`；`text` 为空同样判 error（缺全部章节）。
- 发明名称 > 25 字 → error；摘要 > 300 字 → error。
- 数值范围须给端点值 **且** 至少一个中间值实施例，否则 error。
- 有益效果须有定量效果数据，否则 error。
- 权利要求特征未覆盖（提供 `claims` 时启用）→ error。
- 附图说明中的标记在附图分析中不存在（dangling mark）→ error。
- 文本含 SMILES 时**追加 RDKit 合法性抽检，warning 级**，不改变判级语义。
- 只读工具（`isReadOnly: true`）：不写盘，不改写说明书。

**口径与依据**：
- 规则集在 `src/patent/spec/checks.ts`
  （`SPEC_SECTION_NAMES = 技术领域 / 背景技术 / 发明内容 / 附图说明 / 具体实施方式`）。
- A26.4 = 权利要求特征覆盖（审查指南第二部分第二章的支持 / 充分公开口径）；
  A26.5 = 摘要长度、关键词与摘要附图。
- 使用时机：说明书初稿完成后调用；提供 `claims` 与 `tech_domain` 才启用实质校验
  （否则只做形式与章节校验）。
- 评分为规则违例加权扣分，`passed` 由 score 阈值决定。

**边界**：只做撰写规范与形式校验，不做新颖性 / 创造性评估，也不代写说明书；
修订由调用方按 `violations[].suggestion` 执行。

---

## knowledge_note_save

**用途**：把项目专利产出（OA 答复要点、无效分析结论、检索心得）沉淀到知识库 **personal_note** 层，
后续检索 / 语义召回可命中。

**关键入参**：
- `title`：笔记标题，≤ 200 字符（`MAX_TITLE_CHARS`），同时作为 FTS 索引词。
- `content`：笔记正文，≤ 20,000 字符（`MAX_CONTENT_CHARS`）。
- `project`：来源项目标签（可选，参与幂等与检索过滤）。

**硬约束与失败模式**：
- **默认只写 pending 草稿**（`saveMode = "draft"`），待用户在知识库确认通道确认后才入库；
  同一会话重复提交**覆盖同一份草稿**（回执 `reason = draft_overwritten`，首次为 `draft_pending`）。
- `title` / `content` 为空、或超长度上限 → 返回错误文本，不入库。
- 未找到 knowledge.db（默认 `~/.sati/knowledge/knowledge.db`，可用 `SATI_KNOWLEDGE_DB` 指定）：
  `checkAvailability` 返回 `setup_required`；运行期返回「未找到 knowledge.db，无法沉淀笔记」错误
  （`metadata.error = knowledge_db_not_found`）。
- 写入失败 → 返回「笔记保存失败：<原因>」并置 `metadata.error = knowledge_note_save_failed`。
- 写盘工具（`isReadOnly: false`），非并发安全（`isConcurrencySafe: false`）。

**口径与依据**：
- **只写 personal_note 文档层，不改核心只读数据**（判例 / 法规 / wiki 卡片等只读层不动）。
- 直接落库模式（`saveMode = "insert"`）会做幂等去重：重复内容返回 `reason = "duplicate"` 并跳过保存。
- 召回路径：知识库语义检索，以及判例 provider 的 personal_note 叠加路（可经 patent_case_search 等触达）。

**边界**：只沉淀笔记，不做检索、不做质量评估、不改写内容；入库需人工确认。

---

## patent_eval

**用途**：对专利相关产出打分，并给出通过 / 失败判定。

**关键入参**：
- `mode`：`report`（分析报告质量）/ `retrieval`（检索覆盖度）/ `workflow`（流程完整性）/
  `citations`（引用合规性）/ `comprehensive`（全面评估）。
- `content`：待评估的内容文本（报告正文 / 检索关键词列表 / 工作流步骤 / 引文列表等）。
- `required_citations`：要求必须包含的法条引用列表（如 `["第二十二条第二款", "第二十二条第三款"]`）。

**硬约束与失败模式**：
- 综合通过线 `PASS_LINE = 0.7`（单模式取各维度均分）。
- 子维度通过线：结构完整性 0.6、表达质量 0.6、内容充分性 0.5、关键词覆盖 0.5、
  流程完整性 0.6、引用合规性 0.7、引用格式 0.5。
- 空内容 → 结构完整性 0 分，整体不通过。
- `comprehensive` 为加权综合：结构完整性 0.15 / 表达质量 0.1 / 内容充分性 0.15 /
  关键词覆盖 0.2 / 流程完整性 0.15 / 引用合规性 0.15 / 引用格式 0.1。
- 只读工具（`isReadOnly: true`）：不写盘，不改内容。

**口径与依据**：
- `report` = 章节覆盖 + AI 套话 + 内容充分性；`retrieval` = 关键词覆盖；
  `workflow` = 步骤完整性；`citations` = 法条引用合规性与格式；`comprehensive` = 上述加权综合。
- 表达质量扣分：结构缺陷每处 −0.05（上限 −0.25）、绝对化表述每处 −0.05（上限 −0.25），
  与 quality-gate 的 `ABSOLUTE_PHRASES` 同源。
- 内容充分性按字符数分级（< 50 → 0.1；< 200 → 0.3；< 500 → 0.5；< 1000 → 0.7），再按段落数微调。
- 使用时机：**在提交人工复核前**调用，可提前发现质量问题。

**边界**：只做形式与质量自检，不给法律结论；不修改被评内容，修订由调用方执行。

---

## draft_claims

**用途**：按技术交底书或技术方案生成**权利要求书草案** + 形式校验报告。

**关键入参**：
- `invention_name`：发明名称。
- `tech_domain`：`mechanical` / `electrical` / `chemical` / `software` / `general`；
  为空（或 `general`）时按名称与特征自动识别。
- `patent_type`：`invention`（默认）/ `utility_model`。
- `technical_features`：必要技术特征列表（用于独立权利要求）。
- `optional_features`：附加 / 可选技术特征列表（用于从属权利要求）。
- `shared_features`：与最接近现有技术**共有的结构化**技术特征（置于独立权利要求前序部分）；
  优先于 `prior_art`。
- `prior_art`：最接近现有技术的自由文本描述——**仅生成提示，不写入权利要求**；
  结构化共有特征请用 `shared_features`。

**硬约束与失败模式**：
- 发明名称 > 25 字 → warning。
- 未提供必要技术特征 → warning（独立权利要求无法生成完整技术方案）。
- 名称为空或仅含量词前缀 → warning（按原样保留）。
- 形式校验 5 条规则（结果进 `violations`）：
  `numbering`（error，编号须 1, 2, 3… 连续）、`period`（error，权要须以「。」结尾）、
  `clarity`（warning，模糊限定词：约 / 大致 / 可能 / 优选 / 例如 / 大约 / 左右）、
  `no_illustration`（error，权要中不得出现「如图…所示」「如附图」）、
  `circular_reference`（error，从属权要只能引用编号更小的权要）。
- 只读工具（`isReadOnly: true`）：不写盘。

**口径与依据**：
- 权要结构按领域模板生成（前序头 + 引导词「其特征在于」+ 特征部分）；有共有特征时改用「还」区分区别特征。
- 领域自动识别关键词：`chemical`（组分 / 化合物 / 合成 / 催化剂 / 溶液 / 材料组合物 / 重量份）、
  `software`（步骤 / 算法 / 数据 / 模块 / 接口 / 处理器执行 / 电子设备 / 程序 / 计算机 / 方法）、
  `electrical`（电路 / 电源 / 信号 / 传感器 / 控制器 / 芯片 / 电压）、
  `mechanical`（壳体 / 齿轮 / 轴承 / 支架 / 轴 / 弹簧 / 连接件 / 传动 / 装置 / 设备 / 机构 / 结构）。
- 发明名称归一化：剥离开头的「一种 / 一件 / 一款 / 一项」（可重复前缀），输出不含量词前缀的裸名称，
  权利要求与说明书在模板里统一补回「一种」。

**边界**：只生成草案与形式校验，**不判断**新颖性 / 创造性 / 支持性，也不产出可直接递交的定稿；
须经代理师复核。

---

## draft_specification

**用途**：按技术交底书或技术方案生成**专利说明书草案**（五部分）。

**关键入参**：
- `title`：发明名称（不超过 25 字）。
- `tech_domain`：`mechanical` / `electrical` / `chemical` / `software` / `general`；为空时自动识别。
- `patent_type`：`invention`（默认）/ `utility_model`。
- `technical_problem` / `technical_solution` / `beneficial_effects` / `background`：可选；
  缺省时该节输出「【撰写指引】」占位文本（`placeholder: true`），**不是成稿**。
- `drawing_descriptions`：附图说明（可选）；未显式给图号时按顺序自动编成「图N为…」。
- `embodiments`：具体实施方式（可选，可多个实施例）。
- `has_drawings`：是否有附图（实用新型必须有附图）。

**硬约束与失败模式**：
- 缺用户输入 → 该节是**占位指引**（`placeholder: true`），不是成稿。
- 发明名称 > 25 字 → warning；名称为空或仅含量词前缀 → warning（按原样保留）。
- `patent_type = utility_model` 且未声明 `has_drawings` → warning「实用新型必须有附图，请确认补充附图」。
- 附图说明由附图智能分析自动生成时 → warning「附图说明由附图智能分析自动生成，请人工核对附图标记与图面一致」。
- 只读工具（`isReadOnly: true`）：不写盘。

**口径与依据**：
- 五部分固定顺序：技术领域 / 背景技术 / 发明内容 / 附图说明 / 具体实施方式。
- 技术领域句式：「本发明涉及{机械|电学|化学|软件}技术领域，尤其涉及一种{名称}。」
- 具体实施方式指引覆盖四点：① 操作步骤 / 参数 / 条件记载完整；② 数值范围给出端点值和至少一个中间值；
  ③ 有益效果有定量效果数据；④ 有与最接近现有技术的对比实验数据（创造性判断的关键支撑）。
- 使用时机：用户要求撰写说明书 / 写专利申请文件时调用，避免自行手写说明书文本。

**边界**：只组装草案，**不做**充分公开 / 创造性判断，也不保证可直接递交；
须经 `validate_specification` 校验并人工修订。

---

## search_patent_figure

**用途**：检索已分析过的专利附图及其分析结果（供撰写说明书 / 具体实施方式时对位技术特征与标记）。

**关键入参**：
- `query`：检索关键词（技术特征 / 部件名 / 附图标记）；**空串 = 按附图编号列出全部已分析附图**。
- `limit`：返回条数上限，默认 5，最大 10（实际取 `clamp(limit, 1, 10)`）。

**硬约束与失败模式**：
- 索引文件 `.sati/figures-index.json` 由 `analyze_patent_figure` 分析时自动写入；
  本工具**只读索引**，不写盘。
- **索引为空 → 返回 hint「附图索引为空：请先调用 analyze_patent_figure 分析附图」**，不是错误。
- 关键词无命中但有向量召回时，返回 `method = vector` 并附 `note` 说明；
  两者都无命中 → hint 提示更换关键词或先分析更多附图。
- 读索引失败 → `tool_execution_failed`（「读取附图索引失败：<原因>」）。
- 只读工具（`isReadOnly: true`）。

**口径与依据**：
- 检索方式：配置 embedding 端点后支持向量 / 语义相似度，未配置则仅关键词检索
  （本地 / 云端均可用）；`method` 字段标注实际使用的检索方式，`indexedCount` 标注已索引附图数。
- 返回项含：附图编号、附图类型、图片路径、组件与标号、附图说明、`usable`、`warnings`。

**边界**：只检索**已分析过**的附图（不现场分析图片）；不做附图与文本的语义判断
（图文一致性校验在 `validate_specification`）。

---

## analyze_patent_figure

**用途**：分析专利说明书附图，识别附图类型、提取组件与连接关系、核对附图标记，
并生成专利格式的附图说明文字。

**关键入参**：
- `image_path`：附图图片路径（工作区相对或绝对），支持 jpg/png/gif/webp。
- `figure_number`：附图编号，默认 1（用于附图说明「图N」）。
- `claim_context`：权利要求或技术方案文本（图文对齐，可显著提高组件识别准确率）。
- `invention_name`：发明名称（用于附图说明模板句，如「一种供热管道电位采集装置」）。

**硬约束与失败模式**：
- 需要**多模态视觉模型**：未注入模型客户端 → 返回「未注入模型客户端」错误；
  模型显式声明不含 image 能力时**提前拒绝**（模态门禁，fail-loud 优先于静默降级）：
  「当前模型不支持图片输入」错误（`metadata.error = model_cannot_accept_image`）。
- 图片字节预算默认 5 MiB；路径必须存在（`mustExist`），否则 `invalid_tool_input`。
- 分析结果**自动写入附图索引** `.sati/figures-index.json`（供 `search_patent_figure` 检索）；
  索引为可选增强，**写入失败静默降级**，不阻断分析结果返回。
- **plan 只读模式不写盘**（plan 模式对只读工具自动放行，索引写入会静默绕过只读约束，故显式门控）。
- 只读工具（`isReadOnly: true`）。

**口径与依据**：
- 附图类型枚举：`structure` = 结构图、`flowchart` = 流程图、`circuit` = 电路图、
  `block_diagram` = 方框图、`schematic` = 示意图、`exploded_view` = 分解图、
  `cross_section` = 剖视图。
- 默认 provider `moonshot` / model `kimi-k3`；电路图 / 原理示意图额外触发电学符号级深度分析
  （Step3，失败不回归前两步）。
- 产出的 `components`（组件名 + 附图标记号）用于图文一致性校验与说明书撰写。

**边界**：只做图面识别与附图说明生成，**不判断**技术方案是否成立，也不自动写入说明书；
附图标记须人工核对。
