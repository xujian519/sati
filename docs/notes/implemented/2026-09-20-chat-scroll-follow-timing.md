# Agent Note: 聊天滚动跟随的两处时序缺陷

Status: implemented

## Problem

`ui/src/components/chat/hooks/use-chat-pagination-scroll.ts` 里有两条异步路径，各自只在"某一刻"
动手，而此前这个 hook 的回归面全在模块级纯函数上（`isScrollNearBottom` /
`resolveConversationScrollTop` / `didLoadedSessionChange`），时序本身没有判据：

1. **首屏落底**的 `pendingInitialScrollRef` 是一次性待办，却在"容器已挂载、loading 已落定、
   `chatMessages` 仍为空"时就被消费掉——且没有滚任何东西。消息栏的滚动容器在消息为空时**就已挂载**
   （占位符渲染在容器内部，`ui/src/components/chat-v2/MessagesPaneV2.tsx` 里
   `<div ref={scrollContainerRef}>` 无条件渲染），所以这不是理论窗口：待办被消费的那一刻，
   "首屏落底"就被静默丢弃，消息真正到达时 flag 已经不在了。
2. **跟随底部的 rAF 帧**一旦调度就无条件执行 `scrollToBottom()`。用户在同一帧内上滑
   （`handleScroll` 已把上滑态置起）不会撤销它，唯一的取消路径是组件卸载。表现是流式输出期间
   上滑仍会被拽回底部。

两者都是**既有**行为（非 `#159` 拆分引入），由 `#159` CHAT-N02 的关闭结论转正登记为 issue #468。

修好 ① 之后又暴露出第三面：首屏落底那记 `setTimeout(scrollToBottom, 200ms)` 此前**从未真正排上**
（flag 在首次渲染就被消费了），① 让它第一次排上，于是它"不重检用户意图"这一点才开始起作用——
进会话后在这 200ms 内上滑，视口仍会被拽回底部。这一步由合并后的 main CI 抓到：
`useChatSessionState.pagination-scroll.spec.ts` 的「用户上滑后不再跟随」在慢环境里偶发红
（`expected 1000 to be 100`），本地与 PR CI 都因跑得快而漏过。

## Decision

1. 首屏落底改为**只在有内容可滚时消费**：`chatMessages.length === 0` 时提前 return、保留 flag，
   等消息真正到达时再落一次——那本来就是这条待办的语义。
2. 跟随帧在回调内**重检用户意图**：新增上滑态的实时副本 `isUserScrolledUpRef`，所有写入点
   （`handleScroll`、会话切换复位、外部发送消息时的重置）收敛到唯一写入口
   `trackUserScrolledUp`，使 state（渲染用）与 ref（下一帧才跑的回调用）永远同源；
   rAF 回调执行前读它，用户已上滑则跳过本次滚动。
3. 首屏落底的**延时回调**同样重检该实时副本：落底是 200ms 后才执行的，执行时刻的用户意图只能从
   ref 读，用户在这段延时里上滑了就让位。
4. 判据不依赖真实浏览器：新增
   `ui/src/components/chat/hooks/useChatSessionState.scroll-follow-timing.spec.ts`，两条用例
   分别覆盖这两条路径——① 空会话等到 loading 落定，再让首条消息落地，断言视口到底；
   ② 用只接管 rAF 的 fake timers 把帧停在"已调度、未执行"，期间上滑，再放帧，断言视口留在
   用户停的地方；
   ③ 消息到达前先上滑，让首屏落底的延时回调到期，断言视口没被它挪走。

对外返回面零变化（39 键、键序与签名逐项一致），既有 15 条分页/滚动黑盒用例零改动全绿。

## Alternatives considered

- **在 rAF 回调里改用容器几何（`isNearBottom()`）判定** — 落选：内容增长本身就让容器离底更远，
  而跟随要处理的对象正是刚刚长高的内容 ⇒ 流式输出时跟随会自我失效。这正是"无条件滚"当初存在的原因。
- **给跟随帧加一个"上滑时间窗"（时间戳 / 代数）** — 落选：真实信号已经有了（`handleScroll` 的
  `nearBottom` 判定），再发明一个无法验证的窗口阈值只是多一处需要解释的魔数。
- **让 `scheduleScrollToBottom` 直接读 state、不引入 ref** — 做不到：回调在下一帧执行，闭包里的
  上滑态是**调度那一刻**的值，答不了"这一帧里用户有没有上滑"。
- **只靠 `use-chat-scroll-anchor` 里已有的 `isUserScrolledUp` 守卫** — 落选：那条守卫只决定
  "要不要调度"，防不住"已调度、帧还没跑"的窗口，而竞态恰好落在窗口里。
- **测试侧全局 mock `requestAnimationFrame`** — 落选：store 的按帧通知合并
  （`createRafNotifyScheduler`）与跟随帧共用同一个 rAF，全局 mock 会连带阻断 store 通知
  （实测 `addMessage` 后 `chatMessages` 不增长）。改用只接管 rAF 的 fake timers
  （`toFake: ["requestAnimationFrame", "cancelAnimationFrame"]`，`setTimeout` 保持真实），
  才能把帧精确停在"已调度、未执行"。
- **不动，作为已知疑点留在台账** — 落选：① 的消费等于丢事件，② 会用程序滚动覆盖用户明确的
  滚动意图，两者都是用户可见行为；而修复不改变对外返回面。

## Consequences

- 首屏落底在其条件真正成立时才发生一次；已排队的跟随帧可被用户随后的上滑撤销。
- 上滑态多了一个必须与 state 同源的 ref；`useChatSessionState` 返回对象里的键名与签名不变，
  调用方无需改动。
- `useChatSessionState.pagination-scroll.spec.ts` 那条用例里"已在飞的帧不因用户上滑而取消，
  是既有语义"的注释随之作废并已改写；它的 `sleep` 仍保留，但只为让基线干净，不再是绕开旧语义。
- 负控制：加固前三条用例分别红在"消息到达后视口必须到底"、`expected 1000 to be 100`（跟随帧）与
  `expected 1000 to be 0`（首屏落底的延时回调）。
- 首屏落底与跟随帧现在共用同一条判据（执行前读上滑态实时副本），"程序滚动不覆盖用户滚动意图"
  成为一个可命名的规则，而不是两处各自的巧合。
- `useChatSessionState.pagination-scroll.spec.ts` 的「用户上滑后不再跟随」不再依赖"200ms 定时器从未排上"
  这个巧合：无论延时回调落在上滑之前还是之后，结果都是 100，慢环境下也稳定。
- 仍未做真实浏览器双视口验证（本环境 CDP `Page.captureScreenshot` 超时）；本判据断言的是
  "谁在什么时候写了 `scrollTop`"，不是布局结果。
- 台账 TD-UI-CHAT-N02、issue #467 登记的"跨 effect 时序不变式容易在无意中被改变"有了第一个
  可执行的回归面；该 hook 的**体积**（god function 阈值 300）仍是未还的债，见 issue #467。
