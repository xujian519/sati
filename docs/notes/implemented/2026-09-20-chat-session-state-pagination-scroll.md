# Agent Note: useChatSessionState 的分页与滚动定位外置

Status: implemented

## Problem

`ui/src/components/chat/hooks/useChatSessionState.ts` 的主 hook 有 **914 行**（文件 1159 行）：
分页窗口、滚动定位、会话加载、搜索定位、token 统计、流式键全部挤在一个函数体里。台账
TD-UI-CHAT-N02 的"死状态半"（删掉恒为 false 的 `isLoadingMoreMessages`）早在 PR #440 就完成了，
剩下的"拆分半"——**分页/滚动定位抽独立 hook**——一直没做，而它恰好是与 `MessagesPaneV2`
虚拟化边界（TD-UI-CHAT-N03，PR #458 已完成）相邻的那一族。

## Decision

拆出两个 hook，主 hook **914 → 708 行**（文件 1159 → 928）：

| hook | 持有 | 为什么独立成文件 |
|---|---|---|
| `use-chat-pagination-scroll.ts`（392 行） | 分页 state（`hasMoreMessages` / `totalMessages` / `isUserScrolledUp` / `visibleMessageCount` / `allMessagesLoaded` …）+ 12 个滚动 ref + 10 个回调 + **5 条 effect（E1–E5）** | 分页窗口与滚动定位共享同一批 ref，拆开会让"加载更多后保持位置"跨模块传 6 个参数 |
| `use-chat-scroll-anchor.ts`（87 行） | **零 state/ref**，只做 E12 指标快照 / E13 跟随或高度补偿 / E14 绑定 scroll 监听 | 它必须在**另一处**调用点生效（见下） |

**为什么必须是两个 hook，而不是一个"滚动 hook"**：E5（首屏落底）要排在会话加载与搜索定位
effect **之前**（它读的 `searchScrollActiveRef` 由搜索定位 effect 置位），而 E13（跟随/高度补偿）
必须排在**之后**（同一提交里那个 effect 先置位，E13 才不会抢滚）。单一 hook 的 effect 只能整体
插在一个位置，无法同时满足两侧。调用点因此是：分页 hook 在 `chatMessages` 派生之后、会话加载
effect 之前；锚定 hook 在 `streamContentKey` 之后、E15/E16/E17 之前。改前 17 条 effect 与改后
的展开顺序**索引一一对应**（实测），三条 layout effect 仍只有三条且相对次序不变。

**单一真源**：消息数组、会话身份、`buildFetchParams`、`sessionStore`、`searchScrollActiveRef`
仍由主 hook 持有并经参数传入；两个新 hook **不各自 `useState` 一份**同样的数据——那会是
`useSessionStore` 那条教训（多份 store ⇒ 静默失效）的翻版。

## Alternatives considered

- **一个 hook 装下全部分页 + 滚动 + 锚定** — 做不到：E5 与 E13 需要排在同一个 effect 的两侧，
  单 hook 的 effect 整体插入无法表达这种夹逼顺序。
- **按"分页 / 滚动 / 锚定"拆成三个 hook** — 分页与滚动共享 12 个 ref（`scrollPositionRef`、
  `pendingScrollRestoreRef` 等），拆开要么把它们提升到主 hook（主 hook 反而更长），要么复制
  一份（多真源）。两段切分是落在真实接缝上的。
- **把消息数组也搬进分页 hook，让它自给自足** — 消息是主 hook 与 `sessionStore` 的契约面，
  搬走会让主 hook 反过来依赖子 hook 的返回，且破坏"单一真源"。
- **继续压到 god 阈值（300 行）以下** — 主 hook 剩 708 行里已不含分页/滚动逻辑，剩余是会话加载、
  搜索定位、token 统计三族；再拆要动搜索定位与 `MessagesPaneV2` 的交互，属**需要浏览器双视口
  验证**的改动（本环境 `Page.captureScreenshot` CDP 超时做不了），因此停在 708 并如实登记。
- **`resetPagination()` 换成把 `loadAllFinishedTimerRef` 也返回、E6 保留原 11 行** — 能让语句顺序
  零变化，但会把分页内部 ref 重新暴露给主 hook，耦合度反而上升。当前写法里唯一被动的
  `setViewHiddenCount(0)`（不属分页，留在主 hook）在同一同步块内只是 setState 入队，
  定时器回调插不进来，不可观测。

## Consequences

- 主 hook 914 → 708 行；文件 1159 → 928。`MESSAGES_PER_PAGE` / `INITIAL_VISIBLE_MESSAGES` /
  `BOTTOM_FOLLOW_THRESHOLD_PX` / `isScrollNearBottom` / `resolveConversationScrollTop` /
  `ScrollRestoreState` 随分页 hook 迁出，**主文件保留同路径 re-export**，既有测试与调用方
  的导入路径不变。
- **对外 API 零变化**：`useChatSessionState` 返回对象 **39 键、键序逐项一致**（独立复核）；
  调用方 `ChatInterfaceV2` 无需改动。
- **新增 15 条黑盒用例**（拆分前写、拆分后零改动仍全绿）：分页加载更多与 `hasMore` 翻转、
  **加载更多后阅读位置不变**（高度补偿）、**接近底部自动跟随**、用户上滑后不跟随、顶部加载锁
  （贴顶不解锁 / 离开 20px 解锁 / 再回顶加载第二页）、阈值 96px 双侧、切会话复位与切回恢复、
  `loadAllMessages` / `scrollToBottomAndReset`、全量后不再分页、只保留末 N 条。
  技法：jsdom 不做布局，用 `Object.defineProperty` 打 `scrollHeight/clientHeight/scrollTop`，
  并在 fetch 返回后、commit 前抬高高度来模拟"更早消息进 DOM"。
- **5 处负控制**：去掉 E2 高度补偿 ⇒ `expected 60 to be 660`；翻转 `isScrollNearBottom` 阈值 ⇒
  5 条红；翻转 `hasMore` 条件；让跟随忽略 `isUserScrolledUp`；去掉顶部加载锁的提前 `return`。
- **逐 token 等价性**：21 段搬迁 matched 1907 tokens / unmatched 0；原文件补集 21 段在主文件里
  按序逐字节出现（0 missing）；20 个新增 token run 全部落在带理由的白名单内。
- **依赖数组追加 13 个标识符**（7 个位置，eslint `exhaustive-deps`：这些 ref/setter 原在主 hook
  就地产生、规则认得出稳定，搬出后经参数传入才被报缺失）。逐个复核：10 个 `useRef` 结果、
  4 个 `useState` setter、1 个 `useCallback(…, [])` ⇒ 身份恒定 ⇒ **effect 重跑时机不变**。
- **剩余（如实登记，不阻塞本波关闭）**：主 hook 708 行仍是 god function（阈值 300）。剩余可拆的
  是会话加载、搜索定位、token 统计三族，都需要双视口浏览器验证，建议另立条目。
- 另有两处**既有**行为疑点（非本波引入，未在纯搬迁中改动）已登记为 issue #468 并完成判定：
  ① E5「首屏落底」的 `pendingInitialScrollRef` 会在"容器已挂载但消息仍为空"时被消费且不滚动；
  ② 已排队的 rAF 跟随帧不会因用户随后的上滑而取消。处置与判据见
  `docs/notes/implemented/2026-09-20-chat-scroll-follow-timing.md`（PR #469）。
