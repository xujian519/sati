# 制图族工具契约（patent_figure_*）

> 本分片是 **patent 域「制图族」6 个工具的契约档案**：用途、关键入参、硬约束与失败模式、
> 口径与依据、边界。
>
> 工具 `description` 里只留「做什么 + 硬约束 + 失败模式 + 只读性」四件决策必需的最小信息，
> 其余口径全部下沉到这里。**本文件是契约的事实源**：工具描述改短了，细节还在这里；
> 引用规则前先查本文件，再回 `../cn-drawing-rules.md`（细则/指南原文与溯源锚）、
> `../pct-drawing-rules.md`、`../uspto-drawing-rules.md` 核对。
>
> 规则目录（V1–V22 / RC0–RC9 / DR* / C1–C16 的逐条定义）见技能根
> [SKILL.md](../../SKILL.md) 与 `src/patent/figuregen/check-rules.ts`、
> `render-check-rules.ts`、`cad/checks.ts`。

## 族谱总览

| 工具 | 做什么 | 只读？ | 主要失败形态 |
|---|---|---|---|
| `patent_figure_generate` | FigureSpec → 黑白线条附图 SVG | 否（写盘） | 渲染器/图型不兼容 ⇒ **落盘前整体 fail-loud** |
| `patent_figure_check` | 附图合规核验（结构/像素/渲染/交付面） | 是 | 缺入参 ⇒ `invalid_tool_input`；发现分级 fail/warn |
| `patent_figure_project` | STEP/3D → 专利式结构图（FreeCAD 投影） | 否（写盘） | 缺 FreeCAD ⇒ **fail closed 不出图**；标号放不下 ⇒ 不出图 |
| `patent_figure_annotate` | 给已交付 SVG 追加附图标记 | 否（写盘） | 目标文本找不到 ⇒ `unmatched`、`ok=false` |
| `patent_figure_compare` | 声明标记 ↔ 识图标记 双向对账 | 是 | 两侧都空 ⇒ 报错（**零比对不是通过**） |
| `patent_figure_manifest` | 交付物清单登记/核验（sha256+size+mtime） | 是（两模式都不写盘） | 清单未登记/读不到 ⇒ `ok=false`（**未核验不判通过**） |

⚠️ 族内**不做**实质结论：权利要求布局、保护范围解释、新颖性/创造性判断不在制图族职责内。

---

## patent_figure_generate

**用途**：把结构化 FigureSpec 渲染成专利式附图（确定性黑白线条 SVG）。图型覆盖
`flowchart`（方法流程图）、`block`（结构框图）、`state`（状态转移图）、`hierarchy`（层级结构图）、
`chart`（曲线图）、`sequence`（时序图）、`circuit`（电路图）、`cross-section`（剖视图），
以及 `panels` 多面板（FIG.1A/1B）。同 spec 逐字节可复现（确定性渲染）。
附图标记以 **data-ref 内嵌**（不写死可见文本），因此 `patent_figure_check` 的 `svg_paths`
回读通路可拿到图号与标记。

**关键入参**：

- `figures`（FigureSpec 列表，1..N）：单幅 `nodes + edges ≤ 200`（`STRUCTURAL_MAX_ITEMS`，
  超限在入参处拒绝——再大任何自动布局都会把字压到不合法）。
- `output_name`（产物文件名主干）+ `output_dir`（显式目录优先，其次案卷目录，缺省 `.sati/figures/`）。
- `jurisdiction`（`cn` / `us` / `pct`）：决定**纸面常数、图号体例、字高下限**（法域档案
  `src/patent/figuregen/office-profile.ts`，每个数值注明条文出处）。
- `document_kind`（`invention` / `utility`）：实用新型须有表示形状/构造的附图（V9，fail）。
- `figure_count`（本案附图总幅数）：**图号义务与纸面判据的输入**——单幅在 pct/us 不得编号
  （V16）；分次生成或只核验其中一幅时**必须显式声明**，否则只能按本次调用推断。
