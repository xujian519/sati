# 专利制图对齐 deepseek-harness（2026-11 现状复核与剩余差距）

> 调研日期：2026-11-12
> 对照仓：`/Users/xujian/projects/deepseek-harness`（`packages/patent/patent-tools` 为主，兼看 `patent-filing` / `patent-document`）
> 本仓：`src/patent/figuregen/`、`src/patent/figure/`、`src/tool/builtin/patentFigure*.ts`、`src/patent/document/docx/`、`src/patent/atoms/handlers/builtin/figure.ts`
> 方法：两侧源码逐模块阅读 + 本仓既有决策记录（`docs/notes/implemented/*figure*`）与既有两轮对齐方案（`docs/patent-figure-harness-parity-plan.md`、`docs/research/patent-figure-dsh-delta-2026-10.md`）的时间线对齐；结论均带路径证据。
> **本文只做差异复核与路线图，不改代码。**

---

## 0. 结论摘要

1. **Sati 与 DSH-patent 的制图能力已不是「同一代差」，而是「同一底座 + 不同侧重」。**
   渲染底座（字形盒 `glyph-box`、SVG 视口 `svg-viewport`、引线择位 `leader-line`、法域档案 `office-profile`、文字转路径 `inkscape-renderer`、渲染复核扫描 `render-check-scan`）两边是**逐常量同源的等价移植**，Sati 在其中若干处（引线择位评分、Inkscape 915 行、图面用语分域）**已经反超**。
   差距已从「渲染地基」整体迁移到 **四类局部缺口**：**图型广度**、**门禁深度**、**交付链断点**、**CAD 结构线稿深度**。

2. **Sati 在四个方向仍然领先 DSH-patent，对齐时不得回退**：
   确定性合规规则族（V1–V22 + RC0–RC7 + PX1–PX4 + C1–C13，规则号可机读）、`figure-gate` 工作流门禁（fail 挂 HITL + 人工强制放行留痕）、产物 sidecar 契约与漂移对账（DSH 无）、栅格像素门（DSH 全仓无）。
   **「对齐 DSH」的目标是补 DSH 之所缺，不是拿 DSH 之所有。**

3. **剩余最高优先级的两项是「会被补正通知书打回」的缺陷**（不是能力广度）：
   ① **交付面复核四项缺失**——位图/照片嵌入、横向摆放、整幅框线、图面用语终检（DSH `figure/delivery-review.ts:38-79`；Sati 全仓无对应实现，grep `figure-photo|figure-frame|figure-orientation` 零命中）。
   ② **SVG 附图无法进入申请文件**——Sati 的 docx 只认 PNG/JPEG/GIF/BMP（`src/patent/document/docx/imageInfo.ts:21-103`），矢量附图必须人工先转位图；且成品核验无「每图一页 / 图号与图序一致 / 摘要附图恰 1 张」三项断言（DSH `patent-filing/assets/engine/verify.py:286-317` 有）。

4. **两处「编排链断点」是零成本的真缺口**：生成侧不写附图索引（DSH `generate-patent-figure.ts:306` → `figure-output.ts:47-72`；Sati 全仓只有 `analyzePatentFigure.ts:200` 写 ⇒ **生成物检索不到**，必须多调一次多模态 analyze）；生成输出不含结构化标号映射与落版度量（`numeralMap` / `layout` 只在 DSH 的 output 里，Sati 只在 sidecar 里 ⇒ **模型看不到**）。

5. **对齐路线按三批走，且必须尊重本仓的两条硬约束**：改任一工具 `inputSchema`（含描述文本）或新增/删除工具 ⇒ llm-replay fixture 失配须重录（AGENTS 第 6 条）；新增任何 `.ts` ⇒ `pnpm measure:update` 后基线变化（`docs/technical-debt/metrics.md`）。

---

## 1. 「对齐」的口径（先定边界，再谈差距）

| 类别 | 处理方式 |
|---|---|
| **DSH 有、Sati 缺，且直接决定「会不会被补正/驳回」** | 必补（批次 A） |
| **DSH 有、Sati 缺，属于「出图能力广度」**（图型/面板/补标号） | 分批补（批次 B），每批一次重录 |
| **DSH 有、Sati 缺，属于「3D 深水区」**（CAD 结构线稿深度） | 单独立项，需 FreeCAD 实机验收（批次 C） |
| **Sati 已领先 DSH** | **不回退**：规则编号化、门禁 HITL、sidecar 契约、像素门、语义检索、domain 裁剪 |
| **DSH 侧已被本仓证伪的做法** | **不照抄**（见 §6） |

> 本仓此前两轮对齐（2026-09-22 合规侧 PR-A..D、2026-10-01 批次 A、2026-10-29 P0）已把「合规侧」与「核验侧」补齐。本文是**第三轮**：只列仍然存在的差集，不复述已落地项。

---

## 2. 现状坐标（2026-11 实测）

