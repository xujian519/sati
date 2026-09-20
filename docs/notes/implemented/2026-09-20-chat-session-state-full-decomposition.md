# Agent Note: useChatSessionState 全量分解（issue #467 / PR #475 收官）

Status: implemented

## Problem

`ui/src/components/chat/hooks/useChatSessionState.ts` 的主 hook 在 #466（PR #466）之后仍有
**708 行**（god 阈值 300），而且那一刀把债搬走了一部分：拆出的
`useChatPaginationScroll` 自身 **326 行**，同样超阈值。issue #467 记录了实测口径更正——
原登记的「会话加载 / 搜索定位 / token 统计三族」不成立（token 统计外置只搬得走约 30 行，
阈值 300 下不改变性质），实际可拆的是**两族**，且搜索定位与会话加载同受分页 hook 的反向耦合
（搜索定位消费分页 hook 的 7 个返回值，而分页读它的 `searchScrollActiveRef`），必须同刀搬迁。

它是聊天主链路的顶层状态聚合点，`ChatInterfaceV2` 直接解构其返回对象（**39 键、键序固定**）。
god function 使 review 只能看 diff 局部，跨 effect 的时序不变式容易在无意中被改变，而这类变化
类型检查与既有测试都拦不住。

## Decision

主 hook 708 → **245 行**，`useChatPaginationScroll` 326 → **288 行**，全部相关函数都在阈值以下。
切分落在「调用点即语义」的真实接缝上，共 7 个子 hook（新增 8 个文件，含 1 个共享常量模块）：

| 文件 | 持有 | 调用点为什么在这里 |
|---|---|---|
| `use-chat-session-identity.ts`（101 行） | `currentSessionId` state + 渲染期镜像块 + `activeSessionId` / `activeScrollKey` / `sessionIsReadOnly` / `sessionRequestParams` | 一切派生都依赖它，必须最先 |
| `use-chat-transcript-view.ts`（275 行文件，hook 约 90 行） | store → 渲染消息的投影、`viewHiddenCount`、`addMessage` / `clearMessages` / `rewindMessages`，以及配套纯函数（`chatMessageToNormalized` / `hasEquivalentUserMessage` / `shouldRenderPendingBubble`） | 在「乐观气泡 flush」之后读同一个 store，且分页 hook 需要它产出的 `chatMessages` |
| `use-chat-load-all.ts`（hook 132 行） | `allMessagesLoaded`(+ref) / `isLoadingAllMessages` / `loadAllJustFinished` / `showLoadAllOverlay` / 定时器 / `loadAllMessages` / `scrollToBottomAndReset` / `resetLoadAll` | 在分页 hook **内部**调用：`allMessagesLoadedRef` 给 `handleScroll` 当「已全量就不再分页」判据，`resetPagination` 末尾调 `resetLoadAll()` —— 依赖方向单向，无参数环 |
| `use-chat-session-lifecycle.ts`（hook 229 行） | 会话加载 effect（147 行）+ 外部消息刷新 effect + `lastLoadedSessionKeyRef` / `didLoadedSessionChange` | 紧跟分页 hook 的 5 条 effect |
| `use-chat-search-navigation.ts`（hook 145 行） | 搜索目标读取 / 交班标记复位 / 跳转与高亮三条 effect | 夹在会话加载与 token 用量之间（原顺序如此） |
| `use-chat-token-usage.ts`（hook 约 45 行） | token 用量 effect | 台账判它「不成族」；单列调用点只为保住 effect 顺序（原顺序里它在搜索定位之后、锚定之前） |
| `use-chat-processing-status.ts`（hook 约 85 行） | `processingSessions` ⇒ `isLoading` / `canAbortSession`、`check-session-status` 兜底轮询、「没有更多消息收起遮罩」 | 三条紧接滚动锚定之后 |

父 hook 保留：`sessionStore` 绑定（`setActiveSession`）、`pendingUserMessage` 与其 flush 块、
`buildFetchParams`、`searchScrollActiveRef`、`createDiff`、以及跨族共享的 setter 传递。
渲染期次序不变量「`setActiveSession` → 乐观气泡 flush → store 读取与消息投影」**整条留在父 hook 原位**，
未被拆断。

