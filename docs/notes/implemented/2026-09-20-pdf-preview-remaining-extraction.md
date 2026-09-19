# Agent Note: PdfDocumentPreview 剩余三块的拆分与顺序不变式

Status: implemented

## Problem

`PdfDocumentPreview.tsx` 主组件 1064 行：加载/视口持久化、滚动跟踪、选区→引用、41 个符号的
工具条、侧栏 JSX 全挤在一个函数里。上一波（#443）已把纯函数与搜索状态机外置，但那只降了
66 行——被搬走的 110 行本来就在模块级、不计入函数长度。**压 1064 行的主力必须从函数体内搬**。

这一波的风险不在行数，而在一条**顺序不变式**：`viewStateRef` 的写入（5 个同步 effect，原
`:753-769`）必须发生在加载 effect 的读取（原 `:791-792`）**之前**。读在写之前 ⇒ 晚一帧 ⇒
切换文件时视口与页码会错误地恢复到**上一个文件**的位置。计划当时判断"**jsdom 抓不到**"。

## Decision

拆到 `ui/src/components/code-editor/view/pdf/`（14 个文件）：

```
pdf-constants.ts / pdf-types.ts / pdf-render-support.ts
hooks/use-pdf-viewport.ts        （312 行，含那条顺序不变式）
hooks/use-pdf-scroll-tracking.ts （265）
hooks/use-pdf-selection-reference.ts（228）
hooks/use-pdf-toolbar-controller.ts（158）
components/{PdfPage,PdfThumbnail,PdfOutlineTree,PdfNavigationSidebar,PdfToolbar}.tsx
components/{ToolbarPrimitives,pdf-toolbar-icon}.tsx
```

主组件 **1064 → 260 行**（文件 1723 → 305）。没到计划估的 ≈200：差额几乎全在 hook 分组选项与
侧栏 props 接线；再往下压只能把状态搬进 hook 内部，会与既有 `usePdfSearch` 形成循环依赖——
按"纯搬迁优先"停在 260。

**顺序不变式怎么守**：把 5 个同步 effect 与加载 effect **放进同一个 hook（`usePdfViewport`）内、
按原始声明顺序排列**，使"hook 调用点被挪到 effect 之前"这种错位在结构上不可能发生；跨 hook 的
全局顺序也与原文件一致（`usePdfSearch` 无 effect → viewport → selection 无 effect → scroll）。

## Alternatives considered

- **接受"jsdom 抓不到"，只靠逐 token 证明 + 人工阅读** — 不必要。本波实测**可以**抓到，用了
  两路独立证据：
  1. **运行时顺序断言**：给各 effect 打点，断言挂载期真实执行顺序（`['resize-observer', …]`）；
  2. **同批次快照断言**：把"当前页变化"与"同文件重载"压进**同一次 commit**（父组件单个 click
     处理器里既点缩略图又换 url），然后断言加载 effect 读到的快照值。
  把加载 effect 挪到 4 个字段同步 effect 之前（负控制 NC1）⇒ 两路各自报红（顺序数组不等；
  `expected '1' to be '3'`，正是"晚一帧恢复出上一个页码"）。
  注：jsdom 无布局，帧内重算总会选回第 1 页，所以断言必须落在"effect 读到的值"上而不是最终 DOM。
- **把状态搬进各 hook 内部以进一步压缩主组件** — 会与 `usePdfSearch` 形成循环依赖（搜索要读
  视口、视口要读搜索结果），且会改变 hook 调用拓扑。收益 60 行，代价是拓扑风险，不做。
- **主组件保留内联 JSX、只搬逻辑** — 317 行工具条/侧栏 JSX 是行数大头，不搬则降不到 260。
- **依赖数组逐字不变（改成文件级 eslint-disable 保住逐字相等）** — 49 处依赖是 eslint
  `exhaustive-deps` 对**从 props 传入的 ref/setter** 判缺失所致（同波 `usePdfSearch` 抽离时同口径）。
  独立复核了新增的 22 个标识符：全部是 `useRef` 结果或 `useState` setter（身份恒定 ⇒ 重跑条件
  不变），所以追加依赖**不改变**任何 effect 的重跑时机。为了"逐字相等"去关掉 lint 规则，
  换来的是一个更弱的守门人。
- **测试文件放进 `pdf/`** — 它测的是 `subcomponents/PdfDocumentPreview.tsx`，与既有同址测试
  放一起更好找；位置偏离派单时的授权路径已如实记录。

## Consequences

- 主组件 1064 → 260；新增 14 个模块（1991 行）+ 1 个测试文件（684 行 / 23 条）。
- **等价性证明**：65 个搬迁区间**逐 token 相同**；新文件 invented 16.3%（196 段，全部白名单化：
  import 重写、`export` 前缀、hook 选项面、调用点分组对象、JSX 组件替换、依赖数组追加）；
  源文件覆盖 9907/9981，**未解释丢失 0**。
- **证明脚本抓到一个真回归**：首轮搬迁漏掉 `pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl`
  与 `import "pdfjs-dist/legacy/web/pdf_viewer.css"`（pdf.js worker + textLayer 样式）——
  这类"删掉也能编译、测试也可能全绿"的丢失正是逐 token 证明要拦的。已补回，复跑覆盖归零。
- **新增 23 条测试**（既有 2 条 → 25 条）：视口快照/恢复、滚动跟踪（rAF 合并与卸载清理）、
  选区→引用（跨页 quote 与事件派发）、工具栏控制器（页码/缩放夹取与禁用态）、侧栏视图切换，
  外加两条顺序断言。
- **5 处负控制**，其中 NC5 是**诚实记负**：去掉侧栏的 `navigationMode !== "none"` 守卫后
  **无任何用例变红**——该守卫在当前实现下不可观测（加载 effect 已把 `navigationOpen` 置为
  `navigationMode !== "none"`）。它属既有代码的等价冗余，本波纯搬迁不动它，也不假装抓住。
- 未做浏览器双视口验证（本环境 `Page.captureScreenshot` CDP 超时）；本波的可视行为由
  jsdom 断言 + 逐 token 等价性覆盖，**没有**产出 A/B DOM 指纹。
- 台账 TD-UI-CHAT-N07 回填 done。