| 维度 | DSH-patent | Sati |
|---|---|---|
| 制图源码 | `src/figure/` 35 文件 / 14 215 行 + `src/tool/` 制图相关 20 余模块 | `src/patent/figuregen/` 46 文件 / 11 526 行（含 `cad/`）+ `src/patent/figure/` 17 文件 + 工具层 |
| 工具面 | 8 个：`generate_patent_figure` / `generate_structure_figure` / `verify_patent_figure` / `add_patent_figure_references` / `compare_patent_figure_analysis` / `check_patent_figure_consistency` / `analyze_patent_figure` / `search_patent_figure` | 5 个：`patent_figure_generate` / `patent_figure_project` / `patent_figure_check` / `analyze_patent_figure` / `search_patent_figure` |
| 图型 | 12 型（`analyze-patent-figure.ts:41-55`），含 5 型矢量直绘（circuit / plot / cross_section / sequence_diagram / appearance_view） | 5 型：`flowchart` / `block` / `state` / `hierarchy` / `chart`（`figuregen/types.ts:41`）+ 独立 CAD 通路 |
| 规则族 | 无规则号，人读 message | V1–V22 + RC0–RC7 + PX1–PX4 + C1–C13（`check-rules.ts` / `render-check-rules.ts:23-32` / `pixel-gate.ts:30-54` / `cad/checks.ts:41`） |
| 工作流门禁 | 无附图门（只有 `figure-analysis` 收口原子） | `figure-gate` 原子，fail 挂 HITL + 人工放行留痕（`atoms/handlers/builtin/figure.ts:637-652`） |
| 产物契约 | 只有 `.sati/figures-index.json`（分析结果索引） | `<name>-figures.json` sidecar（完整 FigureSpec + 核验快照 + 落版度量）+ 漂移对账（`figuregen/sidecar.ts` / `figure.ts:169-245`） |

> 时间基线：DSH 自 2026-10-01 起又有 21 个提交触碰 `src/figure`（含 11-08 的结构线稿分解图、件号自动锚点、版面利用率判据），本仓 P0 轮（10-29）只覆盖到其中一部分。

---

## 3. 差异矩阵

### 3.1 渲染内核 —— 已基本对齐，差距在「图型广度」与「配置面」

| 维度 | DSH | Sati | 证据 | 影响 |
|---|---|---|---|---|
| 字形盒 | 比例 0.6/0.75/1/0.75/0.12，容差 0.01 | **逐值相同** | DSH `glyph-box.ts:17-31` ≡ Sati `glyph-box.ts:17-34` | 已对齐 |
| 引线择位 | Graphviz SVG **后处理器**（在既有 SVG 上加标号、越界扩画布） | **几何择位引擎**（12 方向 × 4 环距候选 + 评分 + 有界回溯 + `strict/degrade`） | DSH `leader-line.ts:106,511-616`；Sati `leader-line.ts:15-40,176-225` | **两类互补**：Sati 缺「改写既有 SVG」，DSH 缺「择位 + 严格失败语义」 |
| 渲染后端 | dot CLI + viz-wasm + 内置矢量 + Inkscape + FreeCAD；**6 种 graphviz 引擎**；png/pdf 直出 | builtin + dot CLI + viz-wasm + Inkscape（仅转路径）+ FreeCAD；**固定 dot 引擎**；仅 SVG/HTML | DSH `dot-builder.ts:27,36,39`、`render-selector.ts:25-83`；Sati `render-graphviz.ts:68`、`deliverables.ts:39` | Sati 缺 png/pdf 直出、非 dot 引擎、Inkscape 按页导出 |
| WASM 规模护栏 | 按引擎分档（强制导向 20 000 / 分层 64 000 字符） | 单一档 64 000，注释自述「非本仓实测标定」 | DSH `render-selector.ts:41-50`；Sati `render-viz-wasm.ts:38-39` | 大图可能同步阻塞 |
| 落版 | 幅面 + 图号 + 页码 + **旋转 0/90/180/270** + 字号/间距可调 | 幅面 + 图号 + 页码，**无旋转、无可调** | DSH `submission-page.ts:37,215-227`、`generate-patent-figure.ts:534,537-540`；Sati `figuregen/submission-page.ts:29-57` | 横长图形配竖向版心无法落版 |
| 页面契约 | 常数散在 4 处（office/compliance/submission/dot-builder） | **`page-contract.ts` 单一事实源**（V7 / HTML / 像素门 / 落版共用） | Sati `page-contract.ts:1-12` | **Sati 更优** |
| 字号口径 | `fontPt` 直传 DOT，各通路各设一数 | **mm 为唯一部署口径**，px/pt/mm 三通路折算（`SATI_FIGURE_FONT_MM`） | Sati `metrics.ts:11-63`、`source-char-height.ts:13-39` | **Sati 更优** |
| 标号分配 | `assignNumerals`：100 系列 / 步进 / 显式表 / `reserved` / 冲突硬抛 `conflicting_numeral` | **无自动分配**，`FigureNode.ref` 由调用方逐个给 | DSH `dot-builder.ts:201-246`；Sati `figuregen/types.ts:52` | Sati 错号/重号只能在事后 `crossCallReview` 报冲突 |
| 图面用语 | 5 类注释特征，一律全判 | V12/V13/V14 × 9 类 issue × 3 域作用域，**显式声明有意不判三类** | DSH `wording-rules.ts:25-52`；Sati `wording-rules.ts:21-27,36-55` | **Sati 更优**（噪音更小、可辩护） |
| SVG 安全门 | 拒 ENTITY/CDATA + 体积上限，**放行 DOCTYPE** | 拒 DOCTYPE/ENTITY/CDATA + 体积上限 | DSH `svg-annotate.ts:77-90`；Sati `svg-safety.ts:46-59` | **Sati 更严** |
| 曲线图 | 4 种 marker，**无线型** | 9 种 marker + `solid/dashed/dotted` 线型 | DSH `plot-diagram.ts:32`；Sati `types.ts:87-99` | **Sati 更优** |