- `sheet_index` / `sheet_total`（附图页页码声明）：**须成对给出**，缺任一则不生效（V17）。
- `fit_to_page`：另出 A4 落版页 `<name>-figN-page.svg`（图形落版到版心、页码在版心上沿，
  图号仍画在图形下方）。
- `format`（`svg` / `html` / `both`）：`html|both` 另出 A4 打印版式 HTML。
- `brief`：**附图说明草稿开关**——缺省在报告文本里给出「附图说明草稿（可直接并入说明书）」段落；
  `brief: false` 关闭。
- `invention_name`：写入附图说明草稿（US 法域出英文 `BRIEF DESCRIPTION OF THE DRAWINGS`）。
- `auto_numbering`（自动发附图标记）：**per-call 优先于 env**，env `SATI_FIGURE_AUTO_NUMBERING`
  **缺省 off**（部署级开关）。
- `numeral_start`（缺省 `100 + 100×(图序−1)`）/ `numeral_step`（缺省 2）/ `reserved`
  （跳过预留标号，如 `"100"`）。
- `figure_family`（本次各图**共享一个标号系列**，如 FIG.1A/1B）：部分视图必须共用号段，
  否则同一部件在两幅图里是两个号。
- `submission`（落版参数）：`rotate_deg`（0/90/180/270）、`caption_font_mm`、
  `caption_gap_mm`、`sheet_font_mm`；per-call 覆盖 env。
- `case_id`（案卷号，决定缺省输出目录）。

**硬约束与失败模式**：

- **渲染器画不出的图型 ⇒ 整体 fail-loud（且在落盘前整体拒绝，不留半成品目录）**：
  `chart`（坐标轴与数据曲线）、`sequence`（生命线与消息时序）、`circuit`（电路元件符号）、
  `panels`（面板网格）、`section`（剖面轮廓与剖面线）**只能由内置渲染器绘制**。
  处置：去掉 `SATI_FIGURE_RENDERER` 或设为 `builtin`。
- `SATI_FIGURE_RENDERER=graphviz` 但本机找不到 dot ⇒ `setup_required`（装 graphviz 或用
  `SATI_GRAPHVIZ_DOT` 指定）；`graphviz-wasm` 首次渲染时 WASM 加载失败同样 fail-loud，
  **绝不静默回退内置渲染器**（静默回退会让"要 graphviz 布局"的意图被悄悄违背）。
- 非法 `format` / 非法渲染器值 / 非法落版参数 / 非法图幅参数 ⇒ `invalid_tool_input`，
  且**校验集中在落盘之前**（否则会先写出一个半成品输出目录再抛错）。
- 字体转路径开关 `SATI_FIGURE_TEXT_TO_PATH` 开启却没有 Inkscape ⇒ **先探测后落盘**的
  fail-loud（否则会留下"图已落盘但没转路径"的半成品目录）。
- **生成期核验只覆盖结构规则 V1/V4/V5/V7/V8/V9 与图面用语 V12–V14**；**V2/V3 需要说明书
  文本，生成期不参与** ⇒ 以 `patent_figure_check` 的结论为准。
- 自动发号：per-call `auto_numbering` 优先于 env；env 缺省 off。`figure_family` 给空串 ⇒
  `invalid_tool_input`。
- 入参级结构校验：非曲线图 `nodes` 不得为空；曲线图须有 `chart`、≥1 条曲线、每条 ≥1 个
  数据点、每点 `[x, y]` 两个有限数、两轴都有非空标目。
- 附图索引写入失败**降级但不静默**：`indexed=false` 且报告写明「未入索引」及原因。
- 产物：`<name>-figN.svg` + sidecar `<name>-figures.json` + 可选 A4 打印 HTML（`format`）
  + 可选落版页（`fit_to_page`）。

**口径与依据**：

- 黑白线条、白底、无渐变 —— 审查指南一部一章 **4.3**（线条均匀清晰、足够深、黑色墨水；
  ⚠️ 现行 4.3 文本并未禁止彩色，渲染器黑白是产品选择而非该条强制）与 **4.6**（公布时印制
  质量：文字与线条黑色、足够深、背景干净）。
