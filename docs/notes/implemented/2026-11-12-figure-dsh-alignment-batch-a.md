# Agent Note: 附图对齐 deepseek-harness 批次 A（交付复核 / 嵌图链 / 合规核算 / 索引与输出契约）

Status: implemented

## Problem

`src/patent/figuregen/` 的渲染底座已与 deepseek-harness 等价移植（见
`docs/research/patent-figure-dsh-alignment-2026-11.md` §3.1），但仍有四类差集会让
「看起来生成成功」的交付实际不合格：

1. **交付面复核缺失**：位图/照片嵌入、横向摆放、整幅框线、图面用语终检四项判据在
   DSH 有（`figure/delivery-review.ts:38-79`），本仓全仓无对应实现——这四项正是
   《专利审查指南》第一部分第一章 4.3 下发补正通知书的常见理由。
2. **SVG 附图进不了申请文件**：本仓 docx 嵌图链只嗅探 PNG/JPEG/GIF/BMP 文件头
   （`docx/imageInfo.ts:21-103`），矢量附图必须人工先转位图；且成品核验没有
   「每图一页 / 图号与图序一致 / 摘要附图恰 1 张」三项断言（DSH
   `patent-filing/assets/engine/verify.py:286-317` 有）。
3. **两处编排断点**：① 生成侧不写附图索引——全仓只有 `analyzePatentFigure.ts:200`
   写索引，生成物检索不到，必须额外调一次多模态 analyze；② 生成输出不含结构化标号
   映射与落版度量（`numeralMap` / `layout` 只在 DSH 的 output 里，本仓只在 sidecar
   里）⇒ 模型看不到标号表，也无法判断「缩到 2/3 是否可辨」。
4. **门禁与核算的三个空洞**：法域合规核算（色彩/图号/字高/摘要附图 40×60mm 缩放）、
   交付物 manifest/哈希/时序门、构造层级 ↔ 权利要求一致性（RC8）在本仓无实现；
   本批补前两项中可零成本落地的部分（合规核算 + 摘要附图判据）。

## Decision

本批**零 `inputSchema` 变更、零新增 builtin 工具** ⇒ 不触发 llm-replay fixture 重录
（AGENTS 第 6 条：改任一工具 `inputSchema`（含描述文本）或新增/删除工具才会让
`toolSchemaDigest` 失配；改 `outputSchema` 不入 digest）。

### A1 交付面复核四项

- 新增 `src/patent/figuregen/delivery-review.ts`（纯函数）：位图/照片（`<image>`）、
  横向摆放（宽 > 高 × 1.05）、整幅框线（闭合轮廓包围盒 ≥ 画布 90% × 90%）、
  图面用语终检（复用 `wording-rules.ts` 的 `inspectWording`，规则号沿用 V12/V13/V14）。
- 规则号新增 `DR1`/`DR2`/`DR3`（交付面族），与 V/RC/PX/C 分列；接线在
  `patent_figure_check`（按需核验）与 `figure-gate`（交付门）两处，DR 族 fail ⇒
  同权挂 HITL。
- **两处对 DSH 的有意偏离**（实测依据见模块头 docblock）：
  1. **DR2 加「宽于法域版心」前置条件**：本仓的 SVG 是**内容画布**不是附图页，实测
     自产图比例：单节点流程图 45.5×37.3mm（1.22）、任意 LR 块图 118.5×37.3mm（3.18）
     ——照搬 DSH 的纯宽高比会把这两类**合规**图全判成横向。判据改为：宽高比 > 1.05
     **且**宽于法域版心（cn 170mm）**且**旋转后放得下。
  2. **DR3 只看「有描边」的闭合轮廓**：自产图根下有铺满画布的白底矩形
     （`render-svg.ts` 的 `fill="#FFFFFF"` 无描边），照搬 DSH「任意闭合子路径」会把
     **每一张自产图**判成整幅框线。框线是画出来的线，白底矩形不是。
- 图号标注（`图1`/`FIG. 1`）不参与用语终检：否则每张带图号的合规图都被报 V12，
  与 V15 的编号义务自相矛盾。

### A2/A3 附图入文链

