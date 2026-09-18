# Agent Note: 前端巨无霸议题解阻与死状态清理（#159）

Status: implemented

## Problem

`#159`（拆分前端 God Hook/组件）自建立起就挂在 `status: blocked`，触发条件写的是「**下次改动以上任一组件时顺带拆分**」。2026-09-18 复核时发现三件事，使这条触发条件既不可用、也不足以支撑决策：

1. **触发条件字面已触发，但语义没触发**：本轮 #354 的超时具名化 PR（#438）改动了六个目标文件中的 **5 个**——但每处只是把一行毫秒字面量换成常量引用（`}, 2000)` → `}, UI_TIMEOUTS.X_MS)`）。字面上"改动过"，实质上没有拿到"手在文件里、有上下文"的拆分时机。触发条件的写法本身有歧义，不能自动生效。
2. **issue 与台账引用的行数不是文件大小，且差得不少**（详见下表）。它们多数是**函数/组件跨度**（`Pdf 1138 ≈ 函数 1130`、`ImportFromFolder 854 ≈ 852`、`MessageComponent 812 ≈ 798`），唯独 `MessagesPaneV2` 明写「文件 1252 行」与实测不符（立案日已 1375）。按文件大小读，实际规模比 issue 读起来大得多。
3. **债务稳定存在、没有恶化成事故，但也没有被任何机制收敛**：2026-08-15 → 2026-09-18 六文件增长 +15% / +13% / +1% / +2% / +1.5% / +0.4%；metrics 的 God function 表里它们占 **6 席**（含 `MessagesPaneV2.render.test.tsx` 的 842 行匿名箭头）。

| 目标 | issue/台账引用 | 08-15 实测 | 09-14（立案日） | 2026-09-18 | metrics 函数行数 |
|---|---|---|---|---|---|
| `useChatComposerState.ts` | ~1430（hook 体） | 1596 | 1836 | 1837 | 1608 |
| `MessagesPaneV2.tsx` | 「文件 1252 行」 | 1375 | 1543 | 1556 | 1031 |
| `PdfDocumentPreview.tsx` | 1138 | 1860 | 1884 | 1885 | 1130 |
| `SkillsV2.tsx` | 2503 / `ImportFromFolder` 854 | 2474 | 2524 | 2525 | 852 |
| `useChatSessionState.ts` | 死状态 `:251` | 1168 | 1170 | 1185 | 940 |
| `MessageComponent.tsx` | 812 | 969 | 973 | 973 | 798（anonymous） |

## Decision

**解阻，但按"先摘确定无害的部分、再排 L 级专项"分层推进**；本轮只做其中确定性最高的一块。

### 1. 议题从 `blocked` 转为 `in-progress`，触发条件改为可证伪的形式

原触发条件（"下次改动时顺带"）在字面与语义之间有缝：它既不阻止债务（四次改动机会全部擦肩而过），也不给出排期承诺。改为**按载体分档的可执行形式**（写进 issue 与台账）：

1. **小件（S/M，随时可做）**：`UI-CHAT-N02` 的死状态清理 —— **本 PR 已完成**；
2. **中件（M，有同址测试兜底）**：`UI-CHAT-N04`（`MessageComponent` 按消息类型拆子组件）、`UI-CHAT-N07`（`PdfDocumentPreview` 抽 `usePdfViewerState` + 缩略图/大纲/搜索子组件）、`UI-CHAT-N05`（chat 与 chat-v2 的子代理渲染重复实现收敛）；
3. **L 级专项窗口**：`UI-CHAT-N01`（`useChatComposerState` 拆四个 hook）、`UI-CHAT-N03`（`MessagesPaneV2` 手写虚拟化）、`UI-APP-N01`（`SkillsV2` 的 `ImportFromFolder` 拆 feature-folder）——这三项共享同一个成本项：**双视口浏览器验证**（issue 已注明），故必须成窗口做，不能"顺带"。

### 2. 本轮实际改动：删除恒 false 的死状态 `isLoadingMoreMessages`

`useChatSessionState.ts` 里 `const [isLoadingMoreMessages] = useState(false);` —— **setter 从未被解构**，所以这个值在整个组件生命周期内恒为 `false`（这是静态可证的事实，不是抽样观察）。它却被透传到三处，其中两处是"永远不成立的门"：

- `MessagesPaneV2.tsx` 里一个「Loading older messages...」指示器：`isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded` ⇒ **从未渲染过**（该文案在 UI 里从未出现过）；
- `useChatSessionState.ts` 的「Load all」遮罩 effect：`if (wasLoading && !isLoadingMoreMessages && hasMoreMessages)`，而 `wasLoading` 取自 `prevLoadingRef.current`，其赋值来源正是这个恒 false 的值 ⇒ **该分支从未执行**（遮罩的置位另有两条真实路径：`loadAllMessages()` 与完成态 effect）。

