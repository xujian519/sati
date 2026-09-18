# Agent Note: `MessagesPaneV2` 抽出虚拟化层与占位子组件（#159 N03）

Status: implemented

## Problem

`TD-UI-CHAT-N03` 记的是「`MessagesPaneV2` 巨型组件 + 手写消息虚拟化」，建议「窗口计算/高度测量抽独立 hook，拆 LiveProcess/Subagent/Fork 子组件」。实测口径照旧需要更正：条目里的「文件 1252 行」与实测不符（立案日已 **1375**，动手前 **1547**）。组件里同时承担虚拟滚动、进程分组、子代理详情、fork、搜索与可展开行渲染；虚拟化是**全手写**的（估算高度 + ResizeObserver + 多条 RAF + 前缀和缓存）。

盘点后，可搬的部分与条目设想并不一致：

| 部分 | 现状 |
|---|---|
| LiveProcess / Subagent / Fork | **已经是模块级子组件**（`ProcessLiveStatus` / `LiveProcessHeader` / `CompletedProcessHeader` / `SubagentDetailModal`），pane 里只剩把它们转发出去的外壳 |
| 虚拟化（高度估算 → 前缀和 → 窗口 + 测量回填 + 视口跟踪） | 与进程分组/rö渲染分支混在同一个 1024 行的函数里；纯函数有单测，**运行时那一层没有** |
| 空/加载/错误状态链（5 分支） | 内联在 JSX 三元里，**优先级只由书写顺序表达**，零测试 |

## Decision

分两片，都在一个 PR 内（两次提交，各带证明与负控制）：

### N03a：虚拟化层 → `chat-v2/messageVirtualization.tsx`（378 行）

纯函数与类型（`VirtualMessageWindow`、三个常量、`clampNumber`、`upperBound`、`getMessageTextLength`、`estimateMessageItemHeight`、`buildPrefixOffsets`、`getVirtualMessageWindow`）、组件 `MeasuredMessageItem`、hook `useMessageVirtualization`（测量表/RAF 句柄/高度版本/滚动视口、六个派生值、两个回调、三个 effect）。

**一处刻意的顺序论证**：三个 effect 原本就落在 pane 内部 595–840 这一段、彼此相邻，而**该区间内没有其他 effect**（其余 effect 都在 777 之前不存在、802 之后才有）——所以搬进 hook 后它们的相互顺序与相邻关系**完全不变**。这与 N01 缝 3 的处理恰好相反：那里有别的 effect 夹在中间，于是选择把 autosize effect 留在父级。

### N03b：占位视图 → `chat-v2/MessagesPanePlaceholder.tsx`（181 行）

五个分支的 JSX 原样搬入，同时把分支条件抽成纯函数 `resolveMessagesPanePlaceholder`——原先只能靠 JSX 三元的书写顺序表达优先级（改一处顺序就可能让"加载失败"被"空会话"盖住）。

结果：`MessagesPaneV2.tsx` **1547 → 1183 行**（god function **1023 → 824**）。

## Alternatives considered

- **按条目原话拆 LiveProcess/Subagent/Fork 子组件** —— 落选。这三类**已经是独立组件**，pane 里剩下的只是转发壳（`renderLiveProcessDetailMessages` 是 16 个 prop 的直通转发，`renderLiveProcessGroup` 再加 6 个）：拆出来得到的是 20–30 个 prop 的纯搬运层，读者仍要在两个文件间来回跳才能看懂一个状态行。真正值得拆的是**运行时逻辑**（虚拟化）与**优先级判定**（占位链），两者的边界都清晰、也可测。
- **把 `renderMessageItem`（147 行）也抽成组件** —— 落选（本轮）。它需要 pane 的约 30 个值（逐行派生的 `previousMessage`/`nextMessage`/`isLast`/`forkCarriedMessageCount`/`showAssistantActions`，加上转发给 `MessageRowV2` 的 25 个 prop）。这个 props 面本身说明它不是"职责叠加"而是"渲染上下文转发"；要真正改善得先收敛 `MessageRowV2` 的 props 面（另一件事，且属行为面重构）。**先记在台账，不硬拆。**
- **把虚拟化拆成两个 hook（窗口计算 / 视口跟踪）** —— 落选。窗口计算依赖视口状态与测量表，两者共享同一组 ref，拆开会变成互相传参的两个 hook；一个"虚拟化层"更贴合它的实际边界。
- **给 `messageVirtualization` 只放 hook、把 `MeasuredMessageItem` 另立文件** —— 落选。组件与 hook 通过 `handleMeasuredItemHeight` 成对工作，放一起才读得懂；`react-refresh/only-export-components` 的告警按仓库既有写法（原 pane 对两个导出函数也是这么做的）逐条豁免。
- **顺手把占位链的五个分支合成一个 `switch` 或表驱动** —— 落选。JSX 是逐字搬迁的（证明依赖这一点），改成表驱动会把"渲染"变成"配置"，收益不明而可读性下降；优先级问题已由纯函数 + 单测解决。

## Consequences

- **换来**：pane 从 1547 行降到 1183 行、god function 从 1023 降到 824；虚拟化层与占位层各自有名字与文件；**两个此前零覆盖的点有了直接测试**——虚拟化的运行时演进（6 条）与占位链的优先级（6 条）+ 占位渲染（5 条）。
- **证明**：两个脚本共 **33 项逐 token 比对**（N03a 27 项：7 个函数体、4 个类型/常量、4 个 ref/state、6 个 `useMemo`、2 个回调、3 个 effect，含 181 tokens 的视口跟踪 layout effect；N03b 6 项：五块 JSX 97/49/109/89/86 + 接线与顺序）。基线分别是 `c4ae3660`（N03 起点）与 `ac8592d2`（N03a 提交）——**不用 HEAD**：分批提交后 HEAD 前移、被搬代码会从 HEAD 消失。
- **负控制 3 处**，其中一处**抓到了守卫自身的弱点**：把占位链的前两条判定对调时，测试立刻变红而**守卫仍然 PASS**——因为"顺序检查"当时只验了五条判定**都存在**。随后把守卫改为按**分支标记**校验真实先后；顺带发现用条件表达式本身当标记也不行（`isExistingConversationEmpty && …` 会被下一条判定包含，`indexOf` 落回同一位置）。补强后正常态 PASS、对调后 FAIL。**这是本专项里第一次由负控制发现"守卫不够强"而不是"代码有错"**。
- **取证过程中的两个 TS 细节**（已写进脚本注释）：① JSX 里的嵌套三元在 TS 里是**恢复节点**——外层 `ConditionalExpression` 有 `whenTrue` 但 `elseExpression` 缺失，不能顺 AST 往下走，只能按源码区间取文本再各自解析；② `IfStatement` 的条件在 **`expression`** 字段，不是 `condition`。
- **仍未处理**：`renderMessageItem` 的抽取（前置条件是收敛 `MessageRowV2` 的 props 面，见上）；以及 L 级窗口最后一项 **UI-APP-N01**（`SkillsV2` 的 `ImportFromFolder` 拆 feature-folder）。
