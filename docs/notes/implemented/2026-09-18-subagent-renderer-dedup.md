# Agent Note: 子代理渲染器去重——删掉不可达的那一个（#159 N05）

Status: implemented

## Problem

台账 `TD-UI-CHAT-N05` 记的是「chat 与 chat-v2 子代理渲染**重复实现**」，建议「统一为单一 `SubagentRenderer`」：

- `ui/src/components/chat-v2/SubagentCard.tsx`（179 行）：紧凑卡片——类型徽标 + 状态行 + 思考预览 + 点击进详情；
- `ui/src/components/chat/tools/components/SubagentContainer.tsx`（219 行）：可折叠工具块——prompt、当前工具、完成态、工具历史 `View tool history`、最终结果。

动手前先做可达性核查（照 #354 里 `globalChrome.js` 的教训：点名热点的条目可能已经名不副实）。核查结论与条目预期相反：**这不是两个都在跑的重复实现，而是一个活的 + 一个够不着的**。

`SubagentContainer` 的唯一入口是 `ToolRenderer` 里的 `if (isSubagentContainer && subagentState)` 分支，而 `SubagentContainer` 需要拿到 `isSubagentContainer === true` 的消息——可是容器消息在到达 `ToolRenderer` 之前已经被**四道**独立机制截住：

| # | 位置 | 机制 |
|---|---|---|
| 1 | `chat-v2/MessageRowV2.tsx:247` | `if (message.isSubagentContainer)` → 早退，渲染 `SubagentCard` |
| 2 | `chat-v2/MessageRowV2.tsx:97` | `shouldDelegate()` 里 `if (message.isSubagentContainer) return false` |
| 3 | `chat-v2/SubagentDetailMessageFlow.tsx:135` | 子代理详情弹窗主动 `.map(m => ({...m, isSubagentContainer: false}))` |
| 4 | `chat-v2/useSubagentMessages.ts:33` | 无 `subagentId` 的容器消息被清成普通工具消息 |

再把链路收紧：`ToolRenderer` 全仓只有两个调用点，都在 `MessageComponent` 里（`:438` input 段、`:741` result 段）；而 `MessageComponent` 全仓只有一个挂载点——`MessageRowV2:265` 的 `delegate` 分支。于是「容器消息 → `MessageComponent` → `ToolRenderer` → `SubagentContainer`」这条链上，第一环就被门 1 和门 2 双重否定。**`SubagentContainer` 与它那条分支在活体里不可达**，这也解释了为什么它一行测试都没有（`grep` 全仓测试：零命中）。

## Decision

**删掉不可达的那个实现，而不是再造一个 `SubagentRenderer`**：存活实现就是 `SubagentCard`，条目里的「统一」以「只剩一个」的形式达成。

实测先于删除：新增用例先在**删除前**跑（`子代理容器消息只走 SubagentCard，不再流经 legacy 子代理渲染器`）——容器消息确实渲染出卡片（`扫描仓库结构` / `explore` / 完成态），而 `SubagentContainer` 的三处独有文案（`View tool history`、`Running subagent`、`Currently:`）在整棵 DOM 里一次都不出现。删完该用例仍绿。

改动面（5 文件，+35/−248）：

1. 删除 `chat/tools/components/SubagentContainer.tsx`（219 行）及其在 `components/index.ts` 的导出；
2. 删除 `ToolRenderer` 里的容器分支、`isSubagentContainer`/`subagentState` 两个 prop 与随之失去用途的 `SubagentChildTool`/`ToolResult` 类型导入（`:168-180`、`:27-45`）；
3. 删除 `MessageComponent` 向 `ToolRenderer` 透传的那两个 prop（两处，`input` 段与 `result` 段）——它们在此处的实参恒为 `false`/`undefined`（门 1 决定的），是典型的"看起来在传信号、其实恒假"；
4. 新增回归用例并写清上述四道门的由来。

> 注意 `ChatMessage.isSubagentContainer` / `subagentState` 两个**字段**保留：chat-v2 的分组、搜索、详情、`SubagentCard` 都在用它们；删的只是"为不可达渲染器服务的 prop 透传"。

