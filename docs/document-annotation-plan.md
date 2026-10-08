# 图片 / PDF / 文档标注能力 —— 开源调研与实施方案

> 状态：**阶段 0–1 已落地**（图片族单入口 + sidecar v2）；**HTML 交付物已落地**（2026-10-08，见 `docs/html-annotation-plan.md`）；阶段 2–3（PDF / Office）未开工
> 关联决策记录：`docs/notes/implemented/2026-09-28-universal-annotation-surfaces.md`
> 调研日期：2026-09-28（调研数据均为当日实测）

## 一、目标与现状差距

**目标**：把今天只服务专利 SVG 附图的标注面板，扩到**图片（PNG/JPEG）、PDF、Office 文档**；标注可**保存**（落盘、可重开续标）、可**发送到对话**（随消息交智能体）。

**现状**（已核实）：

| 介质 | 预览器 | 能否画标记 | 能否圈选区 | 标注落盘 |
|---|---|---|---|---|
| `.svg` 附图 | `FigureAnnotator`（`ui/src/components/figure-annotator/`，20 文件 / 3430 行） | ✅ 5 种标记 + 逐条说明 + 图元锚定 | ✅（工具条「区域引用」） | ✅ `<文件名>.annot.json`（v1 形态；v2 起带扩展名） |
| 栅格图片 | `ImagePreview`（101 行） | ❌ | ✅ 仅 region | ❌ |
| PDF | `PdfDocumentPreview`（305 行，自建查看器） | ❌ | ✅ 文本选区 + region | ❌ |
| Office | `OfficeFilePreviewRouter`（多为 LibreOffice → PDF） | ❌ | ✅ 文本 / 单元格 / region | ❌ |

> **上表是改动前的现状。** 落地后：`.svg` 与栅格图片合并为「图片族」，统一进标注面板（可画标记 + 面板内的区域引用），`ImagePreview` 已删除；PDF 与 Office 仍未接标注面。

**关键发现：原方案自我否决的理由已经消失。** `docs/notes/implemented/2026-09-28-figure-annotation-panel.md` 里「标注器接管所有图片」落选的理由有两条——栅格图无图元锚定、会顶掉 `ImagePreview` 的区域引用。后者已由同日的 `2026-09-28-figure-region-reference-entry` 处置（工具条新增独立的「区域引用」模式），标注与区域引用不再抢同一套指针手势。**因此"图片不能标注"不再是设计约束，只是尚未接线。**

**可直接复用的既有资产**（这是本项目相对从零选型的最大优势）：

- 已发送通路：`ADD_CONTENT_REFERENCE_EVENT`（`sati:add-chat-reference`）→ composer → `formatContentReferencePromptBlock`（智能体读的结构化块）+ `contentReferenceImage`（多模态图片部分）。**不需要新网关方法、不需要动协议与事件矩阵。**
- 已落盘通路：`saveFigureAnnotation` 走既有 `PUT /api/projects/:name/file`。**不需要新后端路由。**
- PDF 已有 `pdfjs.TextLayer` 渲染（`ui/src/components/code-editor/view/pdf/components/PdfPage.tsx:126`）与文本选区 → `TextContentReference` 的转换（`use-pdf-selection-reference.ts:111`）。**PDF 的语义锚定（引文 + 矩形）已经存在，只是没接到"画标记"上。**
- 标注契约单一事实源：`ui/src/types/annotationReference.ts`。

## 二、开源生态调研

指标口径：GitHub star / 许可证取自 GitHub API；周下载量取自 npm registry `last-week`；体积取自 npm `unpackedSize`。均为 2026-09-28 实测。

### 2.1 结论先行

