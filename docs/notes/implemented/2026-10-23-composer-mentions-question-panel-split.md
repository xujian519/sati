# Agent Note: composer 状态、文件提及与提问面板拆分（sweep B2.5）

Status: implemented

## Problem

sweep 基线（`13c4741a4`）的 chat 主链路上还有三个 ≥300 行的单函数：

- `useChatComposerState` **462 行**（文件 554）：#159 已把附件、权限、提交、斜杠等拆成层，但父 hook 仍内联持有输入 state、忙碌队列快照、引用监听、思维模式与整套返回对象装配；
- `useFileMentions` **366 行**（文件 423）：文件树拉取、`@` 查询解析、下拉状态、插入与整段键位处理同住一个闭包；
- `AskUserQuestionPanel` **378 行**（文件 421）：状态、选项切换、回答组装、提交与键盘路由全部内联在组件体内。

三者已有测试（composer 5 例、mentions 2 例、panel 1 例），但覆盖不到本批搬动的大部分逻辑；计划判据为各函数 ≤300 行。

## Decision

**按“调用顺序保持”切层，逻辑外移为模块级函数或同位置子 hook；渲染路径与 JSX 不动。**

| 文件 | 行数 | 内容 |
|---|---|---|
| `chat/hooks/useComposerFoundation.ts` | 203 | 草稿键、输入 state、附件、忙碌队列、引用监听、会话权限、思维模式 |
| `chat/hooks/useComposerInteractions.ts` | 295 | 斜杠执行/命令、文件提及、提交、拖放、草稿、autosize、输入层 |
| `chat/hooks/composerResult.ts` | 109 | `buildComposerResult`：按原键序装配 55 个返回键 |
| `chat/hooks/composerBusySnapshot.ts` | 36 | `QueuedBusySendSnapshot` 类型 + `mergeQueuedBusySendSnapshot` |
| `chat/hooks/composerThinkingMode.ts` | 41 | 归一化、会话级持久化、切换时初始模式解析 |
| `chat/hooks/composerDocumentReferences.ts` | 37 | `sati:add-chat-reference` 监听与去重 |
| `chat/hooks/useComposerAutosize.ts` | 21 | 两条 textarea 自适应 effect |
| `chat/hooks/mentionDropdownState.ts` | 39 | `@` 查询解析与文件过滤（原 effect 体逐字搬移） |
| `chat/hooks/fileMentionInteractions.ts` | 103 | 整词删除、上下选词、Tab/Enter 选中、Esc 关闭 |
| `chat/tools/.../useQuestionPanel.ts` | 160 | 当前步骤、选项/自定义回答、回答组装、提交、键盘路由 |

结果：`useChatComposerState` 462 → **4**、`useFileMentions` 366 → **278**、`AskUserQuestionPanel` 378 → **255**；本批新增函数最大 295 行，God function 表未新增条目。

四条保持行为不变的取舍：

1. **composer 拆成前后两层而不是一个“大外移”。** 基础层与交互层在父 hook 里顺序调用，展开后 hook 调用序（38 项）与拆分前逐项一致；effect 的相对顺序不变。返回对象单独装配，避免交互层因 55 个键的 `return` 越过 300 行。
2. **`useFileMentions` 不拆成“文件列表 hook + 下拉 hook”。** 后者会把“下拉由关到开时刷新”的 effect 提到“会话切换复位”之前，effect 顺序有语义；因此只把 effect 体与键位处理搬成模块函数，state 全部留在原处。
3. **面板只搬逻辑，不搬 JSX。** 拆 JSX 属于类型 B（需双视口 A/B）；本批 JSX 逐 token 952/952 未动，按类型 A 验收。
4. **测试用的最小事件形状。** `handleFileMentionsKeyDown` 的参数收窄为 `FileMentionKeyEvent`，测试不再为造 React 合成事件写 `as unknown as`；仓库双重断言由 29 降至 28。

## Alternatives considered

- **只把 composer 的逻辑搬成模块级函数、不新增子 hook（B2.4 的形态）** —— 落选。父 hook 剩余体量主要来自 31 个 props 的解构、交互层 178 行与 55 键返回装配；不切层就无法同时把父函数与搬出的函数都压到 300 行以下。
- **把 composer 的返回对象留在 hook 内，只搬前两层** —— 落选。交互层会因 82 行 `return` 维持 ≥300 行，指标不降。
- **把 `useFileMentions` 的文件列表与下拉状态各自成 hook** —— 落选。会在同一 commit 内重排 effect；token 证明无法覆盖 effect 顺序，收益仅是行数。
- **把 `AskUserQuestionPanel` 的选项列表/页脚拆成子组件** —— 落选。属于类型 B 拆分，需要真实本地栈双视口 A/B；本批目标是函数规模，不是组件边界。
- **为内置命令式面板建 action→renderer 注册表** —— 落选。面板只有一种题型渲染，注册表只会增加间接层。

