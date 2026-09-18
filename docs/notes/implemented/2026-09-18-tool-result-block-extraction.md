# Agent Note: `MessageComponent` 拆出工具结果块（#159 N04）

Status: implemented

## Problem

台账 `TD-UI-CHAT-N04` 记的是「`MessageComponent` 巨型单消息渲染器（812 行）」，建议「按消息类型拆 `MessageBubble`/`ToolResultBlock`/`PermissionBlock`」。实测口径照旧需要更正：**812 是组件的函数跨度**，文件本身立案时已 **969 行**（metrics 记该匿名箭头 794 行，是全仓靠前的 god function 之一）。

读一遍会发现"多形态"并不是均匀铺开的，而是集中在**一处**：

| 部分 | 行数 |
|---|---|
| **工具结果块**（原 `:478-751`） | **~270（占全文件 28%）** |
| user 气泡 | ~70 |
| 交互提示（interactive prompt） | ~82 |
| thinking / interrupted / compactBoundary 小块 | ~70 |
| 头部、附件、图片、复制控件等 | 其余 |

工具结果块自己又分五态：网页搜索未配置（`setup_required` + 工具名命中）/ 通用 `setup_required` / 无权限建议的可恢复错误（折叠展示）/ **权限错误**（"为本会话授予"按钮 + 待确认态 + 设置入口）/ 非错误态（交给 `ToolRenderer`）。它还有一块**只服务于自己**的状态：`permissionGrantState` 与它的复位 effect（`[permissionSuggestion?.entry, message.toolId]`）。

## Decision

把这一整块搬进新组件 `view/subcomponents/ToolResultBlock.tsx`，连同它专用的状态、复位 effect 与三个错误判定 helper；`stringifyMessageContent` 上移到 `chat/utils/messageContent.ts` 供父子共用（原先它是 `MessageComponent` 的模块级私有函数，拆完父子都要用）。

改动后 `MessageComponent` 只剩：`{message.toolResult && !shouldHideToolResult(...) && <ToolResultBlock ... />}` 这一处调用。

**等价性证明**：`/tmp/n04-move-proof.mjs`（parser 驱动，逐 token）比对 **9 项**：

| 项 | 结果 |
|---|---|
| `cleanToolUseErrorContent` / `isRecoverableToolUseError` / `isWebSearchError` | 36 / 86 / 36 tokens 逐字相同 |
| `stringifyMessageContent` 初始化表达式 | 67 tokens 逐字相同 |
| 权限复位 effect | 11 tokens 逐字相同 |
| **工具结果三元的两整支 JSX** | **1203 tokens 逐字相同** |
| `permissionSuggestion` / `permissionGrantState` 两条声明 | 逐字相同 |
| 旧位置已消失 + 新位置已出现（双向反证） | 通过 |

这次搬的主体是 **JSX**，所以脚本对 `JsxText`（裸文本，含原始缩进与换行）按 **JSX 语义当 trivia**：空文本、含换行的纯空白（JSX 会整行剥离——这正是格式化工具敢把元素并成一行的原因）都不计入 token；**单行纯空白仍然保留**（它在 JSX 里真的渲染一个空格）。其余 token 逐字符比对。

**负控制**（两处，都要红）：

- **只改一处 `className`**（`border-l-red-500` → `border-l-red-400`）⇒ 守卫报 `DIFF @569`，而 6 条既有用例**全绿**。这正是守卫存在的理由：视觉级改动行为测试抓不到，只有 token 比对能抓。
- **翻转 `if (!permissionSuggestion)`** ⇒ 守卫报 `DIFF @479`，且 6 条用例中 **5 条**变红（第 6 条属网页搜索分支，与改动无关——命中是精准的）。

两处都还原后，守卫 PASS、用例全绿。

## Alternatives considered