| 方案 | Star | 许可证 | 周下载 | 体积 / 依赖 | React 19 | 判定 |
|---|---|---|---|---|---|---|
| **pdfjs-dist**（已在依赖中） | 53.9k | Apache-2.0 | 31.9M | 34.5 MB（已在包内） | 无关 | ✅ **PDF 面首选**，自带批注编辑器层 |
| **perfect-freehand** | 5.7k | MIT | 3.0M | 0.11 MB / 0 依赖 | 无关 | ✅ 可选，仅手绘笔迹平滑 |
| konva + react-konva | 14.8k / 6.4k | MIT | 3.1M / 2.4M | 1.79 MB / 0 依赖 | ✅ ^19.3 | ⚪ 画布场景图主流路，但本项目已有自研画布 |
| excalidraw | 133.1k | MIT | 663k | 44.6 MB / 31 依赖 | ✅ | ⚪ 仅在"要白板"时才值得 |
| tldraw | 50.6k | **自定义（非 OSI）** | 494k | 14.2 MB / 16 依赖 | ✅ ^19.2.1 | ❌ **许可证禁止生产使用** |
| fabric.js | 31.5k | MIT | 1.09M | 21.2 MB / 0 依赖 | 无官方绑定 | ❌ 与本项目自研画布重叠且更重 |
| annotorious | 867 | BSD-3 | 8.7k | 1.96 MB | 无关 | ❌ 仅图片、无 PDF/文档面 |
| react-pdf-highlighter | 1.4k | MIT | 53k | — | 停更（2024-11） | ❌ 停更，仅作 UX 参考 |
| pdf-lib | 8.6k | MIT | 16.3M | — | 无关 | ❌ 停更（2024-07），仅用于"导出真批注 PDF"后置阶段 |
| Zotero reader | 203（Zotero 15.4k） | Other（非标准 SPDX） | — | — | 无关 | ⚪ **UX 参考**，许可证需另行核实才可复用代码 |
| label-studio | 28.4k | Apache-2.0 | — | — | 无关 | ❌ 标注平台（训练数据），非同场景 |

### 2.2 tldraw：star 高但**许可证直接出局**

`tldraw/tldraw` 的 `LICENSE.md` 原文条款：

> - Not to use the Software in Production Environments.
> - Not to disable, change, or interfere with the Software's License Key enforcement.

"Production Environment" 的定义明确包含"web applications … 提供功能给终端用户、客户或公众"。Sati 是 AGPL-3.0 的开源产品，**在生产环境使用 tldraw SDK 需要商业许可**。这不是"要注意的细节"，而是硬性排除；且其许可证还要求"不得以超越本许可证的许可证分发"，与 AGPL-3.0 的传染性存在冲突。

### 2.3 Excalidraw：许可证干净，但解决的是另一个问题

MIT、133k star、React 17/18/19 全支持、`@excalidraw/excalidraw` 提供受控组件与 `excalidrawAPI`（`onChange` / `exportToBlob`）。但：

- **它产出的是自己的 scene JSON，不是"锚定在某个文档上的批注"。** 没有"这笔画在 PDF 第 3 页哪个句子旁"的概念，与本项目 `ContentReference` / 图元锚定 / 引文锚定这条链路对不齐。
- **体量与依赖**：44.6 MB unpacked、31 个依赖，且自带一整套 UI 与主题，会与现有 Tailwind/shadcn + i18n 体系并行存在两套交互语言。
- **它是白板，不是批注器**：无限画布 + 图形库的交互范式，与截图那种"贴着文档画"的工具条范式不同。

**判定**：若需求是"给智能体一块能画图的白板"（自由绘制、无文档锚定），嵌入 Excalidraw 是最短路径；若需求是"在文档/图上批注并把批注交给智能体"，自研更贴合且更轻。本项目截图所示的正是后者。

### 2.4 PDF 面：pdf.js 已在依赖里，且自带批注编辑器层

`mozilla/pdf.js` 53950 star、Apache-2.0；本项目已依赖 `pdfjs-dist@^6.2.108`（npm 最新 6.3.289，周下载 31.9M）。

实测 `pdfjs-dist@6.2.108` 的 `web/pdf_viewer.mjs` 已导出 `AnnotationEditorLayer` / `AnnotationEditorType` / `AnnotationEditorUIManager` / `PDFViewer`；其 `src/display/editor/` 目录含 `highlight.js` / `underline` / `freetext.js` / `ink.js` / `stamp.js` / `signature.js` / `comment.js`。即**"高亮 / 自由文本 / 墨迹 / 图章 / 签名"这套批注编辑能力是现成的**，且 Apache-2.0 完全兼容 AGPL-3.0 项目。