- 新增 `src/patent/document/docx/figureRaster.ts`：SVG → PNG（300 DPI 等效），
  优先 `sharp`（已装，零外部依赖），失败回退 Chrome headless；两者都不可用时**抛错**
  而非静默丢图，降级路径在返回值里带 `degraded.reason`（AGENTS 第 11 条）。
- `imageInfo.ts` 增加 SVG 分支（只做尺寸探测）；`renderApplicationDocx.ts` 在取字节
  前把 SVG 转码为 PNG，既有 PNG/JPEG/GIF/BMP 路径**逐字节不变**。
- `verifyApplicationDocx.ts` 增加三类图断言（`figure-page-break` /
  `figure-caption-order` / `abstract-figure-count`）：判定基于**成品 docx 的实际
  内容**，判不了就显式报「未检查」而不是「通过」。
- **`figure-page-break` 定为 warn 而非 fail**：本仓的 HTML→docx 渲染链**不产出分页符**
  （母版显式关闭 `pageBreakBefore`），因此「每图一页」目前是**渲染链的能力缺口**，
  不是调用方交出来的文件有缺陷。定 fail 会让任何含两幅以上附图的申请文件必然
  「核验未通过」——那是在训练使用者忽略核验门。缺口如实报出（warn 级），并在
  `renderPatentDocument.ts` 里把 warn 级核验发现并入「提示」行（**不阻断 ≠ 没发生**：
  只报 fail 会让这类缺口在模型可见面里彻底消失）。渲染链补上分页符能力后再议是否升级。

### A4 生成即入索引

`patent_figure_generate` 在产物与 sidecar 落盘后，用 `figure/bridge.ts` 的
`figureSpecsToAnalysis` 造骨架并写 `.sati/figures-index.json`（`upsertFigureIndex`），
使生成物可被 `search_patent_figure` 直接检出。索引写入失败**降级但不静默**：报告行与
`data.indexed` 如实写明「未入索引」及原因；门禁 `fail` 档抛错时**不写索引**（未过门禁
的图不是可交付物，进检索索引会让「搜到的就是已交付的」这个隐含前提失效）。

### A5 输出补标号映射与落版度量

`FIGURE_ARTIFACT_SCHEMA` 增 `numeral_map`（组件标签 → 附图标记）与 `layout`
（缩放比 + 落版后纸面尺寸/字高 + 落版页文件名）。改的是 **outputSchema**，不入
llm-replay 的请求键 ⇒ 不需要重录 fixture。

### A6 法域合规核算

新增 `src/patent/figuregen/compliance.ts`（纯函数）三条判据：图号义务（两幅以上须逐幅
编号）、字高下限（走档案 `minCharHeight` 的「条文优先、否则实践下限」口径）、摘要附图
40×60mm 缩放字高（《专利审查指南》第二部分第二章 2.4；只报数值，不判定「清晰」）。
**不引入色彩策略判据**：本仓是构造期黑白不变式，`style: "semantic"` 不是一个输入
维度，为不存在的维度写判据只会造出永不触发的分支。

### A7 版面利用率与提示级

新增 `sheet-underfill` 判据（RC9，**提示级 advisory**：不是缺陷，只值得人看一眼），
阈值走部署级环境变量 `SATI_FIGURE_MIN_SHEET_FILL_RATIO`（0–1，缺省 0 = 不判）。
`RenderCheckFinding` 增 `advisory` 标记；advisory 发现**不计入缺陷数、不阻断交付**，
报告里单列条数。

### A8 重复图号判定

`multi-figure-consistency.ts` 增 `duplicateFigureNumbers`：同一图号对应多幅附图时，
说明书里的「图N」指向不唯一（分次调用或多路径提交同一图即会触发）。

### A9 既有 SVG 追加参考标号（底层能力）

新增 `src/patent/figuregen/svg-annotate.ts`（纯函数）：按图元可见文本子串匹配追加
`(标号)`（**无空格**，本仓惯例「处理模块(20)」），未命中进 `unmatched` 不静默丢弃，
输入先过 `svg-safety.ts` 的安全门。**本批不暴露成 builtin 工具**（见下）。

### A10 错误码语义

缺外部依赖（Graphviz / Inkscape / FreeCAD）改用 `setup_required` 而非
`tool_execution_failed`；新增 `model_cannot_accept_image`（对齐 DSH 错误码集），
附图识别在模型不支持图片时用它点名原因。