- 缩小到三分之二仍能分辨（V7 字高/画幅判据）—— 指南一部一章 **4.3**。
- 图号体例：CN「图N」；PCT/US「Fig. N」；**单幅在 pct/us 不编号** —— 指南一部一章 4.3
  「附图总数在两幅以上……应当编号」＋ PCT 指南 IP 5.141 / 37 CFR 1.84(u)(1)。
- 附图标记双向核对（V2 图→文、V3 文→图、V4 标记一致）—— **细则第 21 条**。
- 摘要附图指定（V8）—— 指南一部一章 **4.5.2**。
- 实用新型须有附图（V9）—— 指南一部二章 7.3 ＋ **细则第 20 条第 5 款**。
- 剖面线语义（细实线、45°/135° 交替、相邻零件方向相反或间距不等）—— **GB/T 4457.5**
  《机械制图 剖面区域的表示法》。
- 附图说明草稿并入说明书七部分之第（四）部分 —— **细则第 20 条**。

**边界**：不产出彩色附图模式、不产出照片/扫描件/工程蓝图；附图说明只是**草稿**，正式提交前
仍须由代理师按最终申请格式复核；曲线图不能配 graphviz 通路；不做实质结论。

---

## patent_figure_check

**用途**：附图合规核验（CNIPA / PCT / USPTO），四条通路合并判定：
①结构规则 **V1–V22**；②栅格**像素门禁**（黑白、线宽、DPI、纸面尺寸）；③**已交付 SVG 渲染
复核 RC0–RC9**（在 SVG 源上量测几何事实：画布尺寸、文字数、实测最小字高、线宽分布、取向
分布、图文关系）；④**交付面复核 DR 族**（位图/照片、横向摆放、整幅框线、图面用语 V12–V14）
＋ **DR4 交付物清单核验**。可只核验结构化 spec，也可核验已交付 SVG / 第三方图片。

**关键入参**：

- `spec_text`（**必填**）：说明书文本（权利要求 + 说明书），V2/V3 用。
- `figures`（FigureSpec，契约同 `patent_figure_generate`）：结构规则的对象。
- `svg_paths`（已交付 SVG 路径）：回读 data-ref 拿图号/标记，并跑 RC 渲染复核 + 交付面复核。
- `image_paths`（栅格附图路径）：像素门禁的对象，**不做 OCR**。
- `claims_text` / `description_text`（可选）：显式分面，替代启发式分节，使 V10/V11 不再依赖
  小节标题（调用方通常已知道分界）。
- `document_kind`（V9：实用新型须附图）、`jurisdiction`（法域档案）、`figure_count`
  （图号义务判据）、`sheet_index`/`sheet_total`（成对给出，V17）。
- `hierarchy`（声明的父→子标记边，RC8）：与权利要求/说明书里的归属表述对拍，**只 warn 不阻断**。

**硬约束与失败模式**：

- `figures` / `svg_paths` / `image_paths` **至少给一项**，否则 `invalid_tool_input`。
- **`ok` 是各通路 fail 的合并判定**：结构规则 ∧ 像素门禁 ∧ 渲染复核 ∧ 交付面复核 ∧ 交付物
  清单核验，任一通路有 fail ⇒ `ok=false`。warn 不影响 `ok`。
- **未提供的通路不参与判定，也不阻断 `ok`**——因此 `ok=true` 只覆盖**实际跑过**的通路；
  报告文本逐项写明「未核验/本次不适用」（例：只给栅格图时结构规则整节不适用）。
  ⚠️ 不得把「没量测」呈现成「已核验通过」。
- 只有栅格图、无 FigureSpec 时跳过结构规则，只跑像素门禁（已如实声明）。
- `svg_paths` 回读的骨架没有 nodes/chart 载荷 ⇒ 结构性校验只针对调用方给出的结构化
  `figures`；回读骨架逐图排除出 V7 画幅判据（结构化 figures 与 svg_paths 混给时前者照判）。