- **一次拆三个组件（`MessageBubble` + `ToolResultBlock` + `PermissionBlock`）** —— 落选（本轮）。`PermissionBlock` 其实是工具结果块的**子分支**（它就在那个 `if (!permissionSuggestion)` 的 else 里），硬拆成平级组件只会让两者共享 `permissionSuggestion`/`permissionGrantState`/`onGrantSessionToolPermission` 三份契约；先把它与宿主一起搬出去，边界更自然。`MessageBubble`（user 气泡 ~70 行）留着下一轮——它与附件、文档引用、图片灯箱共享一组局部派生值，单拆收益低于工具结果块。
- **把 `createDiff` 的 prop 类型换成 `chat/utils/messageTransforms.ts` 里的权威 `DiffCalculator`** —— 落选，且明确记为**不做**。权威版把 `type` 收窄成 `"added" | "removed"`，而这条链路上各层都写着 `type: string`（全仓 7 份本地 `DiffLine` 副本）——换类型会变成一次跨文件的类型收紧，与"搬移不改语义"的目标相冲。已把这个副本问题登记为 `TD-UI-CHAT-N15`，等它单独收敛时一次做完。
- **让新组件只收"已经算好的 props"（把 `permissionSuggestion` 在父组件算好传下去）** —— 落选。该值由 `message` + `provider` 决定，只有工具结果块用；在父组件里算会留下一个"父组件知道子组件内部需要什么"的耦合，也让父组件的 `provider` 依赖多一处无谓传播。
- **新组件的入口守卫写成 `if (!message.toolResult) return null;` 之外的形式（例如要求父组件传非空 `toolResult`）** —— 落选。传 `toolResult` 就没法再用 `message.toolName`/`message.displayText` 等一同渲染所需的字段，而 `message.toolResult &&` 的渲染条件本来就在父组件（保持在原处，未改）。新组件里那句早退**只为类型收窄**，不改变"什么时候渲染"。
- **顺手把 `Math.round` 式的"死代码观察"一并清掉、或把 7 份 `DiffLine` 一起收敛** —— 落选。那会让本 PR 出现**无法用 token 守卫解释**的差异；本轮的卖点恰恰是"每一处差异都能解释"。观察已登记，留待独立 PR。

## Consequences

- **换来**：`MessageComponent.tsx` **969 → 662 行**（−307）；它那个 god function 箭头 **794 → 528**（−266）。工具结果块的五态分支现在有明确的宿主与名字（`ToolResultBlock`），读者不必再在一个渲染 7 种消息形态的组件里找"工具出错时到底走哪支"。
- **指标随动**（`pnpm measure:update`）：`ui/src` 477→479 文件（1 个新组件 + 1 个新 util）、84090→84140 行。
- **行为不变的论证强度**：搬迁逐 token 可证（9 项，含 1203 tokens 的 JSX 子树，且做了"旧位置消失/新位置出现"的双向反证）；行为侧另由既有的 `MessageComponent.tool-error.test.tsx`（6 条，正好覆盖被搬的五态中的四态：网页搜索设置入口、可恢复错误折叠、权限错误可操作、待确认授予流程、plan-mode 拒绝）与 `MessagesPaneV2.render.test.tsx` 守着。两处负控制已验，其中"纯视觉改动"这一处**只有守卫能抓**、测试全绿——这条差异值得记住：守卫与测试覆盖的是两类不同的失效。
- **付出**：`MessageComponent` 的 props 面收窄（不再直接消费 `permissionSuggestion`），新增 `ToolResultBlock` 的 8 个 prop；`chat/utils/messageContent.ts` 新增 16 行（含注释）。**不需要**浏览器验证：本次没有改任何渲染路径、样式类或交互分支。
- **仍未处理**（N04 剩余，均可继续按同法推进、无需浏览器验证）：`MessageBubble`（user 气泡 ~70 行）、`InteractivePromptBlock`（~82 行）、thinking/interrupted/compactBoundary 三个小块，以及 13 个 props 的收窄。
- **顺带发现**（已登记 `TD-UI-CHAT-N15`）：`DiffLine` 在聊天栈里有 **7 份本地副本**，而 `chat/utils/messageTransforms.ts` 已有权威定义（差异在 `type` 的宽窄）——这正是"谁都不敢先收紧"的典型僵局。