## Alternatives considered

- **把 A9 暴露成 builtin 工具（`add_patent_figure_references` 等价物）** ——
  新增工具会改变工具列表 ⇒ `toolSchemaDigest` 变化 ⇒ **既有 llm-replay fixture 失配，
  必须重录**（AGENTS 第 6 条）。本批的纪律是「零 schema、零 fixture」，故只交付底层
  纯函数，工具暴露推到批次 B 与其它 schema 变更合并重录。
- **A4 用 `analyze_patent_figure` 的多模态结果入索引** —— 那要额外调一次模型，成本与
  延迟都高，且识图结果不如确定性骨架可靠（本仓的 `figureSpecsToAnalysis` 明确「丢弃
  几何」是有意为之）。改用骨架入索引，检索命中的是「我们声明了哪些组件」。
- **A4 在门禁 fail 档抛错后仍写索引** —— 未过门禁的图不是可交付物；入索引会让
  「搜到的就是已交付的」这一隐含前提失效。改为 fail 时不写。
- **A1 的用语终检新建规则号（如 DR4）** —— 用语规则（V12/V13/V14）已有法域作用域与
  「有意不判三类」的显式声明；另立规则号会让同一类缺陷出现两套语义。DR 族只承载
  「交付面」新增的三项（位图/横向/整幅框线）。
- **A1 的横向判据用「宽 > 高」而不是「宽 > 高 × 1.05」** —— 方形或近方形的图（如
  流程框图）不是横向；1.05 的容差与 DSH 一致，避免把正常方图误报。
- **A2 引入 DSH 的 Python 栅格化引擎** —— 本仓已有 TS 原生 OOXML 全链路
  （`htmlToOoxml` + `applicationTemplate` 五分节 + `verifyApplicationDocx`）与
  `sharp`/`mupdf` 在手；引入 Python 会带来解释器/依赖分发/双事实源三重负担。只取
  「SVG→PNG 栅格化」这一个能力。
- **A2 直接把 SVG 嵌进 docx（不栅格化）** —— 申请文件提交的是位图版式，且 Word 对
  SVG 支持不一致；栅格化是 DSH 的既有做法，且本仓已有像素门可以核验栅格产物。
- **A6 引入 DSH 的 `style: semantic` 色彩分支** —— 本仓是构造期黑白不变式（渲染器只
  产 #000000/#FFFFFF），彩色模式不是输入维度；为一个不存在的维度写判据 = 造死分支 +
  制造「我们判过色彩」的错觉。
- **A6 直接读 `profile.minCharHeightMm`** —— DSH 的做法；该字段在 CN 档案为空 ⇒
  「CN 无法核字高」的**错误结论**（CN 无附图专有字高条文 ≠ 不该核）。改走档案的
  `minCharHeight`（条文优先，否则实践下限），并在消息里标明下限性质与出处，实践取值
  不被说成法条要求。
- **A7 给版面利用率设一个默认阈值** —— 不同交付体例对「撑不撑满纸面」的要求不同，
  固定阈值会变成噪音。缺省不判（部署级 opt-in），未启用时报告不含该项，也不声称
  已量测。
- **A7 把 advisory 判据定成 fail** —— 它没有条文依据；定 fail 会让历史交付整体翻红，
  阻断与本批无关的交付。定为提示级：报告但不当缺陷。
- **A8 只报 missingFigureNumbers 不报重复** —— 缺号与重号是两类不同缺陷：缺号是
  交付不全，重号是「图N指向不唯一」。后者审查员按图核对时必然对不上，不能因为
  「少见」就不判。
- **DR2 照搬 DSH 的纯宽高比判据** —— 实测本仓自产图比例 1.22（单节点流程图）与 3.18
  （LR 块图），照搬会把**合规**图判成横向，还会直接打红既有门禁用例。加「宽于法域
  版心 + 旋转后放得下」两个前置条件后，DSH 口径的反例（200×100mm）仍命中。
- **DR3 照搬 DSH 的「任意闭合子路径」** —— 自产图根下有铺满画布的白底矩形（无描边），
  照搬会把每一张自产图判成整幅框线。只看有描边的闭合轮廓。