**图型缺口（明确清单）**：Sati 无法表达 `circuit`（电路图，DSH 749 行含电气符号表 + 正交走线 + 元件名避让）、`sequence_diagram`（时序图，DSH 292 行）、`appearance_view`（外观设计六面视图，DSH 368 行）、`cross_section`（2D 说明书剖视图，DSH 918 行 + `section-source.ts` 512 行）、`exploded_view`（分解图）、`schematic`。

### 3.2 校验门 —— Sati 的规则体系领先，但少三类门

| 门 | DSH | Sati | 结论 |
|---|---|---|---|
| 结构规则 V\* | 有（无规则号，且**只产 warning**） | V1–V22，多数 **fail** 级 | **Sati 更严** |
| 渲染复核 RC\* | 10 类判据 | 8 类（RC0–RC7） | **缺 2 类**：`figure-hierarchy`（RC8 明确预留未落地，`render-check-rules.ts:20-21`）、`sheet-underfill` |
| 复核严重度 | 有 `advisory`（报告但不阻断）+ `blockingFindings` | 只有 fail/warn/info 三级 | DSH 多一档提示级语义 |
| 净距阈值 | **按图型分档**（12 档实测标定，`render-check-findings.ts:115-135`） | 单一 1.5mm | 单一阈值可能把工具自己的正确输出判负 |
| 图元叠压判据 | 包围盒相交即报 | **轮廓实测互相穿过**才报（包围盒仅预筛） | **Sati 更准** |
| 像素门 PX1–PX4 | **无** | 有（黑白性/线宽/DPI/纸面） | **Sati 独有** |
| 交付面复核 | **有 4 项**（位图/横向/整幅框线/措辞） | **无** | **DSH 独有，缺口 #1** |
| 法域合规核算 | `compliance.ts`：色彩策略 / 图号义务 / 字高 / **摘要附图 40×60mm 缩放字高** | 散在 V15/V16/V17 + `minCharHeight()`，**无摘要附图专项** | **DSH 独有** |
| 构造层级 ↔ 权利要求 | `hierarchy-check.ts:87-108` | **无**（RC8 预留） | **DSH 独有** |
| 生成期门禁 | `render-check-gate.ts:46-83`（布尔 strict，默认关） | `SATI_FIGURE_RENDER_GATE` 三档（缺省 warn），**产物先落盘再抛错** | Sati 失败语义更精细 |
| 工作流级附图门 | **无** | `figure-gate` 原子，四族同权阻断 + HITL | **Sati 独有** |
| 交付物 manifest/哈希/时序 | `verify-deliverable.ts:19-90,198-210,324` | 仅 `figure-check.json.inputs_hash` 覆盖附图面 | **DSH 独有** |
| 跨图一致性 | `figure-set-consistency.ts`（缺 `figureFamily` 校验） | `multi-figure-consistency.ts`（含电学网表/孤立网络）+ V1/V4；**缺重复图号判定** | 各有胜负 |

### 3.3 交付链 —— Sati 的产物契约领先，但「入文」一环断着

| 环节 | DSH | Sati |
|---|---|---|
| 单图产物 | `fig<N>.{svg,png,pdf}` | `<name>-fig<N>.svg`（+ `-page.svg` 落版页 + `.html` 打印版式） |
| 落版页定位 | **主产物**（`fit_to_page` 默认 true，原地覆写） | **附加产物**（默认 false，本仓有意为之） |
| sidecar | **无** | 有（零信息损耗重跑 + 漂移对账） |
| **SVG→PNG 栅格化** | `render_figures.py:90-135`（Chrome headless 按 SVG 自身尺寸 ×300 DPI 等效） | **无** |
| 申请文件嵌图 | docx 逐图 `add_picture`（居中 + 显式零缩放 + 每图一页） | docx 嵌图**只认位图**（`docx/imageInfo.ts:21-103`），**SVG 不支持**；取不到图只告警不阻塞（`renderApplicationDocx.ts:96,105-107`） |
| 成品图相关断言 | 每图一页 / 图号文字与图序一致 / 摘要附图恰 1 张（`verify.py:286-317`） | **无**（`verifyApplicationDocx.ts` 只做内容/体例/痕迹三类） |

### 3.4 编排接点 —— 两处断点 + 两处工具面缺口

| 接点 | DSH | Sati | 证据 |
|---|---|---|---|
| **生成 → 索引写入** | 生成即写 `.sati/figures-index.json`（`persist_index` 默认 true） | **不写** ⇒ 生成物检索不到，必须额外调 `analyze_patent_figure` | DSH `generate-patent-figure.ts:306`、`figure-output.ts:47-72`；Sati 全仓仅 `analyzePatentFigure.ts:200` 调 `upsertFigureIndex` |
| **生成 → 结构化标号映射/落版度量** | output 含 `numeralMap` / `components` / `connections` / `layout{pageScale,placedWidthMm,charHeightMm,reducedCharHeightMm}` | output 仅 `{figure_no,path,caption,sheet}`；标号映射与落版度量**只进 sidecar** ⇒ 模型看不到 | DSH `figure-tool-schemas.ts:16-29`、`generate-patent-figure.ts:556-571`；Sati `patentFigureSchema.ts:274-286`（`additionalProperties:false`） |
| **生成 ↔ 识图比对** | `compare_patent_figure_analysis`（`figure-comparison.ts`） | **无工具**（Sati 有 bridge 可复用） | DSH `tool/compare-patent-figure-analysis.ts:53` |
| **既有 SVG → 补标号** | `add_patent_figure_references` + `svg-annotate.ts`（183 行） | **无**（Sati 的 `leader-line.ts` 只服务 CAD 通路） | DSH `tool/add-patent-figure-references.ts:68` |
| **多面板（FIG.1A/1B）** | `figure-panels.ts`，面板共享一条标号系列 | **无**（`figures[]` 是并列多幅，不是面板） | DSH `tool/figure-panels.ts:54` |
| **独立复核入口** | `verify_patent_figure`（独立工具，只报告） | 借 `patent_figure_check` 的 `svg_paths` 分支 | DSH `tool/verify-patent-figure.ts:100` |

