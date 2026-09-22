# Agent Note: 图型扩展第一批（状态图 / 组件层级图，DOT 通路优先）

Status: implemented

## Problem

`FigureSpec.kind` 只有 `flowchart` 与 `block` 两种。于是两类技术方案只能硬套：

1. **状态机类**（协议状态、工作模式的切换、设备运行状态迁移）：套流程图后，初态与终态只能画成
   「开始/结束」椭圆框——那是流程图的符号，不是状态图的符号；图面读作"流程"而非"状态迁移"。
   状态图标准的**实心小圆（初态）**与**双圈（终态）**当时**无法表达**（`shape` 枚举里没有圆形）。
2. **系统组成/软件分层类**：套 `block`（默认横向）后，包含关系与数据流用同一种带箭头连线表示，
   整张图读起来像"模块之间传数据"，而它要表达的是"整体由哪些部分组成"；层次感靠 graphviz 的
   自然分层碰运气，节点在层内自左对齐，树形观感不成立。

对照实现（`deepseek-harness`）有 flowchart/block/hierarchy/state 四型与对应的 DOT 构建器；本仓库的
`docs/patent-figure-harness-parity-plan.md` §8 把「图型扩展分批」列为合规侧之后的下一批，并明确
「DOT 通路先（状态图/层级图，复用 `dot.ts`）→ 矢量通路后（电路/曲线/剖视/时序）」。本条落地第一批。

## Decision

`FigureKind` 增 `"state"` 与 `"hierarchy"`，`FigureNodeShape` 增 `"circle"` 与 `"doublecircle"`；
**四个图型共用同一份 FigureSpec 契约**（`figure_no`/`nodes`/`edges`/`ref`/`direction`），差异只在
默认方向、形状读法与连线画法：

| kind | 默认方向 | 形状读法 | 连线 |
|---|---|---|---|
| `flowchart` | TB | ellipse=起止、rect=步骤、diamond=判断 | 带箭头 |
| `block` | LR | rect=模块、cylinder=存储、parallelogram=输入输出 | 带箭头 |
| `state` | TB | round=状态、**circle=初态**、**doublecircle=终态** | 带箭头（转移条件写在箭头上） |
| `hierarchy` | TB | rect/round=组件 | **不画箭头**（表示包含关系）、各层居中 |

**符号形状（circle/doublecircle）不渲染文字**：实心黑底上的黑字不可见，故两个渲染器都只画符号、
丢弃 label；丢弃**不静默**——新增校验规则 **V18** 报 warn，并指明该节点的 `ref` 标记也随文字不显示。
新增形状尺寸固定（初态 22px / 终态 30px 直径），不随 label 撑开。

**层级图各层居中**：居中量取"该层沿副轴延长 − 最宽层延长"的一半，画幅（内建渲染器）本就由最宽层
决定 ⇒ 居中在构造上不可能越出画幅。居中**只对 `hierarchy` 生效**，其余图型保持层内自左对齐，
既有布局与快照逐字节不变。

**附图说明措辞**同步（`brief.ts` 的 `Record<FigureKind, string>`，穷尽性由类型强制）：CN `状态转移示意图`
/ `层级结构示意图`，US `state transition diagram of a process` / `hierarchical block diagram of a system`。

**inputSchema 变更 → fixture 重录**（仓库铁律：改任何工具 `inputSchema` 会使 llm-replay 请求键失配）。
本次重录在工作区内完成：`PILOT_AGENT_MODEL=deepseek/deepseek-v4-flash`——**本机 `~/.sati/sati.yaml` 的
`agent.model` 已改成 `deepseek/deepseek-flash`，而请求键含 `model`，必须按 fixture 声明的模型录制**，
否则录出来的记录重放必失配（这是本次踩到的坑，记在这里供下次重录参考）。

## Alternatives considered

- **新增节点字段（如 `stateKind: "normal" | "initial" | "final"`）而不是扩展 `shape`** — 落选：形状本就是
  "视觉形态"字段，DOT 的形状名（`circle`/`doublecircle`）与之一一对应；多一个字段会多出一类非法组合
  （形状与角色不一致），而内建渲染器本来就按 `shape` 分派。
- **层级图改用嵌套 `children` 输入（照抄对照实现）** — 落选：递归 schema 变更面更大，且内建渲染器要新增
  「树的嵌套框布局」算法（分层布局 ≠ 包含布局）。本轮沿用扁平 `nodes`/`edges`（父→子边即包含），
  把"嵌套容器/集群框"列为未做——**层级图与 `block` 共用分层布局，差别在默认方向、无箭头连线与层内居中**，
  这一点在 SKILL 与本节如实写明，不假装它是全新的布局能力。
- **层级图保留箭头（照抄对照实现）** — 落选：包含关系画箭头会被读作数据流；用边级 flag 控制箭头又会让
  同一图型出现两种读法。读法由图型决定，边不再叠加图层语义。
- **各层居中改为"父节点居中于其子节点之上"（真正的 tidy tree）** — 落选：需要自底向上/自顶向下的树布局
  算法与子树平移，风险与工作量都上一个量级；本轮用「层内相对最宽层居中」，常数级实现且画幅安全。
  父居中留待后续批次（届时会有嵌套容器一起做）。
- **允许符号形状带文字（把实心圆渲染成带文字的圆）** — 落选：黑底黑字物理上不可见，等于承诺一个做不到
  的渲染；改为"渲染忽略 + V18 告警"，让丢失可见。
- **把 V18 写成条文依据** — 落选：已逐字核验的指南一部一章 4.3 原文里**没有**"符号节点不得带文字"这条
  要求。引一条不存在的条文比不判更糟；V18 如实标注「渲染契约非条文」，并在 `check.ts` 头注里写明理由。
- **不动 inputSchema，用环境变量选图型（仿 `SATI_FIGURE_RENDERER`）** — 落选：渲染器是进程级选择，图型
  是**每幅图**的属性（一案多幅图各不同），环境变量装不下。
- **把这次 schema 变更攒到下一次批量重录** — 落选：铁律是"改 schema 即重录"；且计划 §8 第 4 项已写明，
  与其它 schema 变更混批会让失配无法二分定位。

## Consequences

- **得到**：状态图（含初态/终态符号）与层级图可用，两个渲染器（builtin / graphviz / graphviz-wasm）行为一致；
  附图说明措辞、SKILL 路由表、入参描述同步；新增 9 条测试（渲染 4 / DOT 3 / 校验 1 / 附图说明 1）。
- **边界（未做）**：嵌套容器（集群框）与父节点居中的树布局；电路图、曲线/坐标图、时序图、DOT 通路的
  剖视图（计划 §8 的后续批次）；状态图的初态/终态是符号，**不能带文字**（要带文字的状态请用 `round`）。
- **代价**：一次 fixture 重录（`tests/fixtures/llm-replay/deepseek-v4-flash-basic/`，本 PR 内完成并校验）；
  V18 成为唯一一条"依据为渲染契约而非条文"的规则——它是产品契约的守卫，不是法条要求，措辞里已注明。
