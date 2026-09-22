# USPTO 附图规则（出海模式）— 逐条溯源

> 本文是 patent-illustrator 技能 USPTO 模式（`jurisdiction: "us"`）的规则底座。
> 与 CNIPA 模式（[cn-drawing-rules.md](cn-drawing-rules.md)）并立：图号标注改用 "FIG. N"，
> CNIPA 特有规则（摘要附图 V8、实用新型必须有附图 V9）跳过，违规信息引用 37 CFR 1.84。
> 条文依据以 USPTO 官方文本为准，本文为工程实现摘要。
>
> **2026-09-22 逐字核验**：37 CFR 1.84 各款原句经 eCFR 官方 versioner API
> （`ecfr.gov/api/versioner/v1/full/2026-09-01/title-37.xml?part=1&section=1.84`）、
> govinfo/GPO 的 CFR XML 与 USPTO MPEP § 608.02（其 "V. DRAWING STANDARDS" 逐字复制 1.84）
> 三方互校一致；下表数值均取自原文（不再写"以现行文本为准"）。

## 一、37 CFR 1.84（Drawings）要点

| 要点 | 规则要点 | 本模块消费点 |
|---|---|---|
| 图号标注 | 1.84(u)(1)：「The different views must be numbered in consecutive Arabic numerals, starting with 1… **View numbers must be preceded by the abbreviation "FIG."**」 | 渲染器（us 档案 `captionStyle: fig-upper`）；校验器 **V1**（编号连续） |
| **单视图不得编号** | 1.84(u)(1)：「**Where only a single view is used in an application to illustrate the claimed invention, it must not be numbered and the abbreviation "FIG." must not appear.**」 | 法域档案 `captionOnlyWhenMultiple: true` + 校验器 **V16**（单幅带号 warn）；机读图号走根元素 `data-figure-no` |
| **标记不得与括号/引号/圈号连用** | 1.84(p)(1)：「Reference characters (numerals are preferred), sheet numbers, and view numbers must be plain and legible, and **must not be used in association with brackets or inverted commas, or enclosed within outlines, e.g., encircled.**」 | 校验器 **V14**（非 cn 判"数字与括号/引号/圈号连用"）⚠️ **PCT/US 申请的图面不得写 `(20)`**——Sati 的 CN 惯用形「处理模块(20)」在 US/PCT 属禁止形态；1.84(u)(2) 对视图号重申同一禁令 |
| 附图标记 | 使用阿拉伯数字；同一标记始终表示同一部分 | 校验器 **V4**（一标记一组件）与渲染器 `data-ref` |
| 字高下限 | 1.84(p)(3)：「Numbers, letters, and reference characters **must measure at least .32 cm. (1/8 inch) in height.**」 | 法域档案 `minCharHeightMm: 3.2`；校验器 **V7**（font_size warn） |
| 标记与说明书对应 | 图中出现的每个参考字符应在说明书具体描述部分中描述（MPEP 608.02） | 校验器 **V2**（图→文 fail）/ **V3**（文→图 warn，保守） |
| 图中文字 | 除必要（不可缺）的词语外不应使用文字 | 校验器 **V5**（疑似注释性长文）+ **V12**（注释前缀/正文引用/尺寸标注/句末标点/图号入图） |
| 线条与复印质量 | 1.84(k)：「The scale … must be large enough to show the mechanism without crowding when the drawing is **reduced in size to two-thirds** in reproduction. **Indications such as "actual size" or "scale 1/2" on the drawings are not permitted** since these lose their meaning with reproduction in a different format.」 | 渲染器构造期不变式（仅 `#000000`/`#FFFFFF`）；校验器 **V7**（画幅/字高）+ **V12**（比例/尺寸标注，非 cn） |
| 幅面与边距 | 1.84(f)(1)：21.0×29.7cm（DIN size A4）；1.84(g)：「a **top margin of at least 2.5 cm. (1 inch)**, a **left side margin of at least 2.5 cm. (1 inch)**, a **right side margin of at least 1.5 cm. (5/8 inch)**, and a **bottom margin of at least 1.0 cm. (3/8 inch)**, thereby leaving a **sight no greater than 17.0 cm. by 26.2 cm.** on A4」 | 法域档案 `margins`（并列的公制/英制两处"至少"**取较大值**：25.4/25.4/15.875/10mm）；A4 HTML 版式与落版页从档案取边距 |
| 图页不得加框、宜有扫描定位十字 | 1.84(g)：「The sheets **must not contain frames** around the sight (i.e., the usable surface), but **should have scan target points (i.e., cross-hairs)** printed on two catercorner margin corners.」 | 版式不画框线；扫描十字**未实现**（"should"级建议，由代理师按提交格式决定，见下方工程边界） |
| 黑白限制 | 1.84(a)(1) 黑白为常规；1.84(a)(2) 彩色限于外观设计，实用申请须呈请（petition）且须修说明书；「**Color drawings are not permitted in international applications** (see PCT Rule 11.13)」 | 渲染器不变式（两辖区一致）；彩色模式**未实现**（见下方工程边界） |
| 页码 | 1.84(t)：图纸连续编号，「The number of each sheet **should be shown by two Arabic numerals placed on either side of an oblique line**」（形如 1/3，独立于视图号） | 法域档案 `sheetNumbering: "sheet-of"` + 落版页页码 + 校验器 **V17** |

## 二、与 CNIPA 模式的规则差异

| 规则 | CNIPA | USPTO |
|---|---|---|
| V8 摘要附图 | 适用（多图应指定一幅） | **跳过**（无摘要附图制度） |
| V9 实用新型必须有附图 | 适用 | **跳过**（无实用新型制度） |
| V10/V11 括号按面判定 | 适用（细则第 22 条） | 适用（37 CFR 1.84；US 权利要求通常仍带括号标记） |
| 图号标注 | "图1"（单幅也标） | "FIG. 1"；**单幅不得编号、不得出现 "FIG."** |
| 字高下限 | 无附图专有数值（实践下限 2.0mm） | **3.2mm**（1.84(p)(3)） |
| 页边距 | 上25/左25/右15/下15mm（指南五部一章 4.3） | 上/左 ≥25.4、右 ≥15.875、下 ≥10mm（1.84(g) 两种单位取较大值） |
| 页码体例 | 顺序阿拉伯数字 | 1/3 斜线分数（1.84(t)） |
| 标记与括号连用 | 未禁止（惯用形「处理模块(20)」） | **禁止**（1.84(p)(1)） |
| 附图说明措辞 | 中文模板（细则第 20 条第(四)项） | 英文 "FIG. N is a ... according to an embodiment." |
| 法条引用 | 细则第 20/21/22 条、审查指南 | 37 CFR 1.84、MPEP 608.02 |

## 三、工程边界（诚实声明）

- 本模式覆盖示意图类附图（流程图/框图）的生成与核验；外观设计（design patent，37 CFR 1.152）
  图片类附图不适用，与 CNIPA 模式同一边界。
- **未实现**：彩色附图模式（1.84(a)(2) 的呈请程序 + 说明书首段插入条款）、图页扫描定位十字
  （1.84(g) 的 "should have scan target points"）。两者都由代理师按最终提交格式决定。
- 页边距取值的取舍：1.84(g) 并列公制与英制两处"至少"，本模块**取较大值**（较大者必同时满足
  两者）；若代理师按仅取公制值排版（右 15mm、下 10mm、上/左 25mm），仍然合规。
- 正式提交前由美国专利律师/代理人复核。
