# Agent Note: 消息类型分支的可达性审计——拆出交互提示、删掉两支不可达渲染（#159 N04 收尾）

Status: implemented

## Problem

`#444`（上一 PR）把 `MessageComponent` 的**工具结果块**（~270 行）拆出去之后，这个组件剩下的"多形态"就是按消息类型分的几支渲染：user 气泡（~70 行）、交互提示（~82 行）、thinking（~26 行），外加 compact boundary / interrupted / task notification 与 assistant 正文兜底。

按原计划（台账那句「按消息类型拆 `MessageBubble`/`ToolResultBlock`/`PermissionBlock`」）本该把这三支都拆成组件。动手前先做**可达性审计**——`#442`（N05）的教训是：点名的"重复实现"里有一个根本够不着；同一类错误在这里就是"给死分支搬个新家"。

审计的三段证据：

| # | 证据 | 结论 |
|---|---|---|
| 1 | `MessageComponent` 全仓只有一个挂载点：`MessageRowV2:265`，位于 `if (delegate)` 分支内，且前面还有容器早退 | 只有 `delegate === true` 的消息才进得来 |
| 2 | `shouldDelegate`（`MessageRowV2:96`）：`isToolUse` / `isInteractivePrompt` / `isTaskNotification` 任一为真才委托；否则 `type ∉ {user, assistant, error}` 才委托 | `type === "user"` 与"普通 thinking 消息"（`type: "assistant"`）**永远不委托** |
| 3 | 生产端：`useChatMessages.ts` 的 `case "thinking"` 产出 `type: "assistant"` + `isThinking`（无三标志）；`case "text"` 的 user 分支与 composer 三处乐观消息产出 `type: "user"`（无三标志）；三标志只在 `case "tool_use"`/`"interactive_prompt"`/`"task_notification"` 上、且都配 `type: "assistant"` | 门 2 的条件对这两类消息恒不成立 |

**运行时探针**（临时用例，渲染真实 `MessagesPaneV2`，用完即删，其断言已并入永久用例）进一步佐证：user 消息由 **v2 原生路径**渲染（正文、附件 `doc.pdf`、图片都在，而 `MessageComponent` 用户气泡独有的 `rounded-br-md` 不出现）；thinking 消息被 `processGrouping` 折进默认折叠的进程行，连正文都不在可见行里；交互提示则确实由 `MessageComponent` 渲染。

## Decision

**拆那支活的，删那两支死的。**

1. **交互提示 → `view/subcomponents/InteractivePromptBlock.tsx`（100 行）**：整块 JSX 逐字搬迁（含 `InteractiveOption` 类型与选项解析），prop 只有 `messageContent`，i18n 自取。
2. **user 气泡（~70 行）→ 删**，连同只喂它的派生值（`messageAttachments`/`documentReferenceAttachments`/`referenceImageNames`/`messageImages`/`fileAttachments`、`userCopyContent`/`shouldShowUserCopyControl`）与两个只被它使用的辅助函数（`getAttachmentTypeLabel`/`getAttachmentAccent`）和 `attachmentToDocumentReference`。
3. **thinking 分支（~26 行）→ 删**。
4. 顺手把根节点那处 `message.type === "user" ? "flex justify-end px-3 sm:px-0" : "px-3 sm:px-0"` 做等价化简（委托路径下 `type` 恒非 `user`，该三元只剩后半支），并在原位留注释说明为什么。

**验证**（`/tmp/n04b-move-proof.mjs`，5 项）：交互提示 JSX 搬迁 **412 tokens 逐字相同**；门的判据 `if (t !== "user" && t !== "assistant" && t !== "error") return true;` 仍在；生产端两个 case 的 `type: "assistant"` 断言成立；被删两支的独有标记（user 气泡 class、`<DocumentReferenceChip`、thinking 分支条件 `) : message.isThinking ? (`、`getAttachmentAccent`）在工作树里**全部消失**，`<InteractivePromptBlock` 调用出现，两个临时生成过的"死组件"文件已不存在。

