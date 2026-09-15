# Agent Note: 知识库诊断显式化「可用性」与「自动注入」两项语义

Status: implemented

## Problem

`diagnostics.ts` 文件头声称「与 assemble.ts 的组装逻辑**严格对齐**：判定结果反映运行时实际启用的能力」。
但 `case-law` 这一行**同时在回答两个不同的问题**，而两者在「仅设 `SATI_CASE_DB`」的部署下答案相反
（issue #366 的 A1）：

| 问题 | 事实来源 | 仅设 `SATI_CASE_DB` 时的答案 |
|---|---|---|
| 判例能力可用吗？ | `resolveKnowledgeDbPaths().caseDb` → `patent_case_search` 工具 | **可用**（工具直用 `caseDb`） |
| 判例已装配自动注入了吗？ | `assemble.ts` 只从 `options.knowledgeDb` 接线（全文件 **0 处** `caseDb`） | **没有** |

诊断只输出一个 `status: "ready"`，于是第二问的答案被读成与第一问相同——`ready` 被当成了「已装配」。
这正是本 issue 的核心危害：不是「少了个功能」，而是「系统告诉你它是好的」。

复核期间另发现**同族的两处内不一致**（都在 `case-law` 一行上）：

1. **判定注释与代码矛盾**：注释写「probe 失败且主库存在 → missing（库损坏/表缺失）」，但 `config.ts:85`
   让 `caseDb` 回落成 `knowledgeDb` 本身，于是 `paths.caseDb` 恒真 → 实际恒报 `ready`。
   主库损坏/缺表时诊断说「就绪」，而**装配与工具会同时失败**。
2. **空主库 + 独立判例库时报 missing**：主库 `documents` 为空、但另配了有数据的独立 `SATI_CASE_DB` 时，
   诊断报 `missing`（沿装配主路径），而工具实际可用——同一行的语义在两个方向上互不一致。

> 本次同时复核了报告的 A2、A4：**均早已修复**（A2 由 `33b5d7cc7` 的 H1–H6 落地，A4 即 H3 的运行时降级联动），
> 不属本次变更。逐条处置状态见 `docs/knowledge-system-report.md` §2.6。

## Decision

采用 issue 评论中的**方案 ①（显式化语义）**——拆开语义、不改判定维度：

1. **契约拆分**（`KnowledgeCapability`）：
   - `status`：该能力在当前配置下**是否可用**（路径存在性 + knowledge.db 行数探测，**粗粒度**——
     不验证文件可打开、不验证外部服务可达）；
   - `autoInject`（新增，可选）：可用时其结果**是否经 memory provider 自动注入模型上下文**；
     `false` 表示仅经显式工具可达（工具名写进 `detail`）；缺省仅出现在非数据能力项上。
   文件头把契约与粗粒度边界写成显式条款，取代原来那句「严格对齐」。
2. **`case-law` 判定改为「至少一条检索通道可用」**（判据与 `assemble.ts` / `patentCaseSearch.ts` 逐条同源）：
   - 主库 `documents>0` → `ready` + `autoInject: true`（自动注入 + 工具）；
   - 独立 `caseDb`（**≠ 主库本身**）→ `ready` + `autoInject: false`（仅 `patent_case_search`）；
   - 两者皆无 → `missing`。
   这一条同时修掉了上面 Problem 1（主库不可探测却报 ready）与 Problem 2（空主库 + 独立库报 missing）。
3. **两个输出出口都要说出来**（否则语义只活在注释里）：
   - `formatKnowledgeCapabilities`：`ready` 且 `autoInject === false` 的行**也**带括号提示
     （其余 `ready` 行仍不带，清单保持可扫读）；
   - `logKnowledgeCapabilities`：全绿时点名未自动注入项 ——
     `[sati] knowledge: all ready（case-law 仅经工具可用，未自动注入）`。
4. `detail` 文案写全语义并标注判据边界（独立库路径**未做**存在性/行数探测，故写「未探测」）。
5. 测试 `diagnostics.spec.ts` 17 → **24** 用例，新增：独立库 ready+未注入、主库有判例 ready+已注入、
   主库空+独立库 ready（仅工具）、主库不可探测 → missing、`autoInject` 标注矩阵、
   `ready` 行带提示、全绿 info 文案点名；并把「全部 ready 不带提示」改为真实临时主库构造
   （原用例用伪路径，恰好掩盖了本次要区分的组合）。

## Alternatives considered

- **方案 ②：向装配对齐（legacy 分支报 `missing`，提示改用 `SATI_KNOWLEDGE_DB`）** — 落选；
  会让「仅设 `SATI_CASE_DB`」的部署在诊断里显示能力缺失，而 `patent_case_search` 实际可用，
  等于把一种说谎换成另一种。issue 的预期行为是「反映实际状态」，工具可用即状态可用。
- **只改 `detail` 文案、不加结构化字段** — 落选；问题的一半在**程序消费侧**
  （issue 原文点名「自动化降级判断基于 `ready` 会走错分支」），而 `detail` 是给人看的散文；
  且一行清单对 `ready` 行不带提示，散文到不了 CLI 输出。
- **给 `status` 加枚举值（`degraded` / `tool-only`）** — 落选；`status` 回答「是否可用」，
  「通道」是正交维度（IPC 恒 ready 且自动注入；判例可 ready 却仅工具）。此外会牵动 UI 的类型分支、
  文案与视觉验证，成本不抵收益。
- **`autoInject` 只在 `case-law` 上标注，其余缺省视为 true** — 落选；「缺省即真」正是本次要消除的
  隐含语义；逐项显式标注使「新增工具-only 能力必须标注」成为可 review 的规则。
- **顺带把 legacy `caseDb` 也做存在性/行数探测（一次修完 A5）** — 落选（本次）；
  其余路径型判据（`patentKgDb`/`lawDb`/`vectorsDb`）均不校验存在性，单给一处加会不一致；
  `detail` 已如实写「未探测」，留待 A5 专项统一。
- **在 UI 上加通道徽章** — 落选；UI 已无条件渲染 `detail`，语义句自然呈现；
  新增徽章属渲染改动，需 Before/After 截图，收益边际。

## Consequences

- **两处有意的行为变化**（都在 `case-law` 行，均已在 spec 中锁定）：
  ① 主库存在却不可探测、且无独立库 → `ready` 变 `missing`（此前与判定注释矛盾）；
  ② 主库无判例文档但配有独立判例库 → `missing` 变 `ready`（仅工具通道）。
  除此之外判定维度（路径存在性 + 主库行数）未变，`missing`/`disabled` 的分布不变。
- `autoInject` 是 additive 可选字段，`KnowledgeCapabilitiesResult`（gateway）与 UI 复用 canonical 类型，
  随 wire 自动带出；UI 的本地 wire 类型不读它，**渲染不受影响，无需视觉验证**。
- 未处置项：A3（中）、A6/A7/A8（低）——见 `docs/knowledge-system-report.md` §2.6，
  后续若继续处理，建议从 `case-law` 之外的诊断行（`semantic-vectors` 的 corpus 消费者）入手。
- 改动使 `src` 行数变化 → 按 #340 门禁须在同一 PR 内 `pnpm measure:update` 刷新基线。