## Alternatives considered

- **按条目原话做一个统一 `SubagentRenderer`（合并两套 UI）** —— 落选。两者不是同一件东西的两个变体：一个是**消息级**的状态卡（类型/状态/思考流），一个是**工具级**的可折叠详情块（prompt/工具历史/结果）。"合并"意味着设计第三套 UI 并把两处入口都切过去——那是**行为变更**（用户看到的子代理渲染会变），不是去重。去重的正解是先问"哪个在跑"。
- **保留 `SubagentContainer` 作为兜底**（"万一将来某条路径忘了清标志"）—— 落选。这正是本条债务的成因：一个够不着的渲染器留在仓库里，会让下一位读者继续在"到底哪个渲染器赢"上花时间，而且它**零测试覆盖**。真正的防线应该落在"容器不进 legacy 渲染器"这个不变式上（现已由新用例钉住），而不是靠一份死代码兜底。
- **只删组件、保留 `ToolRenderer` 的两个 prop** —— 落选。实参恒假，等同 #440 里那个恒 false 的死状态：留着就是把"死"从组件搬到 prop 上，`--max-warnings 0` 也会因未使用参数而红。一并收干净。
- **反过来：让那条分支变成活的**（详情弹窗改走 `SubagentContainer`，不再清标志）—— 落选，且明确记为**不做**。详情弹窗想要的恰恰是"把子代理内部消息摊平显示"，门 3/门 4 的清除是有意为之；改成渲染折叠块会改变详情视图的用户可见行为，属功能变更，须单独立项。
- **加一道源码级守卫脚本（禁止 `chat/tools` 再出现子代理渲染器）** —— 落选（本轮）。仓库已有 `check:*` 系列守卫，但这条不变式用一条渲染用例即可覆盖（负控制证明它有效），再加脚本属过度工程；等真出现第二次复发再升级为守卫。

## Consequences

- **换来**：仓库少 219 行无人可达、无人测试的组件，少一条分支、两个 prop 与两份随之无用的类型导入；「子代理长什么样」这个问题在代码里只剩一个答案（`SubagentCard`），审 diff 不再需要先判断走的是哪条渲染路径。
- **零行为变化**的论证是**静态**的：门 1/门 2 都在容器消息进入 legacy 渲染器之前生效，属结构性不可达，不是抽样观察——这类删除无法用运行时用例"回放"不可达状态，故先做实测（前置用例已证存活路径正确），再补一条**针对不变式本身**的回归用例：容器消息必须渲染出卡片。负控制已验：把门 1 与门 2 同时注入成 `false && …`（即模拟"有人把容器放进 legacy 渲染器"）⇒ 用例立即变红（`Unable to find an element with the text: 扫描仓库结构`），还原后全绿。
- **付出**：`ToolRendererProps` 收窄两个字段（组件是模块内私有，活体消费者只有 `MessageComponent`，已 grep 确认；测试侧无消费者）。
- **口径更正**：条目原话「重复实现 → 统一为单一 `SubagentRenderer`」的**事实前提**需修正为「一个活体 + 一个不可达」。台账 `TD-UI-CHAT-N05` 已按此改写，免得下一位读者再去找"要合并的那两套 UI"。
- **指标随动**（`pnpm measure:update`）：`ui/src` 473→472 文件、83920→83706 行；**无参 `catch {` 661→658**——被删文件里那三处都带意图注释（无注释项仍为 **0**，不是 #353 的目标指标回退，纯粹是总数随代码消失而下降）；测试文件 `MessagesPaneV2.render.test.tsx` 的匿名箭头 862→897（新增用例的长度代价），`MessageComponent` 匿名箭头 798→794。
- **仍未处理**（按 #159 的分档排期）：中件剩 `UI-CHAT-N04`（`MessageComponent` 按消息类型拆）、`UI-CHAT-N07`（`PdfDocumentPreview` 抽 `usePdfViewerState`）；L 级窗口 `UI-CHAT-N01` / `UI-CHAT-N03` / `UI-APP-N01` 三项仍待成窗口（共享双视口浏览器验证成本）。
