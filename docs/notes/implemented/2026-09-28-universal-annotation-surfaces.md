# Agent Note: 标注面推广（图片族单入口 + sidecar v2）

Status: implemented

## Problem

标注能力原本只覆盖 `.svg` 附图：`figure-annotator/`（20 文件 / 3430 行）把**通用标注内核**（标记模型、画布、工具条、撤销重做、sidecar 落盘、提交 composer）与 **SVG 专有的图面装配**（内联 SVG、shadow root 隔离、图元命中、sanitize）熔在一个目录里。其余三类介质一件都拿不到：

- 栅格图片（PNG/JPEG）只有区域引用，没有"在图上画"；
- PDF 只有文本选区与区域引用，没有标记层；
- Office 走 LibreOffice → PDF 渲染，同样没有标记层。

而"图上圈画 + 逐条一句话 + 交给智能体"正是专利与检索实务里最省沟通成本的一种输入：检索报告里圈出对比文件的那一处、审查意见里指出附图标记标注错误、无效分析里框住某个技术特征。

原方案（`2026-09-28-figure-annotation-panel`）在 Alternatives 里否决过"标注器接管所有图片"，理由是"栅格图无图元锚定 + 会顶掉 `ImagePreview` 的区域引用"。**第二条理由已由同日的 `2026-09-28-figure-region-reference-entry` 消除**（工具条新增独立「区域引用」模式，两套指针手势不再互抢），因此"图片不能标注"不再是设计约束，只是尚未接线。

另一处需要显式表态的分歧：本仓对"标注"只有一种存储形态（sidecar `.annot.json`，不动原文件），而开源生态里 PDF 域的主流做法是把批注**写回 PDF 文件**（pdf.js `AnnotationStorage` / `saveDocument`、Zotero 的"需要时嵌入"）。

## Decision

**不引入白板类 SDK**（许可证或形态不合，见 Alternatives），把自研标注能力推广为「面无关内核 + 面适配器」。本期落地**图片族**与**契约 v2**；PDF/Office 面按同一契约后续接入。