## Verification

- **判据**：462 → **4** / 366 → **278** / 378 → **255**；`metrics.md` 中三条 God function 消失且未新增（`measure:update`）。
- **AST 逐 token 证明（13 项，基线 `13c4741a4`）**：TypeScript AST 取 leaf token 比较。
  - composer：基础层前缀（state/refs/attachments）**504/504**、权限层 **48/48**、命令接线（斜杠/提及/提交）**238/238**、dropzone **56/56**、草稿 **24/24**、autosize 两条 effect **130/130**、输入层调用 **76/76**、返回键序 **55/55**。
  - 思维模式层：170 项中 12 处差异，全部来自三处已声明的 helper 调用（`normalizeThinkingMode` / `persistThinkingModeForSession` / `resolveThinkingModeForSession`）；helper 体内的判断与存储键逐字保留。
  - 文件提及：下拉派生 **153/153**、键位处理 **626/626**。
  - 提问面板：状态与处理 **989/989**、JSX **952/952**。
  - 迁移点：`args.x` / `foundation.x` 归一化为 `x`（同值、显式归属），`x: x` 归一化为 `x`（简写）。
- **hook 调用序**：旧 38 项（`useState`×4 … `useComposerInput`）与新两层展开 `useComposerAutosize` → 2 条 `useEffect` 后逐项一致。
- **新增直测（19 例）**：composer 8 例（思维模式恢复/持久化/未知值归一/临时会话不落盘、引用去重/畸形载荷忽略/按 id 删除、`setAttachedImages` 值与函数式更新）；mentions 5 例（树扁平化与大小写无关过滤、仅重开时刷新、选中插入与关闭、方向键 + Tab、跨项目事件忽略）；panel 6 例（单选提交、多选拼接、多题前进/返回/最终提交、整题跳过、数字键 + Enter、全畸形不渲染）。
- **负控制（6 组，均恢复后复跑）**：
  1. 临时会话也持久化思维模式 → **1 红 / 7 绿**。
  2. 引用重复 id 不再去重 → **1 红 / 7 绿**。
  3. `@` 过滤改为大小写敏感（两处分支）→ **2 红 / 5 绿**。
  4. 会话切换不再复位 `hasCursorPositionRef` → **2 红 / 5 绿**。
  5. 多选按单选处理 → **1 红 / 6 绿**。
  6. 回答分隔符 `", "` 改为 `"/"` → **1 红 / 6 绿**。
  - 另有一次“每次击键都刷新”的翻转**未生效**（该 effect 仅在 `showFileDropdown` 变化时重跑，守卫不在热路径），已用第 4 组替代；此处显式记录，不把它算作有效负控制。
- **类型 A（无渲染路径变更）**：按 checklist 不跑浏览器 A/B；jsdom 直测 + token 证明 + 负控制为验收面。
- **门禁**：`pnpm check`、`pnpm test`（5977 / 5972 pass / 0 fail / 5 skip）、`pnpm test:pr-tooling`（197/197）、`pnpm --filter sati-ui test`（204 文件 / 1594 例）全绿；`check:architecture-boundaries` fresh（豁免 35 条）。
- **生成物**：`measure:update` 反映 ui/src 705 → **716** 文件、106907 → **107998** 行（10 个新源文件 + 1 个新测试文件，测试经 `git add -f` 入库后计入基线）；`as unknown as` 29 → **28**（收窄键位事件类型后移除了 3 处测试断言，净减 1）。

## Consequences

- **换来**：composer 父 hook 只剩两行编排；基础层与交互层各自可独立阅读；`@` 提及与提问面板的交互逻辑可单测、可单独演进。
- **代价**：`useComposerInteractions` 已 295 行，距阈值仅 5 行；后续新增逻辑应优先再切一段（例如把结果装配的参数分组或拖放/草稿层外移），而不是继续在交互层内堆叠。基础层以 14 个 props 的显式解构换取与交互层的顺序隔离，新增基础层依赖需同时改两层签名。
