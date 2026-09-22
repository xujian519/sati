# Agent Note: 附图提交落版页（submission-page）

Status: implemented

## Problem

`patent_figure_generate` 出的是**图形自身画布**的 SVG：图号画在图形内部底部的标注带上，画幅四周只有 28px 内边距。提交/打印需要的是**整页视图**——图形落在法域档案的版心内、页码落在页边（CN 五部一章 5.6「页码应当置于每页下部页边的上沿，并左右居中」；PCT 行政规程 207(b)(iii) 与 37 CFR 1.84(t) 为 `1/3` 体例）。此前没有任何一步把图形落版到 A4 页，`format: html|both` 的整册 HTML 也不含页码。

## Decision

新增 `src/patent/figuregen/submission-page.ts`：`buildSubmissionPage({ drawingSvg, office?, caption?, sheetIndex?, sheetTotal? })` → `{ svg, metrics, warnings }`。行为：解析图形画幅（mm/cm/in/pt/px/无单位，缺声明回落 viewBox 按 px 折算）→ 按档案版心等比缩放（**放大上限 4×** 防失真，超限截断并出 warning）→ 版心内居中 → 图号在图形正下方、页码在版心底（`页高 − 下边距`，即"下部页边的上沿"）→ 全部 `fill="#000000"`，确定性输出（无时钟/随机）。根元素带上图形的 `data-figure-no`，使**落版页同样可被 `parseFigureSvg` 回读**（`figure-gate` 的漂移检测因此对落版页有效，有断言锁住）。`metrics` 报 `pageScale`/落版纸面尺寸/图号与页码基线/字高估算（含再缩 2/3 值）。

**Sati 的 `fit_to_page` 默认 `false`**（与姊妹项目 deepseek-harness 的默认 `true` 有意不同）：`true` 时**额外**产 `<name>-figN-page.svg` 并在 sidecar 记 `layout` 摘要；图形 SVG 仍是机器可读的主产物。

**页面层不重画图号**：图形自身已把图号画在正下方的标注带上（4.3 的要求由图形满足），需要编号时图形必有图号、不需要编号时（pct/us 单幅）页面也不得出现 `Fig.`。`caption` 选项保留给"调用方提供的图形没有图号而页面需要落图号"的场景（如外部产出的图形）。

## Alternatives considered

- **把默认改成 `fit_to_page: true`（跟随姊妹项目）** — 落选。Sati 的产物契约是 `<name>-figN.svg` + sidecar，`figure-gate` 依赖 sidecar 声明的文件做漂移检测；默认改写画布会同时冲击既有调用方与门禁。落版页作附加产物能把"整页视图"给到需要的场景，又不动物理契约。
- **落版页也用 `<image>` 或位图嵌入** — 落选。会引入第二种交付形态（栅格），且丢掉矢量与可回读性；嵌套 `<svg>` + 原 viewBox 即可等比缩放。
- **页面层再画一个图号（图形内 + 页面各一个）** — 落选（实现过程中实测发现）：会出现两个"图1"，且与"单幅不得出现 Fig."的法域规则冲突。改由图形自带、页面只补页码。
- **页码用 CSS `@page` 页边距框（`counter(page)`）生成** — 落选。Chromium 打印管线不支持 `@page` margin box；HTML 整册路径无法产出页码，落版页（SVG）才是可控路径。
- **`schemaVersion`/`metrics` 里报"图形内文字实际字高"** — 落选（如实标为估算）。图形坐标的字高取决于渲染器（内置 14px / graphviz 14pt），页面层拿不到"哪个 text 是正文"，故 `sourceCharHeightMm` 由调用方传入（默认按内置渲染器折算），metrics 里明确是估算值。
- **落版页顺带画扫描定位十字（37 CFR 1.84(g) "should have scan target points"）** — 未做。"should"级建议、非法定要求，且属超出本刀范围的版式功能；已在 `references/uspto-drawing-rules.md` 记为未实现的边界。

## Consequences

- 新增一类产物（`<name>-figN-page.svg`，默认不产），sidecar 新增可选 `layout` 与 `sheet` 字段（**不升版本**：新字段可选、解析器对额外字段宽容，升版会让既有案卷 sidecar 直接抛错）。
- CN 页码体例是顺序数字、PCT/US 是 `1/3`，差异由档案回答；多页案卷需要调用方声明 `sheet_index`/`sheet_total`（V17 在声明了页数却没给序号时提示）。
- 落版页的版式判据与实际排版同源（`printableArea(profile)`），不会再出现"核验阈值与排版各说各话"。
- 未做：letter（8½×11）版式、多图合并到一张图上排版、扫描十字。