**1. 单一入口：图片族全体进标注面板，`ImagePreview` 退役。** `CodeEditorBinaryFile` 的 `isImage` 分支（含 `.svg`）统一渲染 `Annotator`，原先"`.svg` 走标注器、其余图片走 `ImagePreview`"的两分法消失。用户担心的"同一文件类型两个入口"因此只可能是 `ImagePreview` 那条：它被删除，而不是被并列保留。它的**区域引用能力不丢**——改为面板工具条内的「区域引用」模式，与 SVG 面今天的做法完全一致（同一画布上两套指针手势不能并存，只能互斥切换）。`

**2. 内核与面解耦，契约是 `AnnotatableSurface`**（`ui/src/components/annotation/surfaces/types.ts`）：

```ts
type AnnotatableSurface = {
  kind: "figure-svg" | "image";   // → 标注文档的 target.kind
  size: { width; height };        // 面固有尺寸，标注坐标的参照系
  reviewMarkup: string;           // 审阅图底层：SVG 面是整棵图；栅格面是一条 <image href="data:…">
  hitTest?: SurfaceHitTest;       // 锚定命中；栅格面没有图元层，缺省
};
```

目录随之内核化：`ui/src/components/figure-annotator/` → `ui/src/components/annotation/`，SVG 专有逻辑收在 `utils/svg-hit-test.ts`（原 `figure-dom.ts`）与 `hooks/useSvgFigureSource.ts`，新增 `hooks/useRasterSource.ts`。画布不再自己 import 命中函数，而是接收注入的 `hitTest`——这是"新增一种介质不必碰画布"的关键切口。

**3. 坐标不变式推广为"面固有坐标"。** 原不变式是"标记坐标恒为图面像素，与缩放、面板宽度无关"。现在统一为：坐标恒在被标注面**自身的固有坐标系**内（SVG 图用 `viewBox`/`width` 像素，栅格图用自然像素），因此同一条标注在任何缩放与面板宽度下含义相同，"文件被换过之后坐标是否失准"也仍是可判定的问题。

**4. sidecar v2**（`ui/src/types/annotationReference.ts`，`ANNOTATION_DOCUMENT_VERSION = 2`）：v1 的 `figure` 泛化为 `target{kind, path, relativePath, mediaType, width, height, sha256, hashAlgo?}`；标记上的逐条基线字段 `figureFingerprint` 改名为 `targetFingerprint`（对栅格图而言"图"不是 figure，名字必须跟着含义走）。**读旧写新**：v1 文档读取时迁移，不主动重写磁盘，用户下一次保存才升级。

**5. 引用载荷只拓宽、不新增判别式。** `annotation` 变体的 `locator.surface` 从 `"figure"` 拓宽为 `"figure" | "image"`，**不新增 `selectionMode`**——这样 `isContentReference` 的分支数、composer 的监听、附件序列化都不变。`isContentReference` 为兼容历史消息接受 v1 文档，`normalizeContentReference` 在归一化时把内嵌文档升到 v2（否则历史消息会以"文档缺 target"的形态崩在渲染层）。

**6. 提示块纪律按面给出。** 这是本次最要紧的一处语义修正：原实现把附图的"改生成源、别改导出图"写死在 annotation 分支里。对一张**没有生成源**的 PNG 沿用该纪律，会让模型回报"已修改该图"而位图根本没变——这比不标注更危险。现在 `figure-svg` 保留原文，`image` 改为："这张图在工作区里没有生成源：把每条标注当作关于它的审阅意见，不是你可以在文件上施行的修改；按坐标与附图逐条回应，未标注处不动，且不要声称这张图本身被改过。"

**未做（本期明确不做）**：PDF 面与 Office 面。用户已裁定 PDF 走**自研覆盖层**（不接 pdf.js 内置 `AnnotationEditorLayer`，理由见 Alternatives）。契约为此预留的 `units` / `unitId`（多页承载）与锚定判别式（`element` | `text`）**尚未加入**——它们只在 PDF 阶段才被真实需要，现在加就是无人消费的死字段；届时作为 v2 的**可选字段扩展**加入，不需要再升版本。

## Alternatives considered

- **tldraw SDK（50.6k star）** — 硬性排除，不只是"不选"。其 `LICENSE.md` 原文：`Not to use the Software in Production Environments.`、`Not to disable, change, or interfere with the Software's License Key enforcement.`，并把 Production Environment 定义为包含"提供功能给终端用户/客户/公众的 web 应用"。Sati 是 AGPL-3.0 开源产品，生产使用需商业许可，且"不得以超越本许可证的许可证分发"与 AGPL 冲突。
- **嵌入 Excalidraw（MIT / 133k star / React 19 支持）** — 落选。许可证干净，但它产出**自己的 scene JSON**，没有"这笔画在文档的哪一处"的概念，与本仓的引用/锚定链路对不齐；44.6 MB unpacked、31 个依赖，还自带一整套 UI 与主题，会与现有 Tailwind/shadcn + i18n 并行存在两套交互语言。它解决的是"白板"，不是"贴着已有文件批注"。若需求变成"给智能体一块能自由画图的白板"，它才是正确选择。
- **保留 `ImagePreview` 并给它加一个「标注」按钮（两个入口并存）** — 落选，且这正是用户明确否掉的形态。同一文件类型上并列两条引用通路，用户要先判断走哪条；而两条通路的产物（区域引用 / 标注引用）本可以在一个面板里用模式切换表达。实际上"两个入口"的代价还更大：`ImagePreview` 用 `ContentReferenceMenu` 表达能力面（文本/单元格/区域 + 推荐模式），标注面板用工具条表达，两套入口的**能力提示语言**也不一致。
- **接 pdf.js 内置 `AnnotationEditorLayer`（Apache-2.0，已在依赖内）** — 本阶段落选（PDF 面尚未开工，用户裁定走自研覆盖层）。该层与 pdf.js 自带的 `PDFViewer` / `PDFPageView` 组件、自带工具条与 CSS、`AnnotationStorage` 状态强耦合；本仓的 PDF 查看器是自建的（`PdfPage` / `PdfToolbar` / 缩略图 / 大纲 / 搜索 / 选区引用都是自己的），接入等于要么迁到 pdf.js 的查看器组件（顶掉一批既有能力），要么只摘编辑器类并自行接状态（收益被摊薄）。保留为后续"导出带真批注的 PDF"的路径。
- **Annotorious（BSD-3，W3C Web Annotation 正统实现）** — 落选。只覆盖图片、不提供 PDF/Office 面，且不提供"在图上画箭头/圈选"这套与截图一致的工具条；引一个只能干四分之一的库反而增加心智模型。
- **不升 v2，只在 v1 上加可选字段** — 落选。`figure` → `target` 是**破坏性**的形状变更（旧版本客户端读不懂新文件），版本号不升就无法如实表达这件事。升版本的代价很小：单个迁移函数 + 一条兼容测试，换来"新旧读者各自都说得清自己读的是什么"。
- **给标记加 `unitId`、给锚定加判别式（一步到位为 PDF 准备）** — 本期落选。没有任何生产者会写这些字段，加了就是死代码，且会让每条栅格标注多带一个恒为空的值。留到 PDF 阶段作为可选字段扩展，不升版本。