**为什么必须分这么多个调用点**：拆分前 17 条 effect 的展开顺序有语义（`pendingInitialScrollRef`
与 `searchScrollActiveRef` 的读写次序决定首屏是否落到底、搜索跳转会不会被抢滚动、锚定快照取哪一版），
而 hook 内的 effect 只能整体插入。父 hook 的调用点次序因此固定为：
身份 → （store 绑定 / 气泡 flush）→ 消息视图 → 分页（内嵌全量加载）→ 会话生命周期 →
搜索定位 → token 用量 → 锚定 → 处理中状态。

**单一真源**：`currentSessionId`、`allMessagesLoadedRef`、`searchScrollActiveRef`、`sessionStore` 各只有一份；
子 hook 不各自 `useState` 一份（那是 `useSessionStore` 那条「多份 store ⇒ 28 方法静默失效」教训的翻版）。
窗口取值 `MESSAGES_PER_PAGE` / `INITIAL_VISIBLE_MESSAGES` 抽到 `chat-pagination-window.ts` 由两个 hook 共用，
以免它们互相 import 成环；分页 hook 保留同路径 re-export。

## Alternatives considered

- **按 issue 建议的最小两刀（子 hook 压到 300 以下 + 只搬搜索定位与会话加载）** — 会让主 hook 停在约 444 行，
  仍是 god function，issue 只能部分还债，还得再开一轮同样危险的会话。既然搬迁的验证成本主要由
  「等价性证明 + 回归网」承担（一次建立、多刀复用），一次做到位更省。
- **只把 effect 体抽成模块级函数（不新建 hook）** — 能不增文件地缩行数，但每个 effect 要传 15–30 个参数进去，
  可读性反而更差，且掩盖了「这段逻辑属于哪个关注点」。债务是**可维护性**，不是行数本身。
- **把 `loadAllMessages` 并进 `use-chat-session-lifecycle`（都是「加载」语义）** — 会造成跨 hook 环：
  分页 hook 要 `allMessagesLoadedRef`（handleScroll 判据）与 `resetLoadAll`（复位），而全量加载要分页的
  7 个 ref/setter。嵌进分页 hook 内部是唯一单向的落法。
- **把 token 用量并进会话生命周期 hook** — 会把它的 effect 提前到搜索定位之前，破坏 17 条 effect 的索引对应；
  单列一个调用点更便宜。
- **父 hook 继续解构分页返回面（42 行）** — 拆到第 7 步时父 hook 逼近阈值；改成 `pagination.xxx` 成员访问后
  省下这 42 行，返回对象的键与键序不受影响。
- **顺手修 load-all 的「请求在途切会话不丢弃结果」缺陷（陈旧闭包）** — 只做搬迁的波次里混入行为变更，
  等价性证明就失效了。按 #468 的先例**单独登记**（见 Consequences），本波只把它固化成判据（另立 issue #476）。

## Consequences

- 规模：`useChatSessionState` 708 → **245**；`useChatPaginationScroll` 326 → **288**；新增 7 个 hook 全部 < 300。
  `docs/technical-debt/metrics.md` 的 god function 表里两条相关登记消失（`pnpm measure:update` 刷新）。
- **对外 API 零变化**：返回对象 39 键、键序逐项一致（新增用例断言）；`ChatInterfaceV2` 未改动。
  纯函数 `didLoadedSessionChange` / `hasEquivalentUserMessage` / `shouldRenderPendingBubble` /
  `isScrollNearBottom` / `resolveConversationScrollTop` / `BOTTOM_FOLLOW_THRESHOLD_PX` 迁出后主文件
  保留同路径 re-export，既有单元测试导入不变。
- **effect 顺序机器判据**：临时插桩（记录每次 `useEffect`/`useLayoutEffect` 回调源码指纹，归一化 Vite SSR
  的导入编号与导入包装后比对）在 `origin/main` 与本分支各跑一次，**17/17 指纹与顺序完全一致**
  （形态 `E L L L E ×13`，三条 layout effect 位置不变）。临时插桩件跑完即删、不入库。
