# Agent Note: DiffLine 收敛到单一权威类型

Status: implemented

## Problem

聊天栈里"一份 diff 数据结构"有 8 种声明：`chat/utils/messageTransforms.ts:1` 的权威定义
（`type: "added" | "removed"`）外加 7 个组件文件里的本地副本，以及 `ToolResultBlock` 的一个
内联匿名结构。7 份副本都把 `type` 写成 `string`。

两个方向都有成本：修改 diff 渲染要先去确认读的是哪一份；而"把副本删掉改 import"看似会
触发跨文件类型收紧——`createDiff` 的契约因此长期停在 `string`，`ToolResultBlock` 当年还专门
写了注释解释"不复用权威类型"的原因（`backlog.md` TD-UI-CHAT-N15 的建议因此是**放宽权威类型**）。

## Decision

**保留权威窄类型，删掉 7 份副本 + 1 处内联结构。**

立案建议（放宽为 `string` / 引入 `DiffLineType` 别名）基于"收紧会外溢"的假设。逐项验证后该假设
不成立：

- `calculateDiff` 的三个产出点写入的 `type` 全是字面量 ⇒ 运行时值域本就等于窄类型；
- 全仓消费 `.type` 的只有 `ToolDiffViewer.tsx`，且只区分 `added` / `removed` 两支；
- 真正的外溢面只有 `ToolResultBlock` 那个内联匿名结构，它随本波一并改为 `DiffCalculator`。

落地形态：7 处本地 `type DiffLine` 删除并改为 `import type { DiffLine } from "…/chat/utils/messageTransforms"`；
`ToolResultBlock.tsx` 的 `createDiff` 由 `Array<{ type: string; content: string; lineNum: number }>`
改为权威 `DiffCalculator`。

## Alternatives considered

- **按台账建议把权威类型放宽为 `string`** — 用"放宽"换取"能收敛"是把契约的精度换成一致性的
  假象：收紧之所以被认为不可能，只是因为没人验证过三个产出点与唯一消费点。验证成本是
  一次 typecheck，收益是保住类型精度。
- **引入 `DiffLineType` 别名但保留 7 份副本** — 只统一了字面量，没统一"哪份是权威"，改 diff
  渲染时仍要读 8 个地方。
- **保留副本、只加一条 eslint 规则禁止新增** — 存量 7 份仍在，规则约束不了"改哪一份能生效"。
- **顺手把 `type` 改成枚举成员而非字符串字面量联合** — 会波及序列化边界（createDiff 的输出
  来自 diff 算法、可能经 IPC 传递），收益仅是命名空间，不做。

## Consequences

- 全仓只剩一份 `DiffLine`；`createDiff` 的契约回到权威窄类型。
- 净删 7 份重复声明，无运行时 diff——`ui` typecheck 通过即证明没有任何 `type: string` 的构造点
  被破坏（若有，收紧会立刻编译失败）。
- 台账 TD-UI-CHAT-N15 条目回填 done，并更正副本数为 **7 + 1**（立案时漏记内联匿名结构）。
- 后续若要新增 diff 渲染点，import 一个类型即可，不再有"该用哪一份"的判断成本。
