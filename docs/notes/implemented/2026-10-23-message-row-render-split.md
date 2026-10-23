# Agent Note: 消息行三件拆分（sweep B2.3）

Status: implemented

## Problem

sweep 基线（`a3c35684b`）上，chat 主链路还剩三个 ≥300 行的单体：

- `ui/src/components/chat-v2/MessageRowV2.tsx` 的 `MessageRowV2` **429 行**（文件 745），一个函数里并行塞着分派（delegate / subagent / process rows）、附件派生，以及 user / error / thinking / assistant 四套互斥的渲染分支；
- `ui/src/components/chat-v2/SubagentDetailMessageFlow.tsx` 的 `SubagentDetailMessageFlow` **309 行**（文件 378），除列表装配外还内嵌两段 live process group 渲染回调；
- `ui/src/components/chat/view/subcomponents/MessageComponent.tsx` 的匿名 memo 回调 **335 行**（文件 404），其中任务通知行与消息头部两块纯展示 JSX 与主渲染无状态耦合。

三者已有测试（`MessagesPaneV2.render.test.tsx` 38 例、`SubagentDetailMessageFlow.render.test.tsx` 4 例、`MessageComponent.tool-error/todo-write` 10 例），计划判据是各自 ≤300。

## Decision

**只搬互斥分支与纯展示块，分派与状态留在父级。** 新增文件与职责：

| 文件 | 行数 | 内容 |
|---|---|---|
| `chat-v2/messageRow/UserMessageRow.tsx` | 158 | user 气泡、文档引用、附件卡、图片与 lightbox（lightbox 状态随分支下沉，父级不再持有） |
| `chat-v2/messageRow/ThinkingMessageRow.tsx` | 76 | thinking 的 inline / default 两种 `<details>` 形态 |
| `chat-v2/messageRow/AssistantMessageRow.tsx` | 110 | assistant 正文、产物组、copy / fork / regenerate 动作行 |
| `chat-v2/messageRow/ErrorMessageRow.tsx` | 26 | error 红色横幅 |
| `chat-v2/messageRow/MessageProcessRows.tsx` | 110 | `ProcessSummaryRow` / `ProcessAttachmentRow`（原同文件模块级函数） |
| `chat-v2/messageRow/MessageRowActions.tsx` | 112 | `CopyMarkdownButton` / `HoverActionButton` / `ForkMessageButton`（原同文件模块级函数） |
| `chat-v2/messageRow/messageRowVisibility.ts` | 8 | `hasAssistantBody` 单点判定（父级 null 短路与子组件共用；存放于独立模块以满足 react-refresh 只导出组件的约束） |
| `chat-v2/subagentDetailKeys.ts` | 11 | `getMessageKey` / `isStreamingSubagentThinkingMessage`（两文件共用） |
| `chat-v2/subagentDetailRenderers.tsx` | 103 | `useLiveProcessGroupRenderers`：live group 详情与分组渲染两个 `useCallback` |
| `chat/view/subcomponents/MessageHeaderRow.tsx` | 47 | 消息头部（头像 / 类型标签），`resolveHeaderTypeLabel` 随迁 |
| `chat/view/subcomponents/TaskNotificationRow.tsx` | 41 | 任务通知卡片，状态点样式表随迁 |

**结果：`MessageRowV2` 429 → 249 行、`SubagentDetailMessageFlow` 309 → 261 行、`MessageComponent` 匿名回调 335 → 297 行**；文件 745 → 351、378 → 320、404 → 348；新增函数均 < 160 行。

三条保持行为不变的取舍：

1. **`MessageRowV2` 继续持有四个分支的入口判断与 `withProcessRows` 包装。** 子组件只渲染自身分支；`isAgentActivitySummary`、`isSubagentContainer`、`delegate`、`isThinking && !showThinking` 的短路顺序原样保留，避免把「何时返回 null」的判断分散到多个文件。
2. **assistant 的「有没有正文」由导出的 `hasAssistantBody` 单点判定。** 父级要在「无正文且无 process 附件」时整体返回 null，子组件要在「无正文」时返回 null；两处若各写一份条件，后续改一处就会漂移。
3. **live process group 用 hook 而不是组件承载。** 两段回调闭包依赖 `liveProcessGroups` / `thinkingStatusStep` / `t` 与稳定化的 `isProcessExpanded`，换成组件会新增一层 props 与渲染边界；hook 内部顺序与原本完全一致（`useCallback` 依赖表仅把 `handleProcessExpandedChange` 改为同名参数）。

## Alternatives considered

