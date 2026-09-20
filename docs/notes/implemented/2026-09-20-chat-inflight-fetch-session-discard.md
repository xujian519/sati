# Agent Note: 在途取数返回时按实时会话身份丢弃（全量加载 + 分页两处）

Status: implemented

## Problem

`useChatSessionState` 系有两条取数路径会在返回后写**会话级**视图状态，而两者对「这批数据还算不算当前会话的」判断都不可靠：

- `loadAllMessages`（`hooks/use-chat-load-all.ts`）写的是 `if (currentSessionId !== requestSessionId) return;`；
- `loadOlderMessages`（`hooks/use-chat-pagination-scroll.ts`）**没有任何**会话判据，`await` 之后直接写分页状态。

`currentSessionId` 取自 useCallback **创建那一刻**的闭包：依赖变化只让**后续调用**拿到新闭包，**已经在途的那次调用**仍读旧值 —— 判据恒为「相等」。于是请求在途时切走会话，旧会话的结果照常落进新会话的视图：`allMessagesLoaded=true`、`visibleMessageCount=Infinity`、`totalMessages` 取旧会话的值；分页那半还会在新会话上排一次滚动补偿。

真实栈实测（未修复）：会话 A（280 条）点「加载全部消息」后在途、立刻切到 B（329 条），B 的「显示最近 100 / 329 条消息」整行**消失**——该行的判据是 `!hasMoreMessages && chatMessages.length > visibleMessageCount`，`visibleMessageCount=Infinity` 让它不再成立。

发现路径：#475（纯搬迁重构）为该族补黑盒用例时按「应当丢弃」写的用例实测失败，复核确认是**既有**缺陷 ⇒ 当波按实测固化行为、另立 issue #476；本轮把那条用例反向改回「应丢弃」。

## Decision

```
useChatSessionIdentity 持有实时会话身份（已有的 effectiveCurrentRef，经返回值暴露为 liveSessionIdRef）
  └─ 并导出共用判据 isFetchForOtherSession(liveSessionIdRef, requestSessionId)
       ├─ useChatPaginationScroll.loadOlderMessages：await 之后判 ⇒ 丢弃（不写分页状态、不排滚动补偿）
       └─ useChatLoadAll.loadAllMessages（经参数收到同一个 ref）：await 之后判 ⇒ 丢弃，并复归自己置位的标记
```

1. **单一真源**：实时身份不新造镜像，直接用身份 hook 已有的 `effectiveCurrentRef`——它每次渲染都在镜像分支里被刷新，语义正是「本次渲染的有效会话身份」（含「退回欢迎页即 null」与「待建会话交班窗口」两种边界）。两个取数路径经参数共用同一份 ref。
2. **判据只此一处**：`isFetchForOtherSession` 放身份 hook 模块，两条路径共用，避免各写一遍 `ref.current !== requestSessionId` 再漂移。
3. **丢弃路径复归自己置位的标记**：`loadAllMessages` 在请求前就把 `allMessagesLoadedRef` 置 true 并置起遮罩，丢弃时二者都要收回；`loadOlderMessages` 的滚动补偿排在判据之后，天然不会被排到新会话上。
4. **只改判据来源，不改取数语义**：仍然发同样的请求、仍然写同一个 store slot（slot 按 sessionId 分桶，写旧会话自己的槽是**正确**的），改的只是「返回后要不要落到视图状态上」。

## Alternatives considered

- **在分页 hook 内镜像一份实时身份**（本 PR 的第一版写法） — 落选：与身份 hook 重复维护同一语义，且把 `useChatPaginationScroll` 顶到 **308 行**、越过 300 行的 god 阈值——那正是 #467 刚还清的债（指标基线实测算出）。改回复用身份 hook 的 ref 后该函数回到阈值内，双重复断言也没多一条（focused 用例改用真实 store）。
- **只用 `currentSessionId` 的 effect 内更新替代渲染期镜像** — 落选：判据要在 promise 续体里读「此刻」的身份，effect 更新晚一拍；且身份 hook 已在渲染期维护等价物，再生一份只是重复。
- **用 `AbortController` 取消在途请求** — 落选：`SessionStore` 的 `fetchFromServer` / `fetchMore` 不接受 signal，取消要动 store 的公共取数契约（返回面、缓存与 notify 时机），改动面远大于收益；而「结果不落视图状态」已足以止血。
- **改用会话 epoch/代数判据**（`resetPagination` 时自增、返回时比 epoch） — 落选：与身份判据语义等价，却多一份需要与身份同步维护的状态；且同一会话被重新加载时 epoch 会变而身份不变，而这里要回答的正是「身份是否变了」。
- **只修 `loadAllMessages`**（严格按 issue #476 范围，分页那半另立条目） — 用户裁定一起修：同一个不变式、同一套机制，分两次落地等于让分页那半继续带着已知污染。
- **顺手让成功路径也把 `allMessagesLoadedRef` 置回 true** — 本轮不做：仅在「切走又切回同一会话、且响应在切回之后才返回」时 state 与 ref 会分叉（ref 仍为 false、state 为 true），而该场景下 `hasMoreMessages` 已被置 false、分页门不会打开，无外部可观察差异；属另一个更小的观察，不夹带进本次修复。

## Consequences

- **用例**：`useChatSessionState.load-all.spec.ts` 6 条（成功 / 取数抛错 / ③切会话丢弃 / ④退回欢迎页丢弃 / 切走又切回仍应用 / 延时复位）、`useChatSessionState.pagination-scroll.spec.ts` 16 条（新增 1 条分页在途丢弃，独立成一组以免该文件的 describe 回调越过 god 阈值）、`use-chat-load-all.spec.ts` 2 条（新文件，专盯丢弃路径的**标记复归**；用真实 store 驱动取数，不引入双重断言）。UI 全量 145 文件 / 976 用例绿（修前 144 / 971）；`pnpm check` 绿（含指标基线刷新：仅 `ui/src 文件/行数` 随新增用例文件变动，未新增 god 函数、未新增 `as unknown as`）。
- **「标记复归」为什么要单独一份 focused 用例**：那半在集成面**观察不到**——会话切换时 `resetPagination` 会把 `allMessagesLoadedRef`/遮罩一并复位，去掉回滚的实现在集成用例上照样全绿（已实测）。
- **负控制 5 处**：① 修前（判据读陈旧闭包）⇒ 2 条集成用例红；② 保留实时判据但去掉回滚 ⇒ 仅 focused 用例红、集成全绿；③ 无条件丢弃 ⇒ 4 条红（含两条「不误丢」）；④ 分页去掉判据 ⇒ 新增分页用例红；⑤ 分页路径无条件丢弃 ⇒ 3 条既有分页用例红。
- **真实栈浏览器 A/B**（给 UI 页加 3s 网络延迟制造在途窗口，A→B 同上一节）：未修复版本 B 的行消失；修复版本 B 保留「显示最近 100 / 329 条消息」。同轮回归：全量加载成功路径仍生效（该行消失、滚动高度 3426 → 7221）、全量后滚到顶不再分页、切走再切回后窗口复位回「显示最近 100 / 280」；桌面 1440×900 与移动 390×844 全程零 error / 零 unhandledrejection。
- **未覆盖**：分页取数的丢弃判据在本机真实数据上不可达（这些会话不报 `hasMore=true`，「加载更早的消息」入口不出现）⇒ 只有 jsdom 判据；移动视口下侧边栏整体隐藏、无法在 390 宽切换会话，移动端只覆盖「渲染 + 滚动 + 零报错」；本环境 `Page.captureScreenshot` 超时 ⇒ 无截图。