### 3.5 CAD 结构线稿 —— 架构替代，缺四个增量

Sati 的 `cad/` 是**真实实现**（FreeCAD 无头 HLR + 半空间剖切 + JSON 边表 + 自绘黑白 SVG + 13 条 `C1..C13` 几何检查），不是壳；它以「单次投影 + TS 原生 45° 扫描线剖面线」替代了 DSH 的 FreeCAD 多阶段管线（剖切几何 + 剖面线几何 + `.pat` 图样），**这条路更省依赖且已自陈等价，不应整体照搬**。

真正值得搬的四个增量：

| 能力 | DSH | Sati | 工作量 |
|---|---|---|---|
| 多视图一次产出 + manifest | `freecad-structure-script.ts:36,139-166` | 一次一图，无 manifest | M（需 FreeCAD 实机） |
| 局部放大视图 | `freecad-structure-script.ts:15-17,211`（`DrawViewDetail`） | 无 | M |
| 装配体多零件 + 分解图 | `tool/structure-types.ts:160,188` | 只接单个 `step_path` | M |
| **件号锚点自动选取 + 按零件真实几何校验**（容差 0.5mm） | `freecad-structure-script.ts:186-192` | **调用方手填 3D 坐标** `at_mm`（`patentFigureProject.ts:67`）⇒ 极易错 | M |

---

## 4. Sati 已领先 DSH —— 对齐时不得回退

| # | 领先项 | 证据 |
|---|---|---|
| 1 | 确定性规则族 + 规则号 + 严重度可机读 + 单一映射表 | Sati `check-rules.ts` / `render-check-rules.ts:23-32`；DSH 无规则号 |
| 2 | `figure-gate` 工作流门禁：fail 挂 HITL、人工强制放行留痕、四族同权 | Sati `atoms/handlers/builtin/figure.ts:637-652`；DSH 无附图门 |
| 3 | 产物 sidecar 契约 + sidecar↔SVG 漂移对账 | Sati `figuregen/sidecar.ts`、`figure.ts:169-245`；DSH 无 |
| 4 | 栅格像素门 PX1–PX4（覆盖客户扫描件与第三方图） | Sati `figuregen/pixel-gate.ts:30-54`；DSH 全仓无 |
| 5 | 法域档案逐句条文溯源 + `statute/practice` 判级；CN 也有字高下限（DSH 对 CN 静默） | Sati `figuregen/office-profile.ts:68-69,223-231`；DSH `compliance.ts:74-75` |
| 6 | US 边距按「两种单位并列取大」= 25.4/25.4/15.875/10（DSH 取 25/25/15/10，**低于其注释自陈的 1 inch / 5/8 inch**） | Sati `office-profile.ts:127`；DSH `office-profile.ts:128` |
| 7 | 页面契约单一事实源 / 统一缩放系数 `uniformFigureZoom` / 部署级 mm 字号口径 | Sati `page-contract.ts`、`metrics.ts:11-63` |
| 8 | 语义/混合检索（DSH 只做关键词） | Sati `searchPatentFigure.ts:96-113`；DSH `search-patent-figure.ts:47` |
| 9 | 工具 `domain` 元数据 + 角色按域裁剪工具集 | Sati `createBuiltinRegistry.ts:380-383`；DSH `ToolDefinition` 无 domain |
| 10 | 分析↔核验桥接层（客户扫描图也能进确定性规则轨） | Sati `src/patent/figure/bridge.ts`；DSH 无 |
| 11 | 三法域附图说明草稿（CN 段落 + US 英文 BRIEF DESCRIPTION） | Sati `figuregen/brief.ts`；DSH `figure-description.ts` 只有中文单句 |
| 12 | FreeCAD 失败契约（`_fail()` + stderr 标记 + 非零退出码） | Sati `cad/freecad.ts:9-21,51-56`；DSH 以「退出码 0 + manifest 存在」为成功判据 |

---

## 5. 明确不照抄 DSH（照抄会把本仓已核验的东西改错）