- **`figure-page-break` 定 fail（DSH 的做法）** —— 本仓渲染链不产出分页符，定 fail 会让
  任何多图申请文件必然「核验未通过」；这既不是文件缺陷（是渲染链能力缺口），也会
  训练使用者忽略核验门。改 warn + 在核验提示行出声；**不选**「直接不判」——那会让
  这个缺口彻底消失。
- **不引入 DSH 的 Python 栅格化引擎** —— 已在 A2 说明：只取能力，不取运行时。

## Consequences

- 四类差集里最容易被补正通知书打回的两项（交付复核、SVG 入文）已闭环；生成→检索
  回读的两处断点已接通，模型在工具输出里能直接拿到标号表与落版度量。
- 产物契约面扩大了三个字段（`numeral_map` / `layout` / `indexed` + `compliance`），
  全部在 **outputSchema** 侧 ⇒ 不影响 llm-replay 请求键，既有 fixture 无需重录。
- 新增四个模块文件 ⇒ `docs/technical-debt/metrics.md` 的文件数基线变化，已跑
  `pnpm measure:update`。
- A9 的工具暴露、A8 的索引守卫收紧、RC8（构造层级）与交付物 manifest 门均**留到批次
  B/C**：前者会改工具列表（需与其它 schema 变更合并重录），后者需要新的入参或显式
  层级输入。
- 既有行为不变：未设 `SATI_FIGURE_MIN_SHEET_FILL_RATIO` 时渲染复核输出与既有快照
  逐字节一致；`patent_figure_check`/`patent_figure_project` 的既有产物与发现面不变
  （新字段均为可选）。

## Verification

- `pnpm exec tsc --noEmit`：零错误；`pnpm build`：通过。
- `pnpm lint`（含 11 个领域门禁 + `check:doc-claims`）：绿；`pnpm format:check`：绿；
  `pnpm check:architecture-boundaries`：绿（本批把 `patent_figure_generate.ts` 从 866 行
  拆到 769 行：标号表/合规核算/索引写入抽到 `patentFigureOutput.ts`）。
- `pnpm measure:update` + `pnpm gen:doc-claims`：已回填（新增 4 个模块文件 ⇒
  `src/patent/` 文件数与体量基线变化）。
- `pnpm test`：6548 用例 / 6543 通过 / **2 失败（均为环境性，与本批改动无关）**：
  ① `renderPatentDocument.spec.ts:112 系统 Chrome 存在时可生成 PDF`——本机沙箱下
     Chrome 无头不可用（实测 `GPU process isn't usable. Goodbye.` + crashpad 权限拒绝），
     `pdfRenderer.ts` 本批未动；② `patentPdfDownload-configdir.spec.ts:74`——
     `EPERM: mkdir '/Users/xujian/pdf-tilde-test'`（工作区外写权限被沙箱拒绝），
     该链本批未动。新增用例全绿：交付复核 12、合规核算 10、SVG 标注 18、
     栅格化与嵌图 17。
- 端到端探针（真生成 → 人工注入缺陷）：正常图 `ok=true` 且门禁通过；注入 `<image>`
  ⇒ 工具 `ok=false` + `[FAIL] DR1`、门禁挂 HITL、`figure-check.json.delivery_check`
  有留痕；注入整幅描边框 ⇒ `[FAIL] DR3`。

## 遗留（批次 B/C）

1. A9 的工具暴露（`add_patent_figure_references` 等价物）：新增工具会改工具列表 ⇒
   必须与其它 schema 变更合并重录。
2. RC8（构造层级 ↔ 权利要求归属一致性）：需要 `FigureSpec` 之外的显式层级输入 ⇒
   schema 变更 ⇒ 批次 B。
3. 交付物 manifest / 哈希 / 时序门（DSH `verify_deliverable` 等价物）：批次 B。
4. `figure-page-break` 升级为 fail 的前提是渲染链能产出分页符（当前不能）。
5. DR 族与结构侧可能对同一处英文 label 报两次（结构侧聚合一条 + 交付侧逐命中一条）：
   本批按「独立面」处理未去重，收敛时按 (规则号, 命中片段) 去重。
6. Chrome 回退栅格化路径在本环境未真跑（无头不可用），**sharp 路径已真跑通过**
   （1181×591 PNG，与目标 DPI 尺寸一致）。
