# Agent Note: 附图对齐批次 D（渲染不变式护栏 / 核验量测输出 / 多视图拼版 + 落版页 XML 修复）

Status: implemented

## Problem

批次 A/B-0/C 把附图链的能力补齐了，但**质量护栏与交付可用性**仍有三处缺口：

1. **渲染产物没有可比基线**：仓库自认的缺口（`docs/research/patent-figure-dsh-alignment-2026-11.md`
   §5.5 第 4 条）——现有「逐字节确定性」断言都是**同一进程内两次调用**比较 ⇒ 只能抓
   随机/时钟/Map 迭代序这类回归，**抓不到跨 graphviz 版本或跨平台的布局漂移**。
   本批刚做完的三后端渲染（builtin / graphviz / graphviz-wasm）恰恰是漂移风险面。
2. **核验只给结论、不给数**：DSH 的 `verify_patent_figure` 输出线宽分布 / 取向分布 /
   最小字高 / 画布尺寸，调用方能据此判断「这批线是不是都太细」；本仓只给 findings，
   量测值被丢掉 ⇒ 代理师要自己量。
3. **多视图交付缺整页版式**：批次 C 已支持 `SATI_CAD_VIEWS=front,top,right` 一次产出多视图，
   但**只有主视图有落版页** ⇒ 多视图交付时「A4 整页」缺失，只能自己拼。
   另外发现一处**既有真实缺陷**：单图落版页的根 `<svg>` 开始标签**缺闭合符 `>`** ⇒
   产出的 `-page.svg` **不是合法 XML**（xmllint / librsvg / rsvg-convert 拒绝；浏览器与
   我们的正则回读器能容忍，所以此前没被发现）。

## Decision

### D-1 渲染产物不变式护栏

- 新增 `scripts/figure-benchmark/gen-render-baseline.ts` + 入库基线
  `tests/fixtures/patent/figuregen-bench/render-baseline.json`（3 后端 × 18 用例 × 逐幅）。
- 基线存**不变式**（不含坐标）：图号、`data-ref` 集合、纸面尺寸（±0.5mm）、文字数与文本集合、
  图元类别分布与计数、端点/线段数；**builtin** 另存内容 sha256（它逐字节确定 ⇒ 字节漂移必须红）。
- **分档判定（按实测数据划线，不是拍脑袋）**：同一用例下 dot 16.1.0 与 viz 3.30.0 的
  **结构完全一致**（shapes 23 / points 95 / segments 86 / 标签普查相同），但**纸面尺寸不同**
  （57.15mm vs 46.21mm）⇒ 结构量任何环境精确比对；**坐标派生量**（纸面尺寸、端点/线段数）
  仅在**引擎版本与基线一致时**判定，不同则标注「本环境未核验」；builtin 的 sha256 逐字节判定。
- 门禁 `pnpm check:figure-render-baseline` 挂进 **`pnpm lint` 链**（与其它领域门禁同性质，
  实测 2.3s）。基线缺失 / 缺后端段 ⇒ **报错**，不是静默通过；本机无 dot ⇒ 该后端标
  「本环境未核验」。

### D-2 核验输出补矢量量测值

- `patent_figure_check` 的 **outputSchema** 增可选字段 `measurements`（每幅被核验 SVG 一条：
  画布 mm、文字数、**实测**最小字高、线宽分布、取向分布）⇒ **零 `inputSchema` 变更**。
- 报告文本增「矢量量测」分面（模型在文本面也能读到，不只结构化 data）。
- 诚实语义：安全门拒绝 / SVG 不可解析沿用**整次 fail-loud**（不产出半份量测值）；
  结构化 `figures` 通路没有 SVG ⇒ `measurements` 为空数组，**不编造**。
- ⚠️ 本仓 `RenderCheckReport.minFontMm` 是**下限回显**（语义不同），故新增独立导出
  `measureMinimumFontHeightMm(svg)` 取**实测**最小字高。

### D-3 多视图 A4 落版拼版

- 新增 `figuregen/submission-sheet.ts`（`buildSubmissionSheet`）+ 落盘封装
  `writeSubmissionSheetArtifact`（`<name>-fig<N>-sheet.svg`）+ sidecar 的**可选**
  `sheet_layout` 字段（`layout` 语义一字未动）。
- **排布规则**：候选列数 C=1…N，择优顺序 = ①**统一缩放系数最大**（字高最大 ⇒ 可辨性优先，
  附图页第一判据是「缩小到三分之二仍可辨」）→ ② 格形更接近方形 → ③ 列数更少。
