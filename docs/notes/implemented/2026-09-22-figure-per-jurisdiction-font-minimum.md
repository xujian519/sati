# Agent Note: 字高下限按法域（V7 的 CN 实践下限 vs PCT/US 条文数值）

Status: implemented

## Problem

V7 的"打印字高可辨性"分支用**一个**常数 `MIN_PRINTED_FONT_MM = 2.0` 判所有法域。而 PCT Rule 11.13(h)「The height of the numbers and letters shall not be less than 0.32 cm.」与 37 CFR 1.84(p)(3)「must measure at least .32 cm. (1/8 inch) in height」都要求 3.2mm（中文指南亦无附图专有的字高条文）。后果是具体缺陷：一份字高 2.5mm 的图在 Sati 里"通过"，送 PCT/US 却不合格。

## Decision

- V7 的字高下限改从档案取：`minCharHeight(profile)` 返回 `{ mm, basis }`，`basis: "statute"`（条文数值：pct/uspto 3.2mm）或 `"practice"`（实践下限：cnipa 2.0mm）。
- **CN 保留 2.0mm**：条文里唯一相关的毫米数值是五部一章 5.2「纸件申请的字高应当不低于 3.5 毫米」，但那是**纸件申请正文**的通用要求（口径是正文行文字号，不是图内 14px 字高），把它当附图条款用属错误归因。故 CN 不设条文值，改用实践下限，并在 finding 里写明"实践下限（非法条数值——CN 无附图专有的字高条文）"。
- 判据按法域取时，同一张图在两套档案下结论可以不同：新增基准用例与测试锁住这一点（同一张 12 步流程图在 cnipa 通过、在 uspto 报 2 条 warn）。
- V7 的**画幅**分支同样档案化（`printableArea(profile)`），误差信息在 message 里带 `profile.office`，使"按哪套纸面常数判的"在报告里可见。

## Alternatives considered

- **CN 改判 3.5mm（严格按 5.2）** — 落选。会把"纸件申请正文"的要求套到附图内文字上（口径不同），且会让既有一批 CN 产物新增告警、把真缺陷淹没。
- **CN 不判字高** — 落选（倒退）。既有 2.0mm 实践线会消失，等于用"删规则"掩盖"没有条文数值"，而这条线在实务上确实有用（缩到 2/3 后糊成一团的图要拦住）。
- **两个下限取较大值（CN 也 3.2mm）** — 落选。同上，会给 CN 引入无条文支撑的更严阈值；"更严"不等于"更对"。
- **只在报告里写 3.2mm/2.0mm 说明、判据仍用单一常数** — 落选。这正是"文档与实现不一致"的形态；报告与判据必须同源。
- **把下限写进 `Atom.description` 或 manifest 阶段描述** — 落选（隐藏清单纪律）：阈值只出现在档案、HITL 报告与规则底座文档里，不进入 worker 可见面。

## Consequences

- 同一份图在不同法域下的 V7 结论不同；`figure-gate` 与 `patent_figure_check` 的报告里会写明字高下限及其来源性质。
- 生成侧基准新增 `min_char_height_mm`（含 basis）与 `font_below_limit` 两列，法域差异进入基线审计面。
- CN 的 2.0mm 是**实践下限**这一事实写进了档案注释、规则底座（`references/cn-drawing-rules.md`）与 finding 文案三处——避免下一位读者把它当法条。