## Consequences

- **正向**：图片族（SVG + 栅格）有了统一的"在图上圈画 → 逐条一句话 → 交给智能体"输入面，且只有**一个**入口；标注与 sidecar 的形状不再与"附图"绑死，新增介质只需实现一个 `AnnotatableSurface`。
- **实测量到的降级面**：栅格图**没有锚定**。这不是 bug 而是能力天花板——位图没有图元层，模型只能靠坐标与用户写的说明定位。因此"编号清单 + sidecar"必须始终是完整信息源（这一点在附图方案里已有实测教训：模型无图像输入时靠清单完成核验）。界面上标注清单不显示 `锚定` 后缀即是这个事实的如实反映。
- **`ImagePreview` 退役的代价**：栅格图的滚动/缩放视图由标注面板承担，面板的「查看」模式可用，但**能力提示语言变了**（从 `ContentReferenceMenu` 的下拉能力面变成工具条上的模式按钮）。区域引用本身没丢，功能等价。
- **契约边界**：`ui/src/types/contentReference.ts` 是跨模块共享契约（chat 渲染 / 提示块 / 附件序列化 / 历史消息反解 / 引用芯片）。本次只拓宽 `locator.surface` 取值与 `annotation` 变体的文档校验，未新增判别式，因此消费者无一处需要改分支；代价是**校验逻辑与归一化逻辑必须成对改**——`isContentReference` 放宽接受 v1 文档，就必须有 `normalizeContentReference` 把它升到 v2，否则"通过校验但字段形状是旧的"会漏到渲染层。
- **迁移的宽容度是一个真实教训**：浏览器端到端验证时发现，用户工作区里由姊妹项目插件写下的 v1 sidecar **没有 `relativePath`**（只有绝对 `path` 与一个 Sati 不认的 `address`），严格校验会让这份既有标注整体判废、静默消失。迁移因此改为按 `path` 兜底。这类"只在我方实现里成立的必填假设"只有拿真实数据跑才会暴露。
- **门禁联动**：不触碰网关协议、`AgentEvent`/gateway frames 与工具 `inputSchema`（**无需重录 llm-replay fixture、事件矩阵无改动**）；新增 UI 源码改变技术债基线（已同 PR `pnpm measure:update`）；i18n 命名空间由 `figureAnnotator` 改名为 `annotator`，并把用户可见文案里的"附图/figure"改为中性表述（否则对一张 PNG 会说"附图还没准备好"）。
- **测试**：契约层新增 v1 迁移用例（含"缺 relativePath"与"结构损坏必须拒绝"两条相反方向）；新增 `useRasterSource.test.tsx`（自然尺寸、data URL 包装、哈希、零尺寸判错、读失败透传、禁用时不工作）；提交钩子新增"面为栅格时引用落在 `image` 上"一条；内容引用新增"栅格标注的提示块不得出现附图纪律"与"历史消息里的 v1 文档可反解并升级"两条。UI 全量 1109 测试通过。
- **浏览器端到端验证（隔离实例 + 真实工作区文件）**：① 打开 PNG → 面板接管（不再有第二个入口）→ 画箭头 → 写说明与总体说明 → 仅保存 → 落盘 `target.kind: "image"`、**无 `anchor`**、尺寸 1172×461 与自然尺寸一致；② 关闭并重开同一张图 → 标注清单载回 1 条；③ 保存并提交给智能体 → 输入框出现标注引用芯片（含条数徽标与摘要）；④ 打开 SVG 附图 → 图内联进 shadow root、无 `<img>`，且**改动前写下的 v1 sidecar 迁移后载回 2 条**（锚定 `polygon` 保留），失配告警按新措辞显示"这个文件在上次标注之后已经更新过"；⑤ 390px 窄视口下面板与工具条按设计横向滚动（`scrollWidth` 280 > `clientWidth` 195），无溢出。
- **纪律复现**：验证期间在用户项目目录写下的 `<png>.annot.json` 已在验证结束后删除，不留测试残留。