- **只拆 `MessageRowV2`，另两件手工压缩到 299 行** —— 落选。`SubagentDetailMessageFlow` 与 `MessageComponent` 超出判据分别只有 9 / 35 行，但靠删除空行/合并语句达标属于「为指标而改」，反而把两段完整职责留在原地；按职责搬出两块纯展示代码更有长期价值。
- **把四个分支做成 `renderUserMessage` 之类的普通函数** —— 落选。user 分支有 lightbox `useState`，普通函数无法合法持有 hook；做成组件还能让 lightbox 状态随分支卸载自然重置，与拆分前一致。
- **把 `MessageRowV2` 的附件派生也搬进子组件** —— 落选。`messageImages` 依赖 `documentReferenceAttachments` 的 region 图片名集合，且 `hasForkUnsupportedContent` 同时被 user 和 assistant 分支消费；搬进任一子组件都会重复计算或在兄弟间传递。
- **新增 `messageRow/index.ts` barrel** —— 落选。六个组件文件都是单组件，直接路径导入更利于 tree-shaking 与依赖追踪，也避免 barrel 成为新的循环入口。

## Verification

- **判据**：`MessageRowV2` 429 → **249**，`SubagentDetailMessageFlow` 309 → **261**，`MessageComponent` 335 → **297**；`metrics.md` 的 God function 表三条目消失（`measure:update`）。
- **AST 等价证明（14/14）**：以 `a3c35684b` 为基线，用 TS AST 打印搬迁节点后逐字符对比——user 分支 JSX 3330、thinking inline 1194 / default 742、error 397、assistant body 1552、三个动作组件 825/817/1074、两个 process 组件 1328/1899、`attachmentToDocumentReference` 1026、任务通知 800、消息头 700、`resolveHeaderTypeLabel` 465、两段 live group 回调 660/1316，**全部相等**。仅一处非语义差异：`TaskNotificationRow` 的两个 `&& (<span>)` 括号被 biome 格式化去掉，AST 结构相同。
- **负控制（3 组，均恢复后复跑）**：
  1. `shouldDelegate` 的 `isInteractivePrompt` 改返回 `false` → `MessagesPaneV2.render` 的「user / thinking / interactive 三类消息分流」**1 红**（其余 37 绿）。
  2. `useLiveProcessGroupRenderers` 的 `showStreamingThinkingBeforeStatus` 固定 `false` → `SubagentDetailMessageFlow` 的「streaming subagent thinking through the live preview channel」**1 红 / 3 绿**。
  3. `MessageComponent` 的 `!shouldHideToolResult(...)` 取反 → tool-error 组 **7 红 / 其余绿**（`ToolResultBlock` 不再渲染）。
- **双视口浏览器 A/B（类型 B）**：真实 `pnpm dev`（Vite 5173 / server 3001 / gateway 19789），系统 Chrome（Playwright `channel: chrome`）。两个会话、桌面 1440×900 与移动 390×844：
  - 会话 `web:s_c811ca6f…`（20 行，含 19 个 process 行 + 1 个 subagent 卡）：默认态 **20/20** 行 outerHTML SHA-256 与 rect 相同；展开 6 个 process 行后 **6/6** 行相同；子代理详情弹层桌面与移动 DOM 哈希均相同（119,016 字节）。
  - 会话 `web:s_b97a4722…`（20 行，含 6 条 user 气泡）：桌面/移动 **20/20** 行相同；user 气泡 outerHTML 哈希相同、hover 动作按钮（fork/edit）label/disabled 相同；assistant 动作行按钮相同；展开末行 process 后哈希相同。
  - 两次运行控制台 error / pageerror 均为 0。截图不可得（本环境 Playwright 启动 headless 需下载浏览器；改用系统 Chrome + DOM/布局断言）。
  - **有意未验证**（谁因此漏了什么）：真实发送消息/agent 执行（会改动本机会话数据，跳过；由既有 58 例与负控制承担）；thinking 的 typewriter 流式中间态（需真实在途回合；由 `useTypewriter` 既有测试承担）；error 横幅与任务通知（当前会话数据无这两类消息；由组件结构与 AST 证明承担，无运行时断言）；其他 locale 未切换。
- **门禁**：`pnpm --filter sati-ui test` 199 文件 / 1530 例全绿；`pnpm check`、`pnpm test`、`pnpm test:pr-tooling` 结果见 PR。
- **生成物**：`measure:update` 反映 ui/src 684 → 694 文件、105037 → 105333 行；`gen:event-matrix` / `gen:doc-claims` 无 diff；`check-architecture-boundaries` fresh（无 ≥800 行新文件，无需注销豁免）。

## Consequences

- **换来**：`MessageRowV2` 只剩分派与附件派生；四种消息形态各有名字，改动一处不再需要穿过 400 行互斥分支；subagent 详情的 live group 渲染可单独测试。
- **代价**：子组件共接收约 30 个显式 props（多数是父级本来就在闭包里的同名变量）；`MessageComponent` 拆出两块后剩余 297 行，距判据仅 3 行余量，后续任何新增都会重新越线——届时优先把 JSON 内容块也外置。