- **统一缩放按拼版后的单格可用区算**（`uniformFigureZoom` 增可选可用区参数，口径仍只有一处），
  各格共用一个系数 ⇒ 字高一致；低于法域下限 ⇒ **如实报出**（warnings + 报告行 +
  sidecar `char_height_compliant=false`）并给可照做建议。
- **图号/页码规则不自行解释**：图号由调用方经 `figureCaption` 取得后按格传入，页码经
  `sheetNumberText` 取得（法域档案是编号规则的唯一事实源）。

### D-4 落版页 XML 修复（既有缺陷）

单图落版页根 `<svg>` 开始标签补上闭合符 `>`。**这会改变既有 `-page.svg` 的字节** ——
属**缺陷修复**（交付物要送审、要能被第三方工具打开），优先级高于「既有产物逐字节不变」。
修后 xmllint 校验通过。

## Alternatives considered

- **D-1 用逐字节 golden 文件** —— 否决：graphviz 的坐标随 dot 版本漂（实测 57.15mm vs
  46.21mm），逐字节基线会在升级 dot 时全线变红，护栏反而变成噪音 ⇒ 改存**不变式**，
  只对 builtin 保留 sha256。
- **D-1 把全部量都按「版本不同即不判定」** —— 否决：那会让升级 dot 后的**结构漂移**
  （真缺陷）也被放过；结构量是跨版本稳定的，必须任何环境都判。
- **D-2 新增一个独立工具 `verify_patent_figure`** —— 否决：**新增工具 ⇒ 工具列表变化 ⇒
  llm-replay 请求键失配 ⇒ 必须重录**（本机无凭据，见 B-0 决策记录）。改为并入既有核验工具的
  **输出面**（outputSchema 不入 digest）⇒ 量测与判据同源同一次遍历，结论与数不出两张皮。
- **D-2 复用 `RenderCheckReport.minFontMm` 当实测最小字高** —— 否决：该字段是**判据下限
  的回显**（调用方传进来的下限），语义与「实测最小字高」相反，混用会给出错误结论。
- **D-3 让各格各自缩放填满格子** —— 否决：各格字高不一致 ⇒ 缩到 2/3 后有的格可辨、有的不可辨。
  统一系数是既有 `uniformFigureZoom` 的口径，不另立。
- **D-3 多视图时**同时**保留**主视图的整页落版页** —— 采纳（「主视图单独一页」与
  「多视图共页」两种版式实务都用），故拼版页是**附加产物**，不替换既有页。
- **D-4 不修 XML 缺 `>`（保住既有产物字节）** —— 否决：交付物不是合法 XML 是**真实缺陷**
  （严格渲染器打不开）。「既有产物逐字节不变」是我给子代理的**实现约束**，不是产品要求；
  缺陷修复优先。已在 note 与提交说明里点名该字节变化。

## Consequences

- 附图渲染有了**跨版本/跨平台的回归护栏**：改渲染器、改 dot 版本、改布局口径都会在
  `pnpm lint` 里变红，且指明「哪一幅、哪个量」漂了。
- 核验输出同时给**结论与数**：代理师不必再自己量线宽/字高。
- 多视图可**直接交付 A4 整页**（真机 FreeCAD 1.1.3 验证：3 视图 2 列 × 2 行、各格统一
  缩放 100%、拼版后字高 3.00mm 达标、黑白不变式成立、xmllint 合法）。
- 单图落版页的字节**变了**（补 `>`）：既有多视图案卷若要刷新清单一致性，需重跑一次生成。
- ⚠️ **`patent` 域的工具描述预算已顶格**：`description + inputSchema` 合计上限 40 000，
  本仓已到 **39 991（余 9 字）** ⇒ 后续新增工具描述前必须先跑该门禁，更该做的是**整体重排
  预算**而不是逐条挤（已登记 `TD-PATENT-N38`）。

## Verification

- `pnpm exec tsc --noEmit`：零错误；`pnpm build`：通过。
- `pnpm check:figure-render-baseline`：**有基线 → 绿**；改基线 → **红**并点名「哪一幅哪个量」；
  基线缺失 → **红**（报错，非静默通过）；无 dot → 该后端标「本环境未核验」。
- 新增用例：渲染不变式护栏 12、量测输出 5、拼版 12（+ 真机一例）。
- `pnpm lint` / `pnpm format:check` / `pnpm check:architecture-boundaries`：绿。
- `pnpm test`：全量跑，仅两条**既有环境性**失败（沙箱 Chrome 无头不可用、沙箱禁写工作区外）。
- 重放门禁：`llm-replay-real.spec.js` ⇒ `# pass 1`（本轮零 `inputSchema` 变更 ⇒ fixture 未受影响）。