**永久用例**（并入 `MessagesPaneV2.render.test.tsx`）：一条用例同时钉住三类消息的分流——user 的正文/附件/图片由 v2 原生渲染且用户气泡 class 不出现、thinking 不在可见行、交互提示由新组件渲染。**负控制**：把 `shouldDelegate` 的门放宽成"只有 assistant/error 不委托"⇒ 该用例立刻变红（`expected … to contain 'doc.pdf'`：legacy 路径不渲染附件），还原后全绿——这条负控制同时说明：删除的安全性**依赖**那道门，而门一旦被放宽，用例会替我们喊。

## Alternatives considered

- **照原计划把三支都拆成组件（`MessageBubble`/`InteractivePromptBlock`/`ThinkingBlock`）** —— 落选。这正是 `#442` 的教训重演：给不可达分支搬个新家，等于把"死代码"从一个大文件搬到两个小文件，还额外**造出**两个没有调用者的组件（本 PR 过程中确实先这么做了，随后按审计结论撤回并删除）。**先问"哪支在跑"，再决定拆还是删。**
- **只拆不删（保留两个死分支，理由是"万一路径变了"）** —— 落选。留着它们，下一位读者仍要在"用户消息到底谁渲染"上花时间；真正的防线应该是**门**本身，而现在门有：静态判据 + 一条会红的用例 + 负控制已验。
- **把 user 气泡的能力当成"删了就少个能力"而保留** —— 落选，理由是可验证的：v2 原生路径本来就渲染 user 消息的附件与图片（探针与永久用例都断言了 `doc.pdf` 与 `<img>`），删掉 legacy 那支不减少任何用户可见能力；只有当门被放宽、user 消息真的改走 legacy 路径时才会**少**东西——那正是负控制里看到的现象，也正是用例要拦的。
- **连 `shouldHideThinkingMessage`（`message.isThinking && !showThinking` 的早退）一起删掉** —— **本轮不做**。它同样是"针对不可能输入"的守卫，但删渲染分支与删守卫的风险不等价：分支删错只影响它自己，守卫删错会让（假想的）thinking 消息改走 assistant 正文渲染。留作后续观察，已记入台账。
- **顺手把 `taskNotification` 支也一起审** —— **本轮不做**。探针显示 task 通知的正文同样不在可见行里（被 `processGrouping` 折叠），但"折叠"与"不委托"是两种不同的不可达，需要各自把证据补齐；已在台账里记成下一步线索，不在本 PR 里顺手断言。

## Consequences

- **换来**：`MessageComponent.tsx` **662 → 409 行**（相对本轮起点；相对最初立案的 969 行是 **−560**）；它的 god function **528 → 335**。组件现在只剩"委托路径真的会用到"的分支：compact boundary / interrupted / task notification / tool-use（含工具结果块）/ 交互提示 / assistant 正文兜底。
- **指标随动**（`pnpm measure:update`）：`ui/src` 479→480 文件、84140→84034 行。
- **行为不变的论证**：唯一搬迁是可证等价的（412 tokens 逐字相同 + 旧位置消失/新位置出现的双向反证）；两处删除的依据是**结构性不可达**（门 + 生产端两段证据 + 运行时探针佐证），并按 `#442` 的先例配了永久用例与负控制。**不需要**浏览器验证：没有改任何渲染路径或交互分支——删的路径本来就不渲染。
- **仍未处理**：N04 只剩"13 个 props 的收窄"这类可选清理；另有两条本轮明确不做的观察（`shouldHideThinkingMessage` 守卫、task notification 支的可达性），已记入台账 `TD-UI-CHAT-N04` 与 §29.C。
- **一条可复用的口径**：这类"够不着的分支"审计有三段固定证据——**挂载点唯一性**、**门的判据**、**生产端构造**；缺任何一段就只能说"大概没跑过"。本 PR 与 `#442` 用的是同一套。