- **逐 token 等价性**（对 `origin/main`，按搬迁段比对）：matched 44/44、293/293、39/39、12/12（分页 → 全量加载）；
  33/33、79/79、29/29、566/566（搜索定位）；543/543、122/122、143/143、27/27（会话生命周期 + token 用量）；
  278/278（处理中状态）；216/216、21/21、45/45、347/347、38/38、451/451、315/315（身份 + 消息视图）。
  白名单外新增 token 为 0；白名单内容只有三类且逐条有理由：**新增的依赖项标识符**（ref / useState setter /
  稳定 `useCallback`，身份恒定 ⇒ 重跑时机不变）、**新增依赖项的逗号分隔符**、以及包一层的新函数壳
  （`resetLoadAll` 的 `const … = useCallback`）。
- **回归网**：新增 5 份用例共 40 条（`session-lifecycle` 17 / `search-navigation` 6 / `processing-status` 6 /
  `load-all` 4 / `equivalence` 2 + 返回面契约），全部在**搬迁前写好并对未改动的实现跑绿**，搬迁后零改动仍绿；
  既有 18 条黑盒用例零回归；UI 全量 **144 文件 / 971 用例**绿。
- **A/B 等价快照**：`useChatSessionState.equivalence.spec.ts` 在 6 个检查点（装载 → 加载更多 → 实时消息与上滑 →
  外部刷新 → read-only 会话 → 切回原会话）拍返回面快照，`origin/main` 基线与本分支**逐项一致**；
  负控制（把 `INITIAL_VISIBLE_MESSAGES` 由 100 改成 90）能立刻让快照出现差异 ⇒ 判据有牙齿。
- **浏览器验证（真实本地栈 `pnpm dev` + 真实项目/会话数据）**：桌面默认视口打开 280 条消息的会话 →
  点「加载全部消息」→「显示最近 100 / 280 条消息」消失；切到另一会话再切回 → 该标签**重新出现**
  （`resetPagination` 复位生效）；会话内搜索（⌘F）输入命中词 → 高亮出现（消息投影响应）；
  上下文用量指示器显示「已使用 26% / 已用 421k / 1.6M tokens」（token 用量 effect 生效）；
  全程与移动 390×844（CDP 设备模拟，输入框在视口内、无横向溢出）**控制台零 error / 零 unhandledrejection**。
  **未覆盖**：① 搜索定位 seam（`selectedSession.__searchTargetSnippet`）在当前 UI 里没有任何写入方，
  浏览器走不到，只有 jsdom 判据；② 本环境 `Page.captureScreenshot` 超时（与既往记录一致）⇒ 无截图，
  验证靠 DOM 探针而非看图；③ 分页「加载更早」在真实数据上不可达（服务端 `hasMore=false`，首屏又是全量取数），
  只有 jsdom 判据；④ 有意**未真实发送消息**（会在本机真实项目跑一轮 agent、消耗额度）；
  ⑤ 未做主题/语言双跑（无样式与文案改动）。
- **负控制**：拆分前抽检 4 处（关掉「同 key 新鲜则跳过重取」⇒ 2 红；搜索重试改 0 ⇒ 1 红；
  轮询帧语义翻转 ⇒ 1 红；去掉遮罩收起 ⇒ 1 红）。其中搜索一处首轮未变红，暴露原用例没真正覆盖重试
  （目标元素在首轮扫描前就已就位）——已改成「等首轮扫描跑过再补元素」，负控制随即变红。
- **登记的两处既有问题（非本波引入，本波不改语义；已立 issue #476）**：
  1. `loadAllMessages` 的 `if (currentSessionId !== requestSessionId) return` 读的是**调用时刻**闭包里的
     `currentSessionId`（useCallback 换新闭包只影响后续调用），因此「全量请求在途时切换会话」实际**不会**
     丢弃结果，旧会话的 `total` / `visibleMessageCount=Infinity` 会落到新会话视图上；用例按实测固化，
     修复另立 issue #476。
  2. 该丢弃分支若真被触发，`allMessagesLoadedRef` 已先置 true 且不回滚（同一处逻辑的另一半）。
- 决策记录同步：`docs/notes/implemented/2026-09-20-chat-session-state-pagination-scroll.md` 的「剩余」段
  改为指向本条；台账 `docs/technical-debt/backlog.md` 的 TD-UI-CHAT-N02 登记收官。