| 事项 | 理由 |
|---|---|
| DSH `uspto.rightMm = 15` 等 office 数值 | 与 37 CFR 1.84(g)「右 ≥5/8 in（≈15.875mm）」不符；本仓数值经 Gate 0 逐条核验留痕 |
| DSH `fit_to_page` 默认 `true` | 本仓产物契约是 SVG + sidecar，`figure-gate` 依赖它做漂移检测；默认改写会同时冲击调用方与门禁 |
| DSH `style: semantic` 彩色模式 | 会动摇「构造期黑白不变式」；且需先核验各法域彩色提交程序（37 CFR 1.84(a)(2) 呈请、PCT 11.13(a) 禁止） |
| DSH 的 `element-overlap` 包围盒判据 | 本仓「轮廓实测互相穿过」更准，照搬引入假阳性 |
| DSH 放行 DOCTYPE 的安全门 | 本仓拒 DOCTYPE 更严 |
| DSH `render-check-gate` 布尔 strict 开关 | 本仓已有三档 `SATI_FIGURE_RENDER_GATE`，双开关会语义打架 |
| DSH 的 Python 申请文件引擎（`build.py`/`verify.py`/`render_figures.py`）整体移植 | 本仓已有 TS 原生 OOXML 全链路（`htmlToOoxml` + `applicationTemplate` 五分节 + `verifyApplicationDocx`）+ `sharp@^0.35.5` + `mupdf` 在手；**只取「SVG→PNG 栅格化」这一个能力** |
| DSH 的 `freecad-section-geometry` / `freecad-hatch-geometry` / `.pat` 图样 | 本仓 `cad/render-cad.ts:250 hatchPolylines`（扫描线 + 奇偶规则，结果与调用顺序无关）在图面效果与确定性上等价，少一次 FreeCAD 往返；仅在需要「相邻件剖面线方向相反」（GB/T 4457.5）时补一个方向参数 |
| DSH `dot-builder.ts` 全量移植（标号系列/页幅包/4 模板/6 引擎） | 本仓图型与模板需求不同；按需只移植 `assignNumerals` + `resolvePageBundle` 两个函数 |

---

## 5.5 实施状态（截至 2026-11-12）

本文 §6 的路线图已按三批落地，**每一批的决策记录**在 `docs/notes/implemented/`：

| 批次 | 内容 | 状态 | 决策记录 |
|---|---|---|---|
| **A** | 交付复核四项 / SVG→PNG 栅格化 + 嵌图 + 申请文件图断言 / 生成即入索引 / 输出补标号映射与落版度量 / 法域合规核算 / 版面利用率 + 提示级 / 重复图号 / 错误码语义 / 既有 SVG 补标号（底层） | ✅ 已落地（**零 `inputSchema` 变更、零 fixture 重录**） | `2026-11-12-figure-dsh-alignment-batch-a.md` |
| **B-0** | 落版旋转与字号（部署级）/ 标号一致性归一 + 自动标号 / 交付物清单与时序门（`DR4`）/ RC8 构造层级↔权利要求（纯模块）/ 生成↔识图比对（纯模块） | ✅ 已落地（B-0-2/1/3 **生产可达**；RC8 与比对为**边界写明的纯能力模块**，已登记 `TD-PATENT-N37`） | `2026-11-12-figure-dsh-alignment-batch-b0.md` |
| **C** | CAD 零件事实 + 锚点自动选取与核对（`C14`/`C15`）/ 多视图一次产出 + manifest / 剖面线方向交替（`C16`）/ **每图一页**（`figure-page-break` warn→fail）/ 交付链收尾（时序门输入件契约 + 交付复核去重） | ✅ 已落地（**FreeCAD 1.1.3 真机验证**；零 `inputSchema` 变更） | `2026-11-12-figure-dsh-alignment-batch-c.md`、`2026-11-12-figure-one-per-page.md` |
| | **D** | 渲染不变式护栏（`check:figure-render-baseline`）/ 核验矢量量测输出 / 多视图 A4 拼版 / 落版页 XML 缺陷修复 | ✅ 已落地（零 `inputSchema` 变更） | `2026-11-12-figure-alignment-batch-d.md` |
| | **B-1** | **一次**合并的 schema 变更 + **一次** fixture 重录：补标号工具 / 自动标号 per-call / `figure_family` 同族续号 / 落版参数 per-call / CAD `views[]` / 比对工具 / RC8 接线 / 清单工具 / 预算重排 | ✅ 已落地（**9/10 项**；fixture 已重录，重放门禁绿） | `2026-11-12-figure-dsh-alignment-batch-b1.md` |
| | **B-2** | 新图型渲染器：**时序图**（生命线+消息）/ **电路图**（9 种 IEC 元件符号）/ **多面板** `panels`（网格拼版 + 共享标号系列） | ✅ 已落地（**3/5 项**；2D 剖视与外观设计二维视图转入 `TD-PATENT-N39`；fixture 再次重录） | `2026-11-12-figure-new-kinds-batch-b2.md` |
| | **B-3** | **二维剖视**（`kind="cross-section"`：断面轮廓 + 剖切线 + GB/T 4457.5 剖面线交替 + 孔）+ 修掉「画布白底被当零件」的既有 RC4 缺陷 + 全域描述瘦身（预算上限未再上调） | ✅ 已落地 | `2026-11-13-figure-cross-section-batch-b3.md` |
| | **B-4** | **外观设计二维视图**：**明确不做**（范围决策，非能力遗漏）⇒ `TD-PATENT-N39` 关闭 | ✅ 决策已落 | `2026-11-13-figure-appearance-view-dropped.md` |
| | **N38** | patent 域**描述预算重排**：契约面 47 800 → 42 235；口径下沉到 skill 的 `patent-tool-contracts/` 分片；门禁收紧在粒度（单工具 1 200→300、属性 200→60、总量 48 000→43 000） | ✅ 已落地 | `2026-11-13-figure-description-budget-rearrange.md` |

### B-1（**已完成**：一次合并的 schema 变更 + fixture 重录，2026-11-12）

拿到 provider 凭据（`~/.sati/sati.yaml` 的 deepseek provider，`deepseek-flash`，与原 fixture
同源）后按 B-0 写明的解除条件执行：10 项合并成**一次** schema 变更、**一次**重录。
落地 9 项；第 4（多面板）与第 6（新图型）两项**需要新写渲染器**——只扩枚举不实现渲染 =
接口欺骗，转入 `TD-PATENT-N39` 下一轮处理。