两条落地路线：

- **A. 接 pdf.js 内置 `AnnotationEditorLayer`**：省掉"PDF 批注绘制"的实现；但该层与 pdf.js 自带的 `PDFViewer` / `PDFPageView` 组件、自带工具条与 CSS、`AnnotationStorage` 状态强耦合。本项目是**自建**查看器（`PdfPage` / `PdfToolbar` 均自研，只借了 `pdfjs-dist/legacy/web/pdf_viewer.css`），接入意味着要么迁到 pdf.js 的查看器组件（顶掉现有工具条 / 缩略图 / 大纲 / 搜索 / 选区引用），要么只摘编辑器类并自行接状态——前者影响面大，后者收益被摊薄。
- **B. 自研 SVG 覆盖层，压在同一套 `TextLayer` 上**：与现有 `FigureAnnotator` 的 `AnnotatorCanvas` 同构，复用全部交互与工具条；且能直接把命中文本层 span 转成**既有 `TextContentReference` 的引文 + 矩形锚点**。渲染审阅图时再复用 `composeReviewSvg` / `rasterizePng`。

**判定：B 为主（一致性 + 复用最大），A 留作后续"导出带真批注的 PDF"**——pdf.js 的 `saveDocument()` + `AnnotationStorage` 是把批注写回 PDF 文件的原生路径，比引入停更的 `pdf-lib` 更稳。

### 2.5 图片面：不存在"开箱即合规且带锚定"的库

图片标注库生态普遍偏"训练数据标注"（label-studio / Annotorious / LabelMe）或"医疗影像"（cornerstone），不是"贴着已有图批注并交给 LLM"。`Annotorious`（BSD-3，8.7k 周下载）虽是 W3C Web Annotation 模型的正统实现，但只覆盖图片、且不提供 PDF/Office 面。

结论：**图片面自研**，成本主要落在"重画一套画布"，而该画布本项目已有。

### 2.6 可借鉴的两件事

1. **perfect-freehand**（MIT / 0 依赖 / 0.11 MB / 3.0M 周下载）：把采样点渲染成压感平滑笔迹，替换当前 `pen` 的多段线。低风险可选增强。
2. **Zotero reader 的存储取舍**：批注存库、需要时才写回 PDF。与本项目"批注写 sidecar、不动原文件"的既有纪律同构，可作为对外说法的支撑。**注意**：`zotero/reader` 的 GitHub 许可证标注为 `Other`（非标准 SPDX），复用其代码前必须另行核实，本方案仅作 UX 参考。

## 三、架构方案

### 3.1 核心思路：把"标注"与"被标注的面"解耦（已落地形状）

原本 `figure-annotator/` 把两类关注点熔在一起：**通用标注内核**（标记模型 / 画布 / 工具条 / 撤销重做 / 落盘 / 提交）与 **SVG 专有的图面装配**（内联 SVG、shadow root、图元命中、sanitize）。落地后的目录：

```
ui/src/components/annotation/            ← 面无关内核（原 figure-annotator/）
  constants/annotator.ts                 工具/颜色/上限 + isSvgPath（面选择）
  surfaces/types.ts                      AnnotatableSurface 契约 + referenceSurfaceOf
  hooks/useAnnotatorState.ts             编辑状态与撤销栈
  hooks/useAnnotationSubmit.ts           两条出口（仅保存 / 保存并提交）
  hooks/useSavedAnnotation.ts            读回 + 失配判定
  hooks/useSvgFigureSource.ts            SVG 面：解析 + sanitize + 固有尺寸 + 哈希
  hooks/useRasterSource.ts               栅格面：解码 + 自然尺寸 + data URL + 哈希
  utils/svg-hit-test.ts                  SVG 专有：sanitize 与图元命中（原 figure-dom.ts）
  utils/{render,export,sidecar,regionReference,shortcut}.ts
  view/{Annotator,AnnotatorCanvas,AnnotatorToolbar,AnnotationSidePanel}.tsx
```

