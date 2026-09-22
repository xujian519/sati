# Agent Note: 专利附图法域档案（office-profile）

Status: implemented

## Problem

图号写法、纸面常数与"字高是否可辨"此前散在三处硬编码：`render-svg.ts` 的 `figureCaption(figureNo, jurisdiction)` 只有 cn/us 两支；`page-contract.ts` 的页边距是**单一套**常数且自陈"实践惯例"（`MIN_PRINTED_FONT_MM = 2.0` 被 CN 与 US 共用，而 37 CFR 1.84(p)(3) 与 PCT Rule 11.13(h) 都要求 0.32cm=3.2mm）；`check.ts` 的 V7 用同一个 2.0mm 判所有法域。后果是具体缺陷：一份字高 2.5mm 的图在 Sati 里"通过"，送 PCT/US 却是不合格；US 单视图被画上 `FIG. 1`（1.84(u)(1) 明文禁止）。

## Decision

新增 `src/patent/figuregen/office-profile.ts` 作为**唯一事实源**：`TARGET_OFFICES = ["cnipa","pct","uspto"]`，每个档案含 `paper`/`margins`/`minCharHeightMm`(可选)/`practicalMinCharHeightMm`(可选)/`captionStyle`/`captionOnlyWhenMultiple`/`forbidCaptionWhenSingle`/`sheetNumbering`/`reductionRatio`/`provisions`（条文原句，逐条溯源）。配套纯函数：`officeProfile`、`officeForJurisdiction`、`profileForJurisdiction`、`printableArea`、`shouldRenderCaption`、`figureCaption`、`sheetNumberText`、`minCharHeight`。档案实例深冻结。

**每个数值都来自 2026-09-22 的官方一手文本核验**（CN 国知局公布 PDF 的指南 4.2/4.3/5.6、PCT Rule 11.5/11.6(c)/11.13(h)、行政规程 207(b)(iii)、37 CFR 1.84(f)(1)/(g)/(p)(3)/(t)/(u)(1)，经 eCFR versioner API + govinfo + MPEP 608.02 三方互校），逐句原句落在 `skills/patent-illustrator/references/{cn,pct,uspto}-drawing-rules.md`。

三条取值规则：
1. **两种单位并列的"至少"取较大值**：1.84(g) 写「top margin of at least 2.5 cm. (1 inch)」「right side margin of at least 1.5 cm. (5/8 inch)」——取 25.4mm / 15.875mm（较大者必同时满足两处）。
2. **派生可印区不得超条文自陈的可用面上限**（A4 上 170×262mm），有测试锁住内在一致性。
3. **没有条文数值的地方不编数值**：CN 无"附图中文字"的字高条文（五部一章 5.2 的 3.5mm 是纸件申请**正文**要求），故 `minCharHeightMm` 留空、另设实践下限 2.0mm 且核验报告明确标注"实践下限（非法条数值）"。

## Alternatives considered

- **照抄姊妹项目 deepseek-harness 的档案数值** — 落选，且已实证有分歧：它的 `uspto.margins.rightMm = 15` 只取了公制值，低于 1.84(g) 并列写出的 5/8 inch（15.875mm）；PCT/US 的 `bottomMm = 10` 与 Sati 原用的 15mm 也不同。两边数值分歧本身就是"必须回条文"的证据。
- **保留单一套常数、只给 US/PCT 加几个特例分支** — 落选。特例分支会让"哪个法域用哪个值"散在消费点（check/html/pixel-gate/submission-page 四处），正是本刀要消灭的形态；档案把差异收敛成数据。
- **列 EPO 档案** — 落选。EPC Rule 46/47 与 EPO Guidelines 的一手文本在核验窗口内取不到（HTTP 403）；未核验的档案会把工具无法引证的规则写进产品。
- **CN 字高改为不判或改判 3.5mm** — 落选。改判 3.5mm 会把五部一章 5.2 的"纸件申请正文"要求误当作附图条款（正文口径 ≠ 图内 14px 字高口径），且会让既有 CN 产物大面积报 warn；不判则倒退（既有 2.0mm 实践线消失）。折中是保留 2.0mm 并如实标注来源性质。
- **`minCharHeightMm` 对 CN 也填 2.0** — 落选。那会把没有条文支撑的数值伪装成法条；拆成两个字段后，"条文值"与"实践下限"在报告与档案里可区分。
- **档案放 `page-contract.ts`** — 落选。该文件是"物理单位换算 + 版式派生"，档案是"法域事实数据"；混在一起后 `page-contract` 会同时依赖法条与 CSS 单位，且 `office-profile` 被 `page-contract`/`check`/`html`/`pixel-gate`/`cad` 五处依赖时容易成环。

## Consequences

- 图号、纸面常数、字高下限、页码体例全部从档案取；`page-contract.ts` 保留 `DEFAULT_OFFICE`（cnipa）派生常量供过渡，新代码走 `printableArea`/`uniformFigureZoom(sizes, profile)`。
- 三法域的 V7 判据不同：cnipa 版心 170×257mm + 字高下限 2.0mm（实践），pct 170×262mm + 3.2mm（条文），uspto 168.725×261.6mm + 3.2mm（条文）。
- 新增档案测试（数值 × 条文、内在一致性、条件性、冻结实例）；生成侧基准新增 `office`/`caption_rendered`/`min_char_height_mm`/`font_below_limit` 四列。
- EPO 缺席是**有记录的产品边界**，不是遗漏：将来要加，先取得一手条文文本。