- **V3（文→图）是保守 WARN**：说明书里的数字未必是附图标记，须人工确认。
- **V19（实用新型附图全为曲线图）只在一次提交全部附图时才判**；分次核验时无法判定。
- RC1（文字被线贯穿）、RC5（内容越出画布）、DR 族 fail 与结构规则 **同权**，不得只躺在
  报告里。
- 图面用语 V13/V14 仅对 cn 判定；括号形态（CN 惯用「名称(标记)」）在 pct/us 会被报出。
- ≥2 幅时额外产出多图一致性结论（`multi_figure_consistency`）。

**口径与依据**：

- 细则第 **21 条**（图号顺序编号、图↔文标记双向、同一组成部分标记一致）—— V1/V2/V3/V4；
  第 21 条第 3 款「附图中除必需的词语外，不应当含有其他注释」—— V5/V12。
- 指南一部一章 **4.3**（缩小三分之二可辨 V7；多幅须编号 V15；单幅带号 V16〔仅 pct/us〕；
  图面用语 V12/V13/V14；页码声明 V17）＋ **4.5.2**（摘要附图 V8）＋ **4.6**（印制质量）。
- 指南一部二章 **7.3** ＋ **细则第 20 条第 5 款** —— V9（实用新型必须有附图）。
- **细则第 22 条** —— V10（权利要求面附图标记须置于括号内）、V11（说明书正文括号引用标记）。
- PCT 指南 IP 5.141 / **37 CFR 1.84(u)(1)** —— V16（单幅不编号）；PCT Rule 11.13(e) /
  **37 CFR 1.84(p)(1)** —— 括号形态禁则（V14）。
- **GB/T 4457.5** —— 剖面线方向/间距判据（RC 族）。
- V18/V20/V21/V22 依据的是**渲染契约与数据健全性**（非条文）：符号形状节点含字、两条曲线
  无从分辨、数据点越轴、标记非正整数。

**边界**：只核验、不改图、不改 spec；核验结论是**形式合规**判断，不含实质（创造性/清楚性）
评价；照片/扫描件只能分析不能由本工具生成。

---

## patent_figure_project

**用途**：把 STEP / 3D 模型投影成专利式结构图（黑白 SVG、隐藏线消除、正交投影），由本机
**headless FreeCAD** 渲染；同时出 sidecar（FigureSpec + 生成期核验）与结构图 manifest
（视图 / 零件几何事实 / 件号归属）。

**关键入参**：

- `step_path`（STEP 文件路径）、`output_name`、`output_dir`、`case_id`。
- `view`（`front`/`back`/`left`/`right`/`top`/`bottom`/`iso`，iso = 轴测）、`views`（一次投影
  多个视图；per-call 覆盖 env）。
- `section_offset_mm`（剖切面偏移，模型 mm）：**仅正交视图**生效，给出即产出全剖视图。
- `annotations`（附图标记锚点）：`ref`（标记号）+ `at_mm`（锚点 `[x,y,z]`，模型 mm）+
  可选 `label_offset_mm`（标号偏移 `[dx,dy]`，mm）。
- `hidden_lines`（画隐藏线，缺省 false）、`tolerance_mm`（投影容差，缺省 0.5）。
- `jurisdiction`、`document_kind`（写入 sidecar 的 V9 口径）、`figure_count`、
  `sheet_index`/`sheet_total`、`fit_to_page`（另出打印落版页）、`submission`（落版参数）。

**硬约束与失败模式**：

- **缺 FreeCAD ⇒ fail closed（不出图、不写产物）**：报 `setup_required`；可用 `SATI_FREECAD_CMD`
  指定可执行来源，否则按平台候选探测；探不到即报错，**不静默回退其它渲染器**（CAD 图只能由
  几何投影得到）。
- 非法 `view` / `views` 项 ⇒ `invalid_tool_input`（**与部署配置错误 `setup_required` 分开报**）。
- **CAD 通路是 strict：标号择位候选耗尽 ⇒ 不出图**，工具报 **C13**。处置：减少同图标注的
  标记、把本图拆成多幅，或对放不下的标记显式给 `label_offset_mm` 钉死一个可接受的偏移。
  ⚠️ 不要指望就地标号——那是示意图通路的 degrade 兜底，结构图上会把标号压在零件上。