面契约（实际实现，比最初的草案更小——草案里的 `units` / `mountMarksHost` / `renderReview` / `discipline` 都没有成为独立成员）：

```ts
export type AnnotatableSurface = {
  /** 面种类（进标注文档的 target.kind）。 */
  kind: AnnotationTargetKind;          // "figure-svg" | "image"
  /** 面固有尺寸，标注坐标的参照系。 */
  size: SurfaceSize;
  /** 审阅图底层：SVG 面是 sanitize 过的整棵图，栅格面是一条 <image href="data:…">。 */
  reviewMarkup: string;
  /** 锚定命中；栅格面没有图元层，缺省。 */
  hitTest?: SurfaceHitTest;
};
```

三处刻意的收窄：

- **`renderReview` 不需要成为面成员**——审阅图统一由 `composeReviewSvg({markup,width,height}, marks)` 合成，面只负责给出 `reviewMarkup`，"屏上看到的"与"发出去的"因此同源。
- **`discipline`（提示块纪律）不放在面上**——纪律由引用载荷的 `target.kind` 决定（`contentReference.ts`），放两处必然漂移。
- **锚定靠注入而非继承**：`AnnotatorCanvas` 不再 import 命中函数，而是接收 `hitTest`；这是"新增一种介质不必碰画布"的关键切口。

### 3.2 坐标不变式（推广）

现有不变式是"标记坐标恒为**图面像素**，与缩放、面板宽度无关"。推广为：

> **标记坐标恒在被标注面自身的固有坐标系内**——SVG 图用 `viewBox` 像素，栅格图用自然像素，PDF 页用 **PDF 点**（`PageViewport.convertToPdfPoint`），一律与屏幕缩放、窗口尺寸、面板宽度无关。

这条推广是必要的：PDF 页可缩放重渲染，像素坐标会随缩放失效；PDF 点（配合页盒）才是稳定参照。它也保留了原不变式的好处——"图被重画后坐标是否失准"仍是可判定的问题。

### 3.3 数据契约：sidecar v2（已落地形状）

`ui/src/types/annotationReference.ts`，`ANNOTATION_DOCUMENT_VERSION = 2`：

```jsonc
{
  "version": 2,
  "target": {
    "kind": "image",                      // figure-svg | image（PDF 阶段新增 "pdf"）
    "path": "/abs/.../页面截图.png",
    "relativePath": "/abs/.../页面截图.png",
    "mediaType": "image/png",
    "sha256": "…", "hashAlgo": "sha256",  // 识别"文件已被换过"
    "width": 1172, "height": 461          // 面固有尺寸（SVG 图 viewBox 像素 / 栅格图自然像素）
  },
  "marks": [
    {
      "id": "m1", "kind": "arrow", "color": "#e03131",
      "points": [[293, 115.3], [703.2, 253.6]],
      "text": "这一处技术路线与说明书不一致",
      "targetFingerprint": "sha256:c54d…"  // 逐条基线：这一条画在哪一版上（v1 里叫 figureFingerprint）
      // 栅格图上没有 anchor：位图没有图元层，定位只能靠坐标 + 用户说明
    }
  ],
  "createdAt": "…", "updatedAt": "…", "summary": "…"
}
```

**读旧写新**：v1（`version: 1`，`figure` + 逐条 `figureFingerprint`）在读取时迁移，不主动重写磁盘。迁移要容忍两类真实数据：v1 的 `relativePath` 在姊妹项目插件写下的 sidecar 里**不存在**（只有绝对 `path`），此时按 `path` 兜底——否则用户工作区里的既有标注会整体判废、静默消失。

**磁盘上的位置**：v2 写入 `<文件名含扩展名>.annot.json`（`图3.svg.annot.json`、`图3.png.annot.json`），读回按「带扩展名 → v1 主名（`图3.annot.json`）」顺序找，且**只接受文档确实指向当前文件的那一份**（判据：目标文件名，含扩展名，大小写不敏感）。v1 只管主名，同目录的 `图3.svg` 与 `图3.png` 会共用一份文件——接管图片后这会变成"读到邻居的标注 + 保存覆盖邻居的标注"，所以主名形态只作只读回退、不再作为写入位置。审阅图附件名同理带扩展名（`图3.svg.annotated.png`）。

