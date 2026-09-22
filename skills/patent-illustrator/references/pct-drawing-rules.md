# PCT 附图规则（国际申请）— 逐条溯源

> 本文是 patent-illustrator 技能 PCT 模式（`jurisdiction: "pct"`）的规则底座，与 CNIPA
> （[cn-drawing-rules.md](cn-drawing-rules.md)）、USPTO（[uspto-drawing-rules.md](uspto-drawing-rules.md)）
> 并立。
>
> **2026-09-22 逐字核验**：条文原句经 WIPO 官方文本核对，来源与抓取日期如下（PCT 细则与行政
> 规程取 `wipo.int/pct/en/texts/`，申请人指南取官方 PDF `wipo.int/documents/d/pct-system/docs-en-gdvol1.pdf`
> 第 39–40 页），逐句原句见下表"原文"列。

## 一、纸面与版式

| 条文 | 原文（逐字） | 本模块消费点 |
|---|---|---|
| Rule 11.5 | "The size of the sheets shall be **A4 (29.7 cm x 21 cm)**." | 档案 `paper` 210×297mm |
| Rule 11.6(c) | "On sheets containing drawings, the surface usable shall not exceed **26.2 cm x 17.0 cm**. The sheets shall not contain frames around the usable or used surface. The minimum margins shall be as follows: – top: **2.5 cm** – left side: **2.5 cm** – right side: **1.5 cm** – bottom: **1 cm**." | 档案 `margins` = 25/25/15/**10**mm（下边距 1.0cm 小于 CN 的 15mm，故 PCT 版心更高 262mm） |
| Rule 11.7(a)(b) | "All the sheets … shall be numbered in consecutive Arabic numerals." / "The numbers shall be centered at the top or bottom of the sheet, but shall not be placed in the margin." | 页码置于版心内（落版页把页码画在版心上沿，符合本款） |
| 行政规程 Section 207(b)(iii) | "…a further series applying to the sheets of the drawings only … the number of each sheet of the drawings shall consist of **two Arabic numerals separated by a slant**, the first being the sheet number and the second being the total number of sheets of drawings (**for example, 1/3, 2/3, 3/3**)." | 档案 `sheetNumbering: "sheet-of"`；落版页页码形如 `1/3`；校验器 **V17** |

## 二、图面（Rule 11.11 / 11.13）

| 条文 | 原文（逐字） | 本模块消费点 |
|---|---|---|
| Rule 11.13(a) | "Drawings shall be executed in durable, black, sufficiently dense and dark, uniformly thick and well-defined, lines and strokes **without colorings**." | 渲染器构造期黑白不变式（仅 `#000000`/`#FFFFFF`） |
| Rule 11.13(c) | "The scale of the drawings and the distinctness of their graphical execution shall be such that a photographic reproduction with a **linear reduction in size to two-thirds** would enable all details to be distinguished without difficulty." | 校验器 **V7**（画幅/字高，缩 2/3 判据） |
| Rule 11.13(d) | "When, in exceptional cases, the scale is given on a drawing, it shall be **represented graphically**." | ⚠️ 本款**只**规定"比例若给出须用图形表示"，**并未禁止尺寸/比例标注**——不要把"不得标注比例"归到本款（见 5.150） |
| Rule 11.13(e) | "All numbers, letters and reference lines, appearing on the drawings, shall be simple and clear. **Brackets, circles or inverted commas shall not be used in association with numbers and letters.**" | 校验器 **V14**（非 cn 判"数字与括号/引号/圈号连用"）⚠️ **PCT 申请的图面不得写 `(20)`**——3.2 Sati 的 CN 惯用形在此属禁止形态 |
| Rule 11.13(g) | "Each element of each figure shall be in proper proportion to each of the other elements in the figure, except where the use of a different proportion is indispensable for the clarity of the figure." | 人工复核项（FigureSpec 不含比例信息，不判） |
| Rule 11.13(h) | "**The height of the numbers and letters shall not be less than 0.32 cm.** For the lettering of drawings, the Latin and, where customary, the Greek alphabets shall be used." | 档案 `minCharHeightMm: 3.2`；校验器 **V7**（font_size warn） |
| Rule 11.13(k) | "The different figures shall be numbered in **Arabic numerals consecutively** and independently of the numbering of the sheets." | 校验器 **V1**（图号连续）+ **V15**（多幅应有编号） |
| Rule 11.11(a) | "The drawings **shall not contain text matter**, except a single word or words, when absolutely indispensable, such as 'water,' 'steam,' 'open,' 'closed,' 'section on AB,' and, in the case of electric circuits and block schematic or flow sheet diagrams, **a few short catchwords** indispensable for understanding." | 校验器 **V5**（长文）+ **V12**（注释前缀/正文引用/尺寸标注/句末标点/图号入图）——PCT 对图面文字的约束比 CN 更严（限于"不可缺的短词"） |

## 三、图号写法与单幅不编号（申请人指南 IP 5.141 / 5.150）

**IP 5.141**（原文逐字，节选）：
> "Different figures on the sheets of drawings must be numbered in Arabic numerals consecutively and
> independently of the numbering of the sheets and, if possible, in the order in which they appear.
> **The numbers of the figures should be preceded by the expression Fig.**, whatever the language of
> the international application. **Where a single figure is sufficient to illustrate the claimed
> invention, it should not be numbered and the abbreviation Fig. should not appear.** Numbers and
> letters identifying the figures must be simple and clear and may not be used in association with
> brackets, circles, or inverted commas, except as regards partial figures intended to form one
> complete figure, irrespective of whether they appear on one or several sheets. In this case the
> complete figure may be identified by **the same number followed by a capital letter** (for example,
> **Fig. 7B**)."

消费点：
- 图号前缀 **`Fig.`**（注意：与 37 CFR 1.84(u)(1) 的 `FIG.` 大写不同；且"whatever the language of
  the international application"⇒ **中文提出的 PCT 申请，图号仍写 `Fig.`**）⇒ 档案 `captionStyle: "fig"`；
  附图说明引用与图号同源（`brief.ts` 用 `figureCaption`，故 PCT 的附图说明写"Fig. 1为……"）。
- 单幅不编号、不出现 `Fig.` ⇒ 档案 `captionOnlyWhenMultiple: true` + 校验器 **V16**。
- 部分视图用"同号 + 大写字母"（Fig. 7B）⇒ 校验器 **V14 只判小写字母后缀**（大写是合法形态，
  判它会与该指南冲突）。

**IP 5.150**（对 Rule 11.13(c) 的释义，原文逐字）：
> "Indications such as **actual size** or **scale ½** on the drawings or in the description, are not
> permitted, since these lose their meaning with reproduction in different format."

消费点：校验器 **V12** 的"比例/缩放标注"分支（仅非 cn）。⚠️ 依据引 **5.150**（或 37 CFR 1.84(k)），
**不要引 Rule 11.13(d)**（该款只要求比例用图形表示）。

## 四、与 CNIPA 模式的规则差异

| 规则 | CNIPA | PCT |
|---|---|---|
| V8/V9（摘要附图、实用新型） | 适用 | **跳过**（无对应制度） |
| V10/V11（权利要求/正文括号按面判定） | 适用（细则第 22 条） | **整族不适用**（PCT Rule 6.2(b) 只规定权利要求"可以"带括号标记，正文惯例未规定；不猜） |
| V12 比例/尺寸标注 | 不判（CN 无禁止性条文） | 判 warn（IP 5.150） |
| V13 图面词语非中文 | 判 warn | **不判**（国际申请可用任何语言） |
| V14 括号/引号/圈号连用 | 不判（CN 未禁止） | 判 warn（Rule 11.13(e)） |
| 图号写法 | "图1" | "Fig. 1"；**单幅不编号** |
| 字高下限 | 无附图专有数值（实践下限 2.0mm） | **3.2mm**（Rule 11.13(h)） |
| 页边距 | 上25/左25/右15/下15mm | 上25/左25/右15/下**10**mm |
| 页码体例 | 顺序阿拉伯数字 | `1/3`（行政规程 207(b)(iii)） |

## 五、工程边界（诚实声明）

- **未核验的法域不列**：EPO（EPC Rule 46/47 与 EPO Guidelines 的一手文本在核验窗口内取不到，
  HTTP 403）——「未核实的档案会把工具无法引证的规则写进产品」，故档案无 EPO。
- 国际申请**必须是 A4**（Rule 11.5），本模块不提供 letter 版式；US 侧 1.84(f)(2) 的 letter
  规格同样未实现（Sati 统一按 A4 排版）。
- 彩色附图未实现（Rule 11.13(a) 本就禁止着色）。
- 正式提交前由代理师/涉外代理人按受理局要求复核。