1. 既有 SVG 补标号的**工具暴露** ✅ `patent_figure_annotate`；
2. 自动标号的 per-call 参数 ✅ `auto_numbering`/`numeral_start`/`numeral_step`/`reserved`；
3. `figure_family` 跨图续号 ✅ 同族共享一个连续号段（族内 100/102 → 104/106）；
4. 多面板 `panels` ⏳ → `TD-PATENT-N39`（需多面板渲染器）；
5. 落版参数的 per-call 形态 ✅ `submission{rotate_deg,…}`（generate + project 同款）；
6. 新图型 ⏳ → `TD-PATENT-N39`（需新渲染器）；
7. CAD `views[]` ✅ 入参优先于 env，非法视图名报 `invalid_tool_input`；
8. 生成↔识图比对的工具暴露 ✅ `patent_figure_compare`；
9. RC8 的工具接线 ✅ `patent_figure_check` 的 `hierarchy` 入参；
10. 交付物清单的工具化 ✅ `patent_figure_manifest`（三态 `verified`/`not-registered`/`unavailable`）。

附带：patent 域描述预算重排（制图域压缩约 1 500 字符，总量天花板 40 000 → 46 000，
单工具 1200 / 属性 200 两个上限不变）。**重录注意**：录制脚本是**追加**语义，重录前必须
先清空 `records.jsonl`，否则报 `duplicate record index 0`。

### B-2（**已完成**：新图型与多面板渲染器，2026-11-12）

B-1 推迟的两项里落地三项：**时序图**（`kind="sequence"`）、**电路图**（`kind="circuit"`，
9 种 IEC 矩形符号元件）、**多面板**（`FigureSpec.panels`，网格拼版 + 各格共享标号系列）。
三者**复用 `nodes`/`edges`**（时序图 = 参与者+消息；电路图 = 元件+连线），并用摊平 helper
（`figureNodes`/`figureEdges`）让核验/归一/文案/标号表五条既有管线原样覆盖面板。

仍未落地（截至批次 B-2）：**2D 剖视**与**外观设计二维视图**。前者已在批次 B-3 落地；
后者在批次 B-4 **明确不做**（范围决策：外观案附图主体是照片，DSH 的 `appearance-view-sheet`
本身只做版面组合不画图，引入不闭合链路）⇒ `TD-PATENT-N39` 已关闭，本仓与 DSH 在这一点
**保留差距**。

**重录注意**（本轮再次踩到）：录制脚本是**追加**语义，重录前必须先清空 `records.jsonl`，
否则报 `duplicate record index 0`。

### 已放弃 / 不做（及理由）

- DSH 的 Python 申请文件引擎（只取了「SVG→PNG 栅格化」这一个能力）；
- DSH 的 `freecad-section-geometry` / `freecad-hatch-geometry` / `.pat` 图样
  （本仓 `cad/render-cad.ts` 的 TS 扫描线等价且少一次 FreeCAD 往返）；
- `semantic` 彩色模式、栅格作为主产物、EPO 档案（未核验不落地）；
- DSH 的 `dot-builder.ts` 全量移植（按需只取 `assignNumerals` + 标号系列口径）。

## 6. 对齐路线图

### 批次 A —— 零 schema、零 fixture（纯补缺，不改任何工具入参）