**PDF 阶段才加入的字段（现在不加）**：多页承载的 `target.units[]` 与每条标记的 `unitId`、锚定的判别式（`element` 用于 SVG 图元 / `text` 用于 PDF 文本层引文）。它们只在 PDF 面有生产者，现在加入就是无人消费的死字段；届时作为 v2 的**可选字段扩展**加入，不必再升版本。

### 3.4 发送到对话：复用既有通路，只扩判别式取值

`ContentReference` 现有 4 个变体（text / cells / region / annotation），`ContentReferenceSurface = "document" | "page" | "slide" | "sheet" | "editor" | "figure"`。

**不新增 `selectionMode`，只拓宽 `annotation` 变体的 `locator.surface`**（新增 `"image"`，PDF 用既有的 `"page"` + `pageNumbers[]`），把改动面压到最小——`isContentReference` 的分支数不变，`ADD_CONTENT_REFERENCE_EVENT` 的消费者不变。

`formatContentReferencePromptBlock` 需要一处**语义修正**：它当前把"改生成源、别改导出图"这条附图专有纪律写死在 annotation 分支里（`contentReference.ts:565-577`、`622-628`）。推广后纪律必须按面给出，否则模型会试图去"修改"一张没有生成源的 PNG：

| 面 | 纪律（写入提示块） |
|---|---|
| `figure-svg` | 改生成源（FigureSpec / 脚本），不改导出图；改完复核坐标（沿用原文） |
| `image` | 此图**没有生成源**；把标注当作对该图的批注/提问，不要声称已修改位图 |
| `pdf` / `office-page` | 批注锚定到页码 + 引文；未标注处不动；需要改的是被引用的源文档 |

多承载面（PDF 多页）的发送策略：**每页一张审阅图，上限 3 页**（避免烧上下文），超出部分只在文本清单里列出页码与说明。这是对现有 `reviewScale`（长边 ≤ 2400px）的同类约束。

### 3.5 分阶段实施（状态为 2026-09-28 实际进度）

**阶段 0 — 内核抽取（✅ 已落地，无用户可见变化）**
把 `figure-annotator` 中面无关的部分迁到 `ui/src/components/annotation/`，SVG 专有部分收进 `surfaces/svg-figure.ts`。验收：现有 `figure-annotator` 测试全绿、行为零变化（含"仅保存不做光栅化""读回竞态不覆盖已画内容""点击命中不取消选中"三条既有回归）。

**阶段 1 — 图片族单入口 + 栅格面（✅ 已落地）**
`ImagePreview` 增加"标注"入口（与既有"区域引用"并列，两者互斥切换）。锚定：无（栅格无图元层）。所以**编号清单 + sidecar 必须是完整信息源**——这一条在现有决策记录里已有实测教训（模型无图像输入时靠清单完成核验）。验收（已在浏览器端到端跑通）：画 → 仅保存 → 落盘 `target.kind: "image"`、无锚定；重开同一张图 → 标注载回；画 → 保存并提交 → 输入框出现标注引用芯片（条数徽标 + 摘要）。栅格面**没有锚定**，这是能力天花板而非缺陷。

**HTML 交付物（✅ 已落地 2026-10-08，方案/裁定/实测见 `docs/html-annotation-plan.md`）**
`.html` 预览升级为「查看 | 标注」双模式：标注面固定 1024×768 沙箱视口 + 注入桥接快照锚定（selector 由父页在源文件字节上复核，运行时节点不输出 selector）；不产审阅图，定位靠 selector 与坐标；相对资源经路径限定 cookie（仅可信源）；发布门控默认关闭。验收已在真实应用端到端跑通（打开 → 命中 Chart.js canvas → 仅保存 → 侧车 `kind:"html"` + `selector` → 重开载回 → 查看模式图表仍渲染）。