另一处（`hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded`，即「Showing X of Y + Load earlier messages」行）**去掉恒真项后行为不变**：`X && !false ≡ X`。

改动面：**5 个文件**（含 `ui/src/constants/timeouts.ts`），删除死状态、永不渲染的指示器块、永不执行的分支与两处随它们失去消费者的**孤儿**，并把存活条件做等价化简。

**连带清出的两处孤儿**（不删则 lint 不可能绿，且留着会继续误导）：

- `MessagesPaneV2` 的 `isLoadingAllMessages` prop —— 它在 pane 里的**唯一**消费者就是那个永不渲染的指示器；删除后成为未使用参数（`--max-warnings 0` 会红）。同理收掉了 `ChatInterfaceV2` 的透传与解构。
- `loadAllOverlayTimerRef` 与 `UI_TIMEOUTS.LOAD_ALL_OVERLAY_AUTO_HIDE_MS` —— 这个"遮罩自动退场 2s"的定时器**只在那条死分支里被创建过**，因此它从未生效；ref 全仓无任何赋值点，三处 `if (ref.current) clearTimeout(...)` 都是空转。遮罩的真实退场路径是 `LOAD_ALL_FINISHED_STATE_RESET_MS` 定时器与显式 `setShowLoadAllOverlay(false)`。故删除该 ref、清掉空转清理、并从 UI 注册表移除该键（35 → 34）——同时在注册表原位留一行说明，免得后人以为是漏抄（若将来想恢复「2s 后自动退场」，那属**行为变更**，需单独立项）。

## Alternatives considered

- **维持 `blocked`** —— 落选。触发条件已四次擦肩（含本轮）；它既不收敛债务也不给排期承诺，等于把决定权交给运气。更要紧的是：**该 blocked 状态让审计者以为"有人在等时机"，而实际没有任何机制在等**。
- **一次性把 6 个载体全拆（大爆炸 PR）** —— 落选。三个 L 级项都属聊天主链路（提交/虚拟化/滚动定位），且需双视口浏览器验证；合并成一个 PR 会让 diff 无法审阅、回归无法定位。台账 §29.C 当初把它们列为"短期（P2，1-2 天/项）"是低估——单是浏览器验证矩阵就超过这个量级。
- **顺手把「Loading older messages...」指示器接上真实信号（用 `isLoadingMoreRef` 改成 state）** —— 落选，且明确记为**不做**。那是**新增可见 UI 行为**（一个从未出现过的提示行会开始出现），属功能变更而非债务清理；要做应单独立项并配 i18n/视觉验证。本轮只删死代码，不改变任何用户可见行为。
- **只删状态、保留那个永不渲染的指示器块（把条件换成 `false && …` 之类）** —— 落选。那会把"死"从数据搬到表达式里，让下一位读者以为"这里有分支、只是暂时关掉"，比删除更难判断。
- **顺带把台账里 `UI-CHAT-N02` 的"分页/滚动定位抽独立 hook"也做掉** —— 落选（本轮）。那是 L 级的另一半，与 `N03` 的虚拟化边界重叠，应同窗口做。

## Consequences

- **换来**：聊天页少一个"恒 false 的伪信号"与一个永不渲染的指示器（读者不再需要判断"这个 loading 状态什么时候为真"）；`useChatSessionState.ts` 的「Load all」遮罩 effect 从"两条分支、其中一条是死的"变成一条可读分支；`MessagesPaneV2` 少一个 prop（对外契约收窄）。
- **零行为变化**的论证是**静态**的（该状态无 setter ⇒ 恒 false；被删分支的触发条件因此永不成立；存活条件做的是 `X && !false ≡ X` 化简），不是抽样观察——这类"删除不可达代码"的改动，任何运行时用例都无法回放"它曾经不可达"。故配了两条**针对存活条件**的回归用例（还有更早消息时该行必须渲染、已全量加载时必须不渲染），负控制已验：把存活条件注入成恒假 ⇒ 用例 1 变红、用例 2 仍绿，还原后全绿。
- **付出**：`MessagesPaneV2` 的 props 面收窄属**对外接口变化**（组件是模块内私有，仓库内无其它消费者——已 grep 确认），故不需要兼容层。
- **仍未处理**（按上面的分档排期）：N01 / N03 / N04 / N05 / N07 / UI-APP-N01 六个载体，以及台账里未列进 issue 的 `TD-UI-CHAT-N08`（`CodeEditorBinaryFile` 1523 行）与 `TD-UI-APP-N02`（`useSessionStore` ~1440 行）——后两条是本次复核时发现的同族载体，已在 issue 评论里补登，避免再次出现"issue 与台账各记一份"的漂移。
- **顺带更正**：issue 与台账的行数口径（函数跨度 vs 文件大小）已在 #159 的评论里逐条更正，避免下一位读者按"1138 行的文件"估算工作量——实际是 1885 行。