- **一般不要给 `label_offset_mm`**：钉死偏移会跳过择位与规避，只做事后体检（可能报 C10
  「标记线与主线条分不清」或 C9「标号越出图幅」）；只有标号位置有硬性要求时才显式指定。
- 落版参数与图幅参数非法 ⇒ **在落盘前**报错（不留半成品目录）。
- 几何级发现 **C1–C16** 随产物返回（`geometry_findings`），如 C9/C10/C12/C16。

**口径与依据**：

- **GB/T 4457.5**《机械制图 剖面区域的表示法》—— 剖面线细实线、45°/135° 交替、相邻零件
  方向相反或间距不等（C16）；引线自轮廓向外引出、不横穿零件面（引线形态）。
- 指南一部一章 **4.3** —— 线条均匀清晰、足够深、不得涂改；不得有与图无关的框线。
- 指南一部一章 **4.6** —— 线条（轮廓线、点划线、剖面线、中心线、标引线）清晰可辨、黑色。
- **细则第 21 条** —— 附图标记（`annotations` 的 `ref`）须与说明书文字部分一致。
- 法域纸面常数（标号字号 CNIPA 3mm、PCT/US 3.5mm；引线止于标号字框外缘并留 1.5mm 间隙）
  取自法域档案 `office-profile.ts`。

**边界**：只出**结构图**，不做实质结论；一步一视图（多视图用 `views` 或多次调用）；
CAD 通路 strict 不 degrade；剖视仅正交视图。

---

## patent_figure_annotate

**用途**：向**已交付的 SVG** 追加专利附图标记（可见标记形如「处理模块(20)」），并把图面上
可见的标记与**登记集合**（本次请求的标记）双向对账：已写入 / 原本就有 / 未命中 / 集合外。

**关键入参**：

- `svg_path`（待标注 SVG；相对路径按工作区 cwd 解析）。
- `references`（≥1）：`ref` = 要写的标记号（**1..999**），写成 `(ref)` 形态；
  `label` = 在图面上定位的**可见文本**（子串匹配、大小写不敏感；缺省 `"(ref)"`）。
- `output_path`：产物路径，缺省 `<stem>-annotated.svg`（与输入 SVG 同目录）。
- `dry_run`：只算不写（缺省 false）。

**硬约束与失败模式**：

- **目标文本找不到 ⇒ 该标记进 `unmatched`（不写），且 `ok=false`**——「没标上」不判成功。
  `ok` 的口径是：每个请求标记都落到图面（本次写入，或图面原本已有）才为 true。
- **图面上出现但不在登记集合内的标记**（`validation.unknown`）**只如实报出，不阻断 `ok`**
  （它不是本次请求的失败，而是图面与登记集的差异）。
- 输入 SVG 未通过 SVG 安全门 ⇒ `invalid_tool_input`（带安全门错误码与路径）；写入失败 ⇒
  `tool_execution_failed`。
- `dry_run=true` 时不写任何文件（`annotated_path` 为空串）。

**口径与依据**：

- **细则第 21 条** —— 附图中未出现的标记不得在说明书文字部分中提及、同一组成部分标记须一致；
  本工具的「登记集合 ↔ 图面可见标记」对账即服务于该条。
- 指南一部一章 **4.3** —— 「附图标记应当使用阿拉伯数字编号」（故 `ref` 限 1..999 整数）。
- **CN 惯用形**「名称(标记)」；**PCT/US 不得用括号**（PCT Rule 11.13(e)、
  37 CFR 1.84(p)(1)：「Brackets … must not be used in association with numbers and letters」）
  ⇒ pct/us 下应写「处理模块 20」或「处理模块20」。

**边界**：只追加标记、不改图形几何（不重排、不缩放）；不改附图内容本身（文字/注释层面）；
不含合规判定（合规判定走 `patent_figure_check`）。

---

## patent_figure_compare

**用途**：把**生成期声明的附图标记**与**图面识别出的标记**双向对账：缺标记、多标记、
同号异名、同号异类型四类不一致。

