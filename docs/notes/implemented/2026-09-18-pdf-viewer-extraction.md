# Agent Note: `PdfDocumentPreview` 拆出纯逻辑与搜索状态机（#159 N07 逻辑半边）

Status: implemented

## Problem

台账 `TD-UI-CHAT-N07` 记的是「`PdfDocumentPreview` 巨型组件（1138 行）」，建议「抽 `usePdfViewerState`，缩略图/大纲/搜索拆独立组件」。实测口径与前几项一样需要更正：**1138 是主组件的函数跨度**，文件本身 **1885 行**（`docs/technical-debt/metrics.md` 记主组件 1130 行）。

结构（动手前实测）：

| 部分 | 行数 | 说明 |
|---|---|---|
| 模块级小组件 | ~450 | `ToolbarButton`/`ToolbarLink`/`ToolbarSeparator`/`PdfThumbnail`/`PdfOutlineTree(+Item)`/`PdfPage` —— 已经拆过一轮 |
| 模块级纯函数 | ~110 | 视口数学 + 文本选区取文，**零测试覆盖** |
| 主组件：状态 | ~45 | 24 个 `useState` + 12 个 `useRef` |
| 主组件：加载/视口 | ~150 | pdfjs 加载、跨会话视图状态持久化 |
| 主组件：滚动跟踪 | ~120 | 当前页推算、强制渲染页集合、两条 RAF |
| 主组件：搜索 | ~75 | 6 个 state + 请求序号 + 竞态处理 |
| 主组件：选区→引用 | ~235 | 浮动动作条、`Range` 取页、截图区域提交 |
| 主组件：JSX | ~380 | 工具条 ~230 / 侧栏（缩略图+大纲）~87 / 视口 ~67 |

一次做完"抽 `usePdfViewerState` + 拆三个子组件"是一次 L 级改动，而且**抽成单个 hook 只是把 god function 换成 god hook**（24 个 state 搬进一个文件，读者仍要读同样多的相互纠缠逻辑）。故本轮按「粘连度切、每片都能被机器证明等价」推进，先落**逻辑半边**。

## Decision

三处改动，全部可证：

1. **纯函数 → `utils/pdfViewport.ts`（54 行）**：`clamp`/`isQuarterTurn`/`getRotatedPageSize`/`resolveActiveScale`/`parsePercentInput`/`parsePageInput` 与 `MIN_SCALE`/`MAX_SCALE`/`ZOOM_STEP`、类型 `PageSize`/`ZoomMode`/`Rotation`。
2. **文本选区取文 → `utils/pdfTextSelection.ts`（70 行）**：`normalizeText`/`buildSurroundingText`/`getOccurrenceIndex`/`getSelectedPageNumbers`/`getTextLayerText`/`getClosestElement` 与 `CONTEXT_RADIUS`。
   两个模块此前**一条测试都没有**（`utils/` 下只有 `pdfSearch.spec.ts`/`pdfOutline.spec.ts` 等），本轮补上 **22 条**直接单测（`pdfViewport.spec.ts` 10 条、`pdfTextSelection.spec.ts` 12 条）；`resolveSearchStatus` 移入既有 `utils/pdfSearch.ts` 并补 4 条分支用例。
3. **搜索状态机 → `hooks/usePdfSearch.ts`（168 行）**：6 个 state、请求序号 ref、`run`/`goTo`/`close`/`updateQuery`/`reset`/`open`。边界很干净：进 `pdfDocument` + 两个页文本缓存 ref + `jumpToPage` + `forceRenderPage` 两个回调；出状态与动作。`jumpToPage`/`forceRenderPage` 上移到状态块之后（`useCallback([])`，身份稳定），好让加载 effect 能直接调用 `reset`。

**等价性证明**：`/tmp/n07-move-proof.mjs`（parser 驱动）对 **21 段搬迁**逐 token 比对——从基线取该段代码的叶子 token，从新位置取同名函数/语句的叶子 token：

- **19 段逐字相同**（含 `runSearch` 288 tokens、`buildSurroundingText` 97、`jumpToPage` 86、加载 effect 的 7 条复位语句、JSX `onChange` 的 6 条失效语句）；
- **1 段是唯一的预期改写**：`goToSearchResult` 里两行"强制渲染"写操作 → 一次 `forceRenderPage(pageNumber)` 调用。它不是"标记一下就放过"：脚本把那两条语句从基线 token 流里摘掉、插入调用后要求**逐 token 相等**（58 tokens），并单独断言组件里新写的 `forceRenderPage` 函数体与被摘掉的两条语句**逐字相同**；
- 其余任何 token 差异都会判定失败（`goToSearchResult` 是唯一白名单，且由上面那条重建检查兜底）。