**阶段 2 — PDF（⬜ 未开工）**
在 `PdfPage` 上挂标记层；命中 `TextLayer` span 时生成 `anchor.kind = "text"`。多页 sidecar、多页审阅图（≤3）。验收：在第 N 页画箭头并命中一句话 → 提交 → 提示块同时含页码、引文、坐标、逐条说明；翻页/缩放后坐标不漂移。

**阶段 3 — Office 文档（⬜ 未开工）**
复用既有 `office-pdf`（LibreOffice → PDF）渲染链，继承阶段 2 的 PDF 面；`locatorQuality: "approximate"` 如实传达"定位是近似的"。

**阶段 4 — 可选增强（⬜ 未开工）**
① 导出带真批注的 PDF（pdf.js `saveDocument()` + `AnnotationStorage`，或 `pdf-lib`）；② `perfect-freehand` 笔迹平滑；③ 智能体主动请用户在文件上标注（HITL 审图）——这一条才真正需要网关协议方法（MINOR → 1.12），不在本方案范围。

### 3.6 门禁与协议影响（如实记）

| 面 | 是否触碰 | 说明 |
|---|---|---|
| 网关协议 | ❌ 不触碰 | 落盘走既有 `PUT /api/projects/:name/file`，发送走既有内容引用事件 |
| `AgentEvent` / gateway frames | ❌ 不触碰 | 无新事件，`pnpm check:event-matrix` 无变化 |
| 工具 `inputSchema` | ❌ 不触碰 | 无新工具，**无需重录 llm-replay fixture** |
| 技术债基线 | ✅ 触碰 | 新增 UI 源码改变文件数/行数，同 PR 跑 `pnpm measure:update` |
| i18n | ✅ 触碰 | 新文案进 `codeEditor`（或新命名空间），en + zh-CN 同键 |
| 决策记录 | ✅ 触碰 | `docs/notes/proposed/2026-09-28-universal-annotation-surfaces.md` |

## 四、风险

1. **`contentReference.ts` 是共享契约**（chat 渲染、提示块、附件序列化、引用芯片都读它）。拓宽 `surface` 与 `annotation` 变体必须配 `contentReference.spec.ts` 的往返（serialize → parse → 校验）用例，否则会以"某条引用在历史消息里反解不出来"的形式在远端暴露。
2. **提示块纪律是安全面**：若沿用附图专有纪律去描述一张 PNG，模型可能回报"已修改该图"，而实际位图未变——这是**可观测的错觉输出**，比不标注更危险。
3. **PDF 坐标换算易错**：页旋转（`rotation`）、`CropBox` ≠ `MediaBox`、非整数缩放都会让"点 → PDF 点"偏移。必须以页盒 + 旋转角度为输入做确定性换算并单测，不能只用 `scale` 反除。
4. **多页标注的上下文成本**：无上限地给每页发审阅图会烧穿上下文，必须设页数上限并显式告知模型"只附了前 N 页"。
5. **栅格图无锚定**是能力天花板，不是 bug；产品文案需要用户知道"这类标注靠坐标 + 你的文字说明定位"。
6. **测试陷阱**：`.gitignore` 忽略 `*.test.ts`。新增 UI 测试用 `*.test.tsx` / `*.spec.ts`（不在忽略范围）；若确需 `*.test.ts` 必须 `git add -f` 并按纪律先跑 `pnpm measure:update`。

## 五、已决事项（2026-09-28 用户裁定）

1. **图片面接管 → 必须避免出现两个入口。** 落地方式：**删除** `ImagePreview`，**不**在它上面另挂一个「标注」按钮。图片族全体（`.svg` + 栅格）统一进标注面板，原 `ImagePreview` 的区域引用能力改为面板工具条内的「区域引用」模式。**结果：同一文件类型上只有一个入口。**
2. **PDF 走自研覆盖层**（本方案推荐项 B），不接 pdf.js 内置 `AnnotationEditorLayer`；后者保留为阶段 4"导出带真批注的 PDF"的路径。
3. **接受 sidecar 升 v2**（读旧写新、不主动重写磁盘）。字段取舍见 §3.3：`units` / `unitId` / 锚定判别式留到 PDF 阶段作为 v2 的可选扩展，现在不加死字段。