| # | 动作 | 落点 | 工作量 | 验收 |
|---|---|---|---|---|
| A1 | **交付面复核四项**（位图/照片、横向摆放、整幅框线、图面用语终检） | 新增 `src/patent/figuregen/delivery-review.ts`（移植 DSH `figure/delivery-review.ts:38-79`；常量 `FULL_SHEET_RATIO=0.9`、`LANDSCAPE_RATIO=1.05`）；接 `tool/builtin/patentFigureCheck.ts` 与 `atoms/handlers/builtin/figure.ts` | 0.5 人日 | 4 个反例 SVG → `check.ok=false`；同 SVG 落 `figure-gate` 挂 HITL；正常图仍 ok |
| A2 | **SVG→PNG 栅格化 + 申请文件嵌图** | 新增 `src/patent/document/docx/figureRaster.ts`（`sharp` 动态导入，复用 `pixel-gate.ts:296` 范式；或 Chrome headless）；改 `docx/renderApplicationDocx.ts`（取字节前转码）与 `docx/imageInfo.ts` | 1.5–2 人日 | 一张 `-fig1.svg` 直接进 docx ⇒ `word/media/` 有 PNG 且可读宽高；缺依赖时**明确告警**不静默丢图 |
| A3 | **申请文件图相关断言**（每图一页 / 图号与图序一致 / 摘要附图恰 1 张） | `src/patent/document/docx/verifyApplicationDocx.ts`（新增 finding：`figure-page-break` / `figure-caption-order` / `abstract-figure-count`） | 0.5 人日 | 造「两图共页 + 图号写反 + 摘要附图两图」docx ⇒ 报 3 条 fail |
| A4 | **生成侧写附图索引**（生成即可被 `search_patent_figure` 检出） | `tool/builtin/patentFigureGenerate.ts` 落盘后，用 `figure/bridge.ts` 的 `figureSpecsToAnalysis` 造骨架 → `figure/index-store.ts:78` 的 `upsertFigureIndex` | S | 生成后立刻 `search_patent_figure` 能命中（省一次多模态 analyze） |
| A5 | **输出补结构化标号映射与落版度量**（`numeralMap` / `layout`） | `tool/builtin/patentFigureSchema.ts` 的 `FIGURE_ARTIFACT_SCHEMA`（注意 `additionalProperties:false`）+ `patentFigureGenerate.ts` 的 data 映射 | S | 模型在工具输出里直接读到标号表与落版缩放比/字高 |
| A6 | **法域合规核算**（色彩策略 vs 法域 / 图号义务 / 字高 / **摘要附图 40×60mm 缩放字高**） | 新增 `src/patent/figuregen/compliance.ts`（数据现成：`office-profile` + `submission-page` 的 `charHeightMm`/`reducedCharHeightMm`） | S | 摘要附图缩到 40×60 后字高不足 → 报 |
| A7 | **RC8 之外的两类判据补齐**：`sheet-underfill` + `RenderCheckFinding.advisory` 字段 | `figuregen/render-check-types.ts` / `render-check-findings.ts` | S | 落版撑不满纸面 → 出提示级发现且**不阻断** |
| A8 | **重复图号判定**（`duplicateFigureNumbers`） | `src/patent/figure/multi-figure-consistency.ts` | S | 两幅图同图号 → 报 |
| A9 | **既有 SVG 补标号**（`svg-annotate.ts` + 新增工具 `add_patent_figure_references` 等价物） | 新增 `figuregen/svg-annotate.ts`（DSH 183 行可直译）+ `tool/builtin/addPatentFigureReferences.ts` | S–M | 自绘 SVG 按 label 文本匹配追加 `(n)`；未命中项进 warnings 而非失败 |
| A10 | **错误码语义对齐**：缺依赖用 `setup_required`（DSH 口径）而非 `tool_execution_failed`；补 `model_cannot_accept_image` | `src/tool/protocol/errors.ts`、`tool/builtin/patentFigureShared.ts:55-58`、`patentFigureGenerate.ts:157-163` | S | 上层可按码路由（需同步核对 `agent/loop/modelErrors.ts`） |
| A11 | **顺手项**：修正 `patent_figure_check` 描述里「RC0-RC5」→「RC0-RC7」的漂移；补 `figure_family` 索引守卫 | `tool/builtin/patentFigureCheck.ts:309`；`src/patent/figure/index-store.ts:46-60` | 极低 | — |

### 批次 B —— 一次合并的 schema 变更 + fixture 重录

> 硬约束：批次 B 必须在 main 上 `llm-replay-real.spec` 为绿时进行；批内**不得夹带**第二个 schema 改动；新增工具会改 `default_tool_count`/`patent_tool_count` ⇒ 需 `pnpm gen:doc-claims`。

| # | 动作 | 落点 | 工作量 | 备注 |
|---|---|---|---|---|
| B1 | **自动标号分配**（100 系列 / 步进 / `reserved` / 冲突硬抛） | 新增 `figuregen/numeral-assign.ts`（移植 DSH `dot-builder.ts:201-246`），`patentFigureSchema.ts` 增可选参数 | M | 建议**新增**参数而非改既有字段语义 |
| B2 | **跨图续号（`figure_family`）** | 读索引中同 family 条目，同名组件沿用号、新组件续号 | M | 依赖 A4 先落地 |
| B3 | **多面板 `panels`（FIG.1A/1B，共享标号系列）** | `patentFigureGenerate.ts` 增 `panels` 分支 + `brief.ts` 支持后缀 | M | 与 B1/B2 同批 |
| B4 | **落版细节可调**（`rotate_deg` 0/90/180/270、`caption_font_mm`/`caption_gap_mm`/`sheet_font_mm`） | `figuregen/submission-page.ts` + schema | M | 旋转须保持图号在图形正下方 |
| B5 | **新图型**（时序图 ✅ / 电路图 ✅ / 2D 剖视图 ✅ / 外观设计视图 ❌**明确不做**） | 已落地 `figuregen/sequence-diagram.ts` / `circuit-diagram.ts` / `cross-section.ts` + 扩 `FigureKind`（7 型） | M（每型） | `FigureKind` 是穷尽 `Record` ⇒ `brief.ts` 的 `KIND_TEXT`/`KIND_TEXT_EN` 与 `check-rules.ts` 同步；扩枚举即改 `inputSchema` ⇒ 重录 |
| B6 | **生成 ↔ 识图比对**（`compare_patent_figure_analysis` 等价物） | 新增 `src/patent/figure/figure-comparison.ts` + 新增工具 | M | 新增工具 ⇒ 重录 + `gen:doc-claims` |
| B7 | **CAD 多视图 + manifest**（`views[]`） | `tool/builtin/patentFigureProject.ts` + 新增 `cad/structure-manifest.ts` | M | 一次调多视图会拉长 FreeCAD 运行，需超时策略 |
| B8 | **交付物 manifest / 哈希 / 时序门**（等价 `verify_deliverable`） | 新增 `tool/builtin/patentDeliverableVerify.ts`，或把 `figure-check.json.inputs_hash` 扩到交付件级 | M | 可不做新工具，先扩 hash 覆盖范围 |

### 批次 C —— 3D 深水区（需 FreeCAD 实机验收，独立排期）