**负控制**（两处注入，都要红）：① 把 `parsePageInput` 的夹取上限 `+1` ⇒ 守卫报 `DIFF parsePageInput`、`pdfViewport.spec.ts` 2 条用例红；② 把 hook 里 `runSearch` 的 `!==` 改成 `===` ⇒ 守卫报 `DIFF runSearch`、既有 `PdfDocumentPreview.test.tsx` 的搜索竞态用例红（同文件另一条用例仍绿，说明命中是精准的）。两次都还原后全绿。

## Alternatives considered

- **一次性抽 `usePdfViewerState`（24 个 state 全进一个 hook）** —— 落选。它把 god function 变成 god hook：主组件少 600 行，但那 600 行仍在一个文件里相互纠缠；而且要把 JSX 里上百处引用改名（`zoomMode` → `viewer.zoomMode`），改名本身就是 token 变化，**token 守卫将无法证明等价**——等于用"更大的不可证 diff"换"更小的主函数"。改为按粘连度切片，每片都能逐 token 证。
- **只抽两个纯函数模块、不动 hook** —— 落选。搜索是文件里最自成体系的一块（6 个 state + 请求序号 + 竞态），边界干净得很；放着不动，主组件仍要读 1000 行以上，收益打折一半。
- **本轮顺手拆工具条 / 侧栏 JSX 成子组件** —— 落选（本轮）。工具条要搬出去得传约 35 个 prop（按搬运清单估算：缩放 5 个 + 页码 6 个 + 搜索 10 个 + 引用菜单 3 个 + 刷新/全屏/下载 6 个 + i18n 标签 5 个），属典型 prop 钻孔：读者要来回跳两个文件才能看懂一个按钮，收益低而 review 成本高。等状态先落进 hook、props 面自然收窄后再做。
- **本轮抽 `usePdfSelectionReferences`（选区→引用，~235 行，文件里最大的一块逻辑）** —— 落选（本轮）。它依赖指针事件、`Range`、浮动动作条与 `RegionSelectionOverlay` 的截图区域，是文件里**唯一必须靠浏览器验证**才能确认等价的部分；应和 `UI-CHAT-N01`/`N03`/`UI-APP-N01` 一起进 L 级窗口（那三项共享同一成本项）。
- **顺手删掉 `parsePageInput` 里的 `Math.round`**（负控制时发现：`parseInt` 已产出整数、`clamp` 又是整数边界，故对整数输入恒为 no-op） —— 落选。它是行为无关的清理，但会让守卫出现一处**无法解释**的 token 差异（而本轮的价值恰恰在于"每处差异都能解释"）；记为观察，不在本轮做。

## Consequences

- **换来**：文件 1886 → **1724** 行（metrics 口径，−162）；主组件 god function 1130 → **1064** 行（−66）；两个此前零覆盖的纯函数域有了 22 条直接单测，搜索的三个状态分支有了 4 条；搜索状态机独立成 168 行、边界是 5 个入参的 hook。
- **代价 / 口径诚实**：**god function 只降了 66 行**——因为被搬走的 110 行纯函数本来就住在模块级、不在函数计数里。真正能把 1064 压下去的是选区→引用（~235）与工具条/侧栏 JSX（~317），那两块本轮有意没碰（前者需浏览器验证、后者是 prop 钻孔）。所以 **N07 记为 `in_progress`（逻辑半边完成）**，与 N02 的记法一致。
- **指标随动**（`pnpm measure:update`）：`ui/src` 472→477 文件（3 个新源文件 + 2 个新 spec）、83706→84090 行。
- **行为不变的论证强度**：搬迁逐 token 可证（21 段，只有 1 处改写且被重建验证），加上既有 `PdfDocumentPreview.test.tsx` 的两条行为用例（搜索竞态、刷新后页码夹取）与新增 26 条单测；负控制两处已验。**仍未做**的是浏览器实机验证——本轮没有改变任何渲染路径或交互路径（只搬家 + 把两行写操作换成等价调用），故按住 UI 改动须双视口验证的惯例，把这笔成本留给 N07 剩余部分。
- **仍未处理**（N07 剩余）：选区→引用块（~235 行，需浏览器验证）、工具条/侧栏 JSX 拆分（~317 行，需先收窄 props 面）、以及"按粘连度切成多个 hook"意义上的 `usePdfViewerState`（加载/视口持久化一块、滚动跟踪一块）。