**关键入参**：

- `declared`（声明侧，逐幅清单）：生成期声明的标记。
- `analysis`（识图侧，逐幅清单）：图面识别结果（如 `analyze_patent_figure` 的产出）。
- 两侧同构：每条 = `figure_no`（附图号，同号两侧互比）+ `refs`（数字标记，**1..999**）+
  可选 `names` / `types`（与 `refs` **按位对应**、等长）；`types` 取值域见
  `FIGURE_COMPONENT_KINDS`。

**硬约束与失败模式**：

- **两侧都空 ⇒ 报错**（`invalid_tool_input`）：零比对**不是「通过」，是未核验**。
- **四类发现任一出现 ⇒ `ok=false`**（四类统一记 `severity=fail`）：
  缺标记（声明有、图面无）、多标记（图面有、声明无）、同号异名、同号异类型。
- 逐幅给计数与结论（`figures[]`），跨幅汇总 `declared_count` / `analysis_count` /
  `figure_count`（两侧图号的并集）。
- **字母前缀标记（S101/U1）不在本工具范围内**（只比对纯数字标记）。

**口径与依据**：

- **细则第 21 条** —— 「附图中未出现的附图标记不得在说明书文字部分中提及，附图中未出现的
  附图标记…申请文件中表示同一组成部分的附图标记应当一致」⇒ 缺/多/异名/异型四类不一致的
  判据源头。
- 指南一部一章 **4.3** —— 「附图标记应当使用阿拉伯数字编号」⇒ `refs` 限 1..999 整数、
  字母前缀标记不在范围。

**边界**：只做两侧标记的一致性对账，**不做**图像识别（识图由 `analyze_patent_figure` 等分析
通路提供）、不做合规判定、不改任何文件。

---

## patent_figure_manifest

**用途**：登记并核验**附图交付物清单**——每个交付物的 `sha256` / 字节数 / `mtimeMs`，
用于「交出去的就是登记的那一份」的交付溯源。

**关键入参**：

- **定位三选一（互斥，必须且只能给一种）**：
  `sidecar_path`（`<name>-figures.json` sidecar，其 `deliverables` 字段即清单）/
  `output_dir` + `output_name`（成对给出；主干对应的产物全集）/ `files`（点名子集）。
- `mode`：`build` = 从磁盘文件装配清单；`check`（**缺省**）= 把登记清单与当前文件比对。
  ⚠️ **两种模式都只读盘不写盘**（清单只在返回值里）。

**硬约束与失败模式**：

- **定位三选一互斥**：一个都不给 ⇒ `invalid_tool_input`（"三选一给出交付物集合"）；给了两种以上
  ⇒ `invalid_tool_input`（否则「比的是什么」不确定，宁可报错也不猜）。
- `output_dir` 与 `output_name` 必须成对；空串 ⇒ `invalid_tool_input`；`files` 不得为空数组。
- **`checked` 是诚实三态，缺一不可**：
  `verified`（确实比对过）/ `not-registered`（清单未登记，**没核验**）/ `unavailable`（读不到，
  **没核验**）。后两态 **`ok=false`**——**未核验不判通过**（`note` 里写明「本次未核验」及原因）。
- `check` 模式的发现类别：`file-missing` / `hash-mismatch` / `size-mismatch` /
  `stale-output` / `not-in-manifest`；级别 `fail`（不可交付）/ `warn`（可疑未证伪）。
- `mode` 非法值 ⇒ `invalid_tool_input`。

**口径与依据**：

- 工程交付口径（非法条）：sha256 + 字节数 + 落盘时刻三元组，用于证明「交出的文件与登记的那份
  是同一份」，对应附图交付面复核 **DR4**（`patent_figure_check` 走同一通路，fail 级与其它
  fail 同权）。
- 附图本体合规依据见本文件 `patent_figure_check` 节与 `../cn-drawing-rules.md`。

**边界**：只做交付物**存在性与内容一致性**的核验，**不判定附图是否合规**（那是
`patent_figure_check` 的事）；不写盘、不改产物、不登记到外部系统。
