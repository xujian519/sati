# Agent Note: 附图区域引用入口（并修好四条通路共用的截图引擎）

Status: implemented

## Problem

`FigureAnnotator` 接管 `.svg` 预览后，原先由 `ImagePreview` 提供的「框选一块发给智能体」随之消失（2026-09-28 面板决策记录已把它登记为代价，并给出处置方向：在工具条里显式给出出口）。issue #574 要求把它补回来。

补的过程里撞上一件更严重的事：**区域引用这条通路本来就整条不通**——覆盖层点「添加到对话」后报「区域截图失败」，引用从不进 composer。根因不在任何一个预览：`RegionSelectionOverlay` 的 `captureTargetRegion` 用 `html2canvas` 截图，而 html2canvas 1.4 **不认识 `oklch()`**；Tailwind CSS 4 输出的正是 `oklch()`，截图目标又会**继承**祖先的 `color`（oklch），于是克隆树一解析颜色就抛 `unsupported color function "oklch"`。栅格图 / PDF / 表格 / 附图四条通路同时中招（issue #576）。

对照实验确认这是既有缺陷而非本 PR 引入：**未改动的** `ImagePreview` 区域通路以同样方式失败；直调 html2canvas 对同一 `<img>` 报同样的错。

## Decision

**入口**：`FigureAnnotator` 增加「区域引用」模式（工具条按钮，与标注并列的第二条引用入口）。

- 进入后图面改用普通 `<img>`（blob object URL）呈现。这不是随手选的形态：共享的选区捕获走 html2canvas，而 html2canvas **不认 shadow root**（内联图在 shadow 里），必须切到非 shadow 渲染才截得到像素——`ImagePreview` 用的正是这条通路。
- 绘制覆盖层同时卸载：同一块画布上两套选区手势会互抢指针，这是当初接管时明确要避开的形态。
- 复用既有 `RegionSelectionOverlay` 与 region 引用契约，组装抽成纯函数 `buildFigureRegionReference`（便于单测）。`region` 校验器的落点面白名单加上 `figure`——`ContentReferenceSurface` 本就含它、标注引用已在用，region 的白名单此前独漏。

**共享截图引擎**（一处修四条通路）：给 html2canvas 传 `foreignObjectRendering: true`，让**浏览器**渲染克隆树（SVG foreignObject），绕开 html2canvas 自带的逐样式渲染器与其颜色解析。实测：含 `oklch()` 的子树在该模式下正常出图，默认模式下报错；应用里的 `<img>` 同样从报错转为出图。该模式下库还会一并打开 `inlineImages` 与 `copyStyles`（图片内联后不会被画布污染）。

## Alternatives considered

- **自定义捕获：把已 sanitize 的图自己光栅化再裁矩形**（复用 `composeReviewSvg` + `rasterizePng`）— 落选。保真度更好，但要给共享覆盖层加一个 capture 注入点、或在面板里重写一套选区覆盖层；而它**只修附图一条路**，栅格图 / PDF / 表格仍然全断。`foreignObjectRendering` 是一行且四条一起好。
- **截图期间把目标元素的继承色钉成显式 hex（再还原）** — 落选（作为唯一手段）。实测可行，但只对"目标自身"有效：子树里自带 `oklch` 的元素（表格单元格、渐变、边框、阴影）仍会炸，得逐个属性、逐层元素地改写颜色，是把库的缺陷搬进业务代码且修不全。
- **换掉 html2canvas（改用浏览器原生截图或另一套渲染器）** — 落选（本阶段）。那是重写捕获引擎的量级，超出 #574 的范围；`foreignObjectRendering` 已经在"交给浏览器渲染"这条正确的路上。
- **让 Tailwind 配置避开 oklch（改用 hex/rgb 主题色）** — 落选。为一个第三方库的解析能力去改全局配色体系，代价与影响面都大得多。
- **region 引用继续用 `surface: "page"`（照 `ImagePreview` 对普通图片的做法）** — 落选。附图不是"页"，而 `ContentReferenceSurface` 里本来就有 `figure`；放开白名单只多一行加一个断言。
- **把 `<img>` + 覆盖层那段抽成共享组件，顺手改造 `ImagePreview`** — 落选（本阶段）。那段当时只有两个使用点且 `ImagePreview` 无测试覆盖，抽公共组件会平白扩大回归面；待第三个使用点出现再抽（rule of three）。
- **只恢复入口、不修截图引擎** — 落选。那样 #574 的验收（框选一块并作为区域引用加入 composer）根本达不成：入口接好了，最后一步仍然报错。

## Consequences

- **正向**：`.svg` 既有逐条标注，又恢复「框选一块」；四条区域引用通路（栅格图 / PDF / 表格 / 附图）的截图同时被修好。
- **浏览器端到端实测**（`SATI_HOME` 隔离实例）：附图区域模式——进入后普通 `<img>` 顶上、绘制覆盖层卸载，框选 → 「添加到对话」→ composer 出现 `SVG | "框选区域"` 芯片，派发出的提示块是 `1. REGION reference` + `Source: …/pct-fig.svg` + `Location: {"surface":"figure","rect":…}` + 图片附件（762×458），`Reference JSON` 里 `dataUrl` 已剥离；栅格图 `scan.png` 走既有 `ImagePreview` 通路同样从「区域截图失败」变为正常出芯片；同一条消息里没有标注引用时，通用行不含例外分句（#569 的分派未受影响）。
- **未验**：PDF / 表格两条通路的区域引用（隔离工作区里没有可用的 PDF 与表格文件），改由「四条通路共用同一个 `captureTargetRegion`」+ 直调 html2canvas 的对照实验支撑。
- **如实记的残留风险**：① `foreignObjectRendering` 依赖浏览器支持 SVG foreignObject（Chrome / Firefox / 现代 Safari 支持；库在此模式下不再内部回退）；② 跨域图片会让画布被污染——应用内预览用的是 blob/data URL，不受影响，但这条约束随引擎一起被继承；③ 附表 `regionCaptureOptions` 的单测只锁"开关还在"，锁不住浏览器行为。
- **门禁联动**：未触工具 `inputSchema` / `AgentEvent` / 网关协议；region 引用载荷形状未变（只是白名单多一个取值），旧引用照常解析。新增文案进 `codeEditor.figureAnnotator`（en + zh-CN 同键）。
- 关联：issue #574（入口）、issue #576（oklch 截图缺陷，本 PR 一并修）。
