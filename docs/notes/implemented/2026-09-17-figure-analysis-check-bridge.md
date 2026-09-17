# Agent Note: 分析轨 ↔ 核验轨桥接（数字型标记词法 + 多图一致性接线）

Status: implemented

## Problem

附图有两条轨：**分析轨**（`src/patent/figure/`，吃栅格图、经多模态模型产出组件/连接）与
**核验轨**（`src/patent/figuregen/`，吃结构化 FigureSpec、产出确定性规则发现）。两轨之间
没有通道，实测出三处空转：

1. `extractClaimRefs` 只认**符号库已知前缀**（`R1`/`C2`/`IC3`）——机械/实用新型的
   `壳体(10)与盖板(20)通过螺栓(30)连接` 返回 `[]`，故图文对齐在机械案上恒为空；
2. `checkFigureConsistency` 的跨图归并只看 `electrical.components`；`FigureComponent.refNumber`
   （即图面上的阿拉伯数字标记）**完全不参与**任何对齐 ⇒ 机械案的多图一致性报告恒为空；
3. `checkFigureConsistency` 在 `src/` 内**无生产调用方**（只有 barrel 导出与测试）——
   能力存在但运行时不可达。

## Decision

**词法分两档**（`figure/validator.ts`）：`extractClaimRefsDetailed` 返回
`{ symbols, numerals }`——电学档（符号前缀，原判据）与数字档（`壳体(10)` 括号形 +
`盖板20` 直连形）。数字档排除编号前缀（`式(1)`/`步骤(2)`/`图(3)`/`实施例1`/`第4条`）与
数量词/数值范围（沿用核验器 V10 的"紧跟列举分隔符或行尾"收窄判据），并用
`(?<!\d)…(?!\d)` 防四位年份被截成三位。`extractClaimRefs` 保持只返回电学档
（**行为不变**，避免电学图文对齐把普通数字判成元件）。

**多图一致性接数字档**（`figure/multi-figure-consistency.ts`）：新增
`numericComponents` 索引（`refNumber` → 名称 + 出现的图号）并参与冲突检测（同一数字标记
跨图名称不一致 → conflict）；`missingRefs` 按档分别对齐（电学档 ↔ `globalComponents`，
数字档 ↔ `numericComponents`），且**数字档只在"附图中确实存在数字型标记"时启用**——
否则电学案里的普通数字会被判成"未在附图中识别"（假警告）。

**两向骨架桥接**（新 `figure/bridge.ts`）：`analysisToFigureSpec`（分析结果 → 无几何
FigureSpec）使栅格图进入文字面规则；`figureSpecsToAnalysis`（FigureSpec → 分析骨架）使
规格化附图复用多图对齐。骨架**只取"标记 + 名称"、丢弃几何**——核验轨的画幅/布局规则对
本模块未参与排版的图无意义，保留几何会让调用方误以为那些判定可信。

**接线（生产调用方）**：
- `patent_figure_check`：`figures.length >= 2` 时自动跑 `checkFigureConsistency`，
  报告并入工具文本（单图不跑——无"跨图"可言）；
- `analyze_patent_figure`：给了 `claim_context` 时，把分析结果经骨架送 `checkFigures`
  （`skipLayoutRules: true`，只报 V2/V3/V4/V5）作为**追加的文本提示**，不改结构化输出。

为让骨架路径正确，`checkFigures` 新增 `skipLayoutRules`：跳过 V7（纸面尺寸 + 打印字高）
——骨架的画幅与字号由原图决定，用本模块布局结果判 V7 属**错误归因**（必然误报）。

## Alternatives considered

- **直接扩宽 `extractClaimRefs` 让它同时返回数字** — 落选：它被 `validateElectricalAnalysis`
  的图文对齐使用（"权利要求提及 R1 但未识别到元件"），混入数字会让电学案把 `20℃`
  `共3组` 判成"未识别元件"；两档分离才让两侧各自只认自己的判据。
- **把数字型组件并入现有的 `globalComponents`（复用一套索引）** — 落选：`globalComponents`
  的值类型是 `ElectricalComponent & {figureNumbers}`（含 symbol/category/value），数字型组件
  没有这些字段；硬并要么字段造假（`symbol: "unknown"` 被当成真实识别结果参与冲突判定），
  要么改类型把电学消费方一起改坏。分列索引是加法，不触碰既有语义。
- **在 analyze 工具里对该骨架跑全量规则（含 V1/V7）** — 落选：单张分析的图号可能是 3、
  5（V1 要求从 1 连续），画幅由原图决定（V7 用本模块布局必然误报）——两条都会制造
  稳定的假失败。故只报文字面规则，并显式声明"图幅/图集级规则不适用"。
- **不给 `skipLayoutRules`，改由调用方过滤 V7 发现** — 落选：过滤是"先算错再丢掉"，
  且 `layoutFigure` 对骨架走的是一条无意义路径（大骨架还会白算一遍）；选项让"不适用"
  成为显式契约。
- **让多图一致性发现成为 `patent_figure_check` 的 fail 级结论** — 落选：该工具的
  spec 路径已有 V1/V4 硬判据覆盖跨图标记冲突；一致性检查的增量是"数字档词法 + 文字引用
  缺漏"，其判据是启发式（词法可能漏也可能多），作为**报告**而非 fail 更诚实——需要阻断时
  已由附图门（figure-gate）按 V2/V4 拦截。
- **为栅格图另建独立工具/独立契约** — 落选：桥接只需"标记 + 名称"两个字段，既有
  `FigureSpec` / `FigureAnalysisResult` 已能承载；新契约要再维护一套类型与门禁接线。

## Consequences

**换来**：机械/实用新型案的多图一致性从"恒空转"变为可用（跨图名称冲突、文字引用缺漏
都能报出）；`checkFigureConsistency` 首次有生产调用方；客户提供的栅格图也能进确定性
文字面核验（此前只有模型判断）。

**付出**：

- `analyze_patent_figure` 在给定 `claim_context` 时输出**多一段文本**（结构化 `data` 不变）；
  上游若按"content 只有 1 块"断言需适配。
- `FigureConsistencyReport` 新增 `numericComponents` 字段（additive）；`summary` 的
  "合并识别 N 个元件"现在包含数字型组件——同一案件的数字会变化（口径变更，非缺陷）。
- 数字档词法**仍是启发式**：漏（句中夹缝形态）与多（未预料的编号前缀）都可能，故数字档
  只在附图中已有数字标记时启用、且一致性发现只作报告。
- 历史案卷若同一数字标记在不同图上名称不一致，现在会首次报出冲突（属判据修正）。

## 相关

- 计划：`docs/patent-figure-hardening-plan.md` §4 P1-4
- 相邻：`docs/notes/implemented/2026-09-17-figure-bracket-rules-v10-v11.md`（共用收窄词法）、
  `docs/notes/implemented/2026-09-17-figure-v4-label-normalization.md`（名称归一化）
- 代码：`src/patent/figure/validator.ts`、`src/patent/figure/multi-figure-consistency.ts`、
  `src/patent/figure/bridge.ts`、`src/patent/figuregen/check.ts`（`skipLayoutRules`）
- 测试：`tests/patent/figure-bridge.spec.ts`、`tests/patent/figuregen/tools.spec.ts`