| # | 动作 | 工作量 | 风险 |
|---|---|---|---|
| C1 | 局部放大视图（`DrawViewDetail`） | M | 高（依赖 FreeCAD 实机） |
| C2 | 装配体多零件 + 分解图 | M | 高 |
| C3 | 件号锚点自动选取 + 按零件真实几何核对（容差 0.5mm） | M | 高（须按本仓 `projectStep` 输出复标定） |
| C4 | 剖面线方向参数（相邻件相反，GB/T 4457.5） | S | 低（补一个参数） |

### 不做

- Python 申请文件引擎整体移植（只取 A2 栅格化）。
- `freecad-section-geometry` / `freecad-hatch-geometry` / `.pat` 整体移植（架构替代）。
- `semantic` 彩色模式、栅格作为主产物、EPO 档案（未核验不落地）。
- `dot-builder.ts` 全量移植（按需只取两个函数）。

---

## 7. 门禁与纪律（批次 A/B/C 通用）

| 约束 | 触发条件 | 动作 |
|---|---|---|
| llm-replay fixture 重录 | 改任一工具 `inputSchema`（含描述文本）、新增/删除工具 | 批次 B 合并一次重录；重录前确认 main `llm-replay-real.spec` 绿 |
| `pnpm measure:update` | 新增/删除任何 `.ts` | 写完文件即跑，否则 `check:techdebt-metrics` 红 |
| `pnpm gen:doc-claims` | 新增/删除工具（工具计数漂移） | 批次 B 收尾 |
| `pnpm gen:patent-workflow-docs` | 改 `manifests.ts` / `figure-gate` 阶段 | 若改则必跑 |
| `pnpm check:skills` / `check:patent-sop` | 改 SKILL.md / 编排手册 | 角色化与工具表变更时 |
| 决策记录 | 每一批的非平凡行为变更 | `docs/notes/implemented/` 一条 note，含 `## Alternatives considered` |
| 隐藏清单 | 阈值/评分线 | 不得写进 `Atom.description` 与 manifest 阶段描述 |
| 法条纪律 | 新增法域数值/规则 | 未核验即不写成规则；DSH 数值只作**待核验线索** |

---

## 8. 证据索引

**DSH（只读基准）**
`packages/patent/patent-tools/src/figure/`：`dot-builder.ts`（标号系列 201-246）· `delivery-review.ts`（交付复核 38-79）· `hierarchy-check.ts`（87-108）· `compliance.ts`（47-92）· `render-check-findings.ts`（判据 25-35 / 净距分档 115-135 / underfill 967）· `render-check-gate.ts`（46-83）· `render-selector.ts`（25-83）· `office-profile.ts`（99-137）· `submission-page.ts`（37,215-227）· `svg-annotate.ts`（130）· `section-source.ts`（1-24）· `freecad-structure-script.ts`（15-17,186-192）· `circuit-diagram.ts`（749）· `sequence-diagram.ts`（292）· `appearance-view-sheet.ts`（368）· `section-diagram.ts`（918）
`packages/patent/patent-tools/src/tool/`：`generate-patent-figure.ts`（306,476-576）· `figure-output.ts`（47-72,161-182）· `figure-panels.ts`（54）· `figure-delivery.ts`（72-170）· `verify-patent-figure.ts`（100-245）· `add-patent-figure-references.ts`（68）· `compare-patent-figure-analysis.ts`（53）· `check-patent-figure-consistency.ts`（44）
`packages/patent/patent-filing/assets/engine/`：`render_figures.py`（90-135）· `build.py`（271-278,520-530）· `verify.py`（286-317）
`packages/patent/patent-document/src/tool/verify-deliverable.ts`（19-90,198-210,324）

**Sati（现状）**
`src/patent/figuregen/`：`types.ts:41`（图型枚举）· `check-rules.ts`（V1–V22）· `render-check-rules.ts:23-32`（RC 映射）· `render-check-types.ts:11-19`（RC 类别，缺 2）· `pixel-gate.ts:30-54`（PX）· `page-contract.ts:1-12` · `office-profile.ts:68-69,127,223-231` · `leader-line.ts:15-40,176-225` · `glyph-box.ts:17-34` · `svg-safety.ts:46-59` · `wording-rules.ts:21-27` · `sidecar.ts:93-119` · `deliverables.ts:35-83` · `dot.ts:63` · `submission-page.ts:29-57` · `metrics.ts:11-63` · `cad/`（`freecad.ts` 614 / `render-cad.ts` 534 / `checks.ts` 41）
`src/patent/figure/`：`index-store.ts:78`（唯一索引写点）· `multi-figure-consistency.ts:56` · `bridge.ts`
`src/tool/builtin/`：`patentFigureGenerate.ts`（344,556-578,613-620）· `patentFigureCheck.ts`（281-509）· `patentFigureProject.ts:67,73` · `patentFigureReview.ts:26-97,115-174` · `patentFigureSchema.ts:274-286`
`src/patent/atoms/handlers/builtin/figure.ts`（155-247,504-657,637-652）
`src/patent/document/docx/`：`imageInfo.ts:21-103`（仅位图）· `renderApplicationDocx.ts:86-140` · `verifyApplicationDocx.ts:7-31`

**本仓既有对齐文档（本文不复述其已落地项）**
`docs/patent-figure-harness-parity-plan.md`（2026-09-22 合规侧，已实施）· `docs/research/patent-figure-dsh-delta-2026-10.md`（2026-10-01 批次 A 实施记录）· `docs/notes/implemented/2026-10-29-figure-harness-parity-p0.md`（P0 轮）· `docs/patent-figure-hardening-plan.md`（核验侧加固）
