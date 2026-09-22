/**
 * src/patent/figuregen — 法域档案（纸面常数 + 图号写法 + 页码写法的**单一事实源**）。
 *
 * 档案里每个数值都取自**已核验的官方条文原文**（取证日 2026-09-22，来源 URL 与逐句原文见
 * `docs/patent-figure-harness-parity-plan.md` 附录 A 与 `skills/patent-illustrator/references/
 * {cn,pct,uspto}-drawing-rules.md`）。**未核验的法域不列**：EPO 缺席——EPC Rule 46/47 与 EPO
 * Guidelines 的一手文本在取证窗口内取不到（403），而「未核实的档案会把工具无法引证的规则写进
 * 产品」，这正是姊妹项目 deepseek-harness 对 EPO 的同一处置。
 *
 * 三条刻意的取值规则（都记进决策记录）：
 * 1. **两种单位并列的"至少"取较大值**：37 CFR 1.84(g) 写作「top margin of at least 2.5 cm.
 *    (1 inch)」「right side margin of at least 1.5 cm. (5/8 inch)」——两个都是"至少"，取较大值
 *    （25.4mm / 15.875mm）才能同时满足；只取公制值（25 / 15）在字面上就低于英制下限。
 * 2. **可印区不得超出条文自陈的可用面上限**（A4 上为 170×262mm）：两者同源于条文，派生结果
 *    必须仍然合规，故有断言锁住（见 `tests/patent/figuregen/office-profile.spec.ts`）。
 * 3. **没有条文数值的地方不编数值**：CN 无"附图中文字"的字高条文（第五部分第一章 5.2 的
 *    3.5mm 是**纸件申请正文**的通用要求，非附图专有，且与附图内 14px 的实测口径不同）⇒
 *    `minCharHeightMm` 留空，另设 `practicalMinCharHeightMm` 并在报告里明确标注"实践下限
 *    （非法条数值）"，不把无条文支撑的数值伪装成法条。
 *
 * 图号与页码的**条件性**也在这里（渲染与核验共用同一判据，避免两条路径各自解释规则）：
 * - `captionOnlyWhenMultiple`：是否仅在附图两幅以上时标注图号。**CN 取 false**——指南一部一章
 *   4.3 把编号义务系于"总数在两幅以上"，并未禁止单幅编号，而附图说明（`brief.ts`）会引用
 *   "图1"，单幅保留图号既合法又与说明书呼应；**PCT/US 取 true**——PCT 指南 IP 5.141 与
 *   37 CFR 1.84(u)(1) 明令单幅不得编号、不得出现 "Fig."/"FIG."。
 * - `forbidCaptionWhenSingle`：单幅出现图号是否**构成缺陷**（供核验器 V16 判级；CN 只是
 *   "两幅以上才编"，未禁止，故 CN 为 false 且 V16 对 CN 不判）。
 * - `sheetNumbering`：页码体例（CN「用阿拉伯数字顺序编写」；PCT 行政规程 207(b)(iii) 与
 *   37 CFR 1.84(t) 均为「斜线分隔两个阿拉伯数字」形如 1/3，且**独立于**图号编号）。
 */

import type { Jurisdiction } from "./types.js";

/** 已核验的法域（新增取值前必须先取得一手条文原文；EPO 见头注）。 */
export const TARGET_OFFICES = ["cnipa", "pct", "uspto"] as const;

export type TargetOffice = (typeof TARGET_OFFICES)[number];

/** 图号前缀体例：图N（CN）/ Fig. N（PCT 指南 IP 5.141）/ FIG. N（37 CFR 1.84(u)(1)）。 */
export type CaptionStyle = "figure-number" | "fig" | "fig-upper";

/** 页码体例：顺序阿拉伯数字（CN）/ 斜线分数（PCT、US）。 */
export type SheetNumbering = "sequential" | "sheet-of";

export type OfficeProfile = {
  readonly office: TargetOffice;
  /** 用纸（毫米）。已核验的法域均为 A4（CN 写作 297×210，US 写作 21.0×29.7cm）。 */
  readonly paper: { readonly widthMm: number; readonly heightMm: number };
  /** 页边距（毫米，均为条文的**下限**）。 */
  readonly margins: {
    readonly topMm: number;
    readonly leftMm: number;
    readonly rightMm: number;
    readonly bottomMm: number;
  };
  /** 条文明文规定的图中数字/字母最小字高（毫米）；CN 无附图专有数值时为 undefined。 */
  readonly minCharHeightMm?: number;
  /** 无条文数值时保留的**实践下限**（毫米，明确标注为惯例，非法条数值）。 */
  readonly practicalMinCharHeightMm?: number;
  readonly captionStyle: CaptionStyle;
  /** 是否仅在附图两幅以上时才标注图号。 */
  readonly captionOnlyWhenMultiple: boolean;
  /** 单幅图出现图号是否构成缺陷（V16 判定用，**不是**渲染时的静默丢弃依据）。 */
  readonly forbidCaptionWhenSingle: boolean;
  readonly sheetNumbering: SheetNumbering;
  /** 缩小到该比例仍应清晰可辨（三法域均为 2/3：CN 指南一部一章 4.3、PCT Rule 11.13(c)、37 CFR 1.84(k)）。 */
  readonly reductionRatio: number;
  /** 论据条文（逐句溯源，报告与文档同源）。 */
  readonly provisions: readonly string[];
};

/** 三分之二规则（三法域同为 2/3，取自各自条文明文）。 */
const TWO_THIRDS = 2 / 3;

/** 深冻结：档案是全局共享实例，调用方就地改写会污染所有法域判定（测试锁住这一点）。 */
function freezeProfile(profile: OfficeProfile): OfficeProfile {
  Object.freeze(profile.paper);
  Object.freeze(profile.margins);
  Object.freeze(profile.provisions);
  return Object.freeze(profile);
}

const PROFILES: Readonly<Record<TargetOffice, OfficeProfile>> = {
  cnipa: {
    office: "cnipa",
    paper: { widthMm: 210, heightMm: 297 },
    margins: { topMm: 25, leftMm: 25, rightMm: 15, bottomMm: 15 },
    practicalMinCharHeightMm: 2.0,
    captionStyle: "figure-number",
    captionOnlyWhenMultiple: false,
    forbidCaptionWhenSingle: false,
    sheetNumbering: "sequential",
    reductionRatio: TWO_THIRDS,
    provisions: [
      "指南五部一章 4.2：说明书、说明书附图…用纸的规格均应为 297 毫米×210 毫米（A4）",
      "指南五部一章 4.3：顶部（有标题的，从标题上沿至页边）25 毫米、左侧 25 毫米、右侧 15 毫米、底部从页码下沿至页边 15 毫米",
      "指南一部一章 4.3：附图总数在两幅以上的，应当使用阿拉伯数字顺序编号，并在编号前冠以“图”字；该编号应当标注在相应附图的正下方",
      "指南一部一章 4.3：附图的大小及清晰度，应当保证在该图缩小到三分之二时仍能清晰地分辨出图中各个细节",
      "指南一部一章 4.3 + 五部一章 5.6：说明书附图应当用阿拉伯数字顺序编写页码；页码应当置于每页下部页边的上沿，并左右居中",
      "指南一部一章 4.3：附图的周围不得有与图无关的框线",
    ],
  },
  pct: {
    office: "pct",
    paper: { widthMm: 210, heightMm: 297 },
    margins: { topMm: 25, leftMm: 25, rightMm: 15, bottomMm: 10 },
    minCharHeightMm: 3.2,
    captionStyle: "fig",
    captionOnlyWhenMultiple: true,
    forbidCaptionWhenSingle: true,
    sheetNumbering: "sheet-of",
    reductionRatio: TWO_THIRDS,
    provisions: [
      "PCT Rule 11.5：The size of the sheets shall be A4 (29.7 cm x 21 cm)",
      "PCT Rule 11.6(c)：usable surface ≤ 26.2 cm x 17.0 cm；minimum margins top 2.5 / left side 2.5 / right side 1.5 / bottom 1 cm",
      "PCT Rule 11.13(c)：a photographic reproduction with a linear reduction in size to two-thirds would enable all details to be distinguished",
      "PCT Rule 11.13(h)：The height of the numbers and letters shall not be less than 0.32 cm",
      "PCT Rule 11.13(k)：figures numbered in Arabic numerals consecutively and independently of the numbering of the sheets",
      "PCT 申请人指南 IP 5.141：numbers of the figures should be preceded by the expression Fig.；单幅 should not be numbered and the abbreviation Fig. should not appear",
      "PCT 行政规程 Section 207(b)(iii)：sheet number = two Arabic numerals separated by a slant（for example, 1/3, 2/3, 3/3）",
      "PCT 申请人指南 IP 5.150：indications such as actual size or scale ½ on the drawings are not permitted",
    ],
  },
  uspto: {
    office: "uspto",
    paper: { widthMm: 210, heightMm: 297 },
    margins: { topMm: 25.4, leftMm: 25.4, rightMm: 15.875, bottomMm: 10 },
    minCharHeightMm: 3.2,
    captionStyle: "fig-upper",
    captionOnlyWhenMultiple: true,
    forbidCaptionWhenSingle: true,
    sheetNumbering: "sheet-of",
    reductionRatio: TWO_THIRDS,
    provisions: [
      "37 CFR 1.84(f)(1)：21.0 cm. by 29.7 cm. (DIN size A4)",
      "37 CFR 1.84(g)：top margin of at least 2.5 cm. (1 inch)、left side at least 2.5 cm. (1 inch)、right side at least 1.5 cm. (5/8 inch)、bottom at least 1.0 cm. (3/8 inch)；A4 上 sight no greater than 17.0 cm. by 26.2 cm.",
      "37 CFR 1.84(k)：scale must be large enough to show the mechanism without crowding when reduced to two-thirds；indications such as “actual size” or “scale 1/2” on the drawings are not permitted",
      "37 CFR 1.84(p)(3)：numbers, letters, and reference characters must measure at least .32 cm. (1/8 inch) in height",
      "37 CFR 1.84(p)(1)：reference characters、sheet numbers、view numbers must not be used in association with brackets or inverted commas, or enclosed within outlines",
      "37 CFR 1.84(t)：sheet number = two Arabic numerals placed on either side of an oblique line（1/3）",
      "37 CFR 1.84(u)(1)：view numbers must be preceded by the abbreviation “FIG.”；where only a single view is used it must not be numbered and “FIG.” must not appear",
      "37 CFR 1.84(g)：the sheets must not contain frames around the sight（should have scan target points on two catercorner margin corners）",
    ],
  },
};

/** 默认法域档案（page-contract 的派生常量与"未声明辖区"路径共用）。 */
export const DEFAULT_OFFICE_PROFILE: OfficeProfile = freezeProfile(PROFILES.cnipa);

/** 冻结实例表（档案是全局共享的，就地改写会污染所有法域的判定）。 */
const FROZEN_PROFILES: Readonly<Record<TargetOffice, OfficeProfile>> = {
  cnipa: DEFAULT_OFFICE_PROFILE,
  pct: freezeProfile(PROFILES.pct),
  uspto: freezeProfile(PROFILES.uspto),
};

/** 取法域档案（返回冻结的共享实例，调用方不得就地修改）。 */
export function officeProfile(office: TargetOffice): OfficeProfile {
  return FROZEN_PROFILES[office];
}

/** 辖区 → 档案键（三个工具对外仍用 cn/us/pct 这一维，档案内部用 cnipa/pct/uspto）。 */
export function officeForJurisdiction(jurisdiction: Jurisdiction = "cn"): TargetOffice {
  switch (jurisdiction) {
    case "us":
      return "uspto";
    case "pct":
      return "pct";
    default:
      return "cnipa";
  }
}

/** 辖区归档（工具入参 → 档案的单入口；未知取值报错而非静默按 cn 处理）。 */
export function profileForJurisdiction(jurisdiction: Jurisdiction = "cn"): OfficeProfile {
  return officeProfile(officeForJurisdiction(jurisdiction));
}

/** 该档案下的可印区（版心，毫米）。 */
export function printableArea(profile: OfficeProfile): { widthMm: number; heightMm: number } {
  return {
    widthMm: profile.paper.widthMm - profile.margins.leftMm - profile.margins.rightMm,
    heightMm: profile.paper.heightMm - profile.margins.topMm - profile.margins.bottomMm,
  };
}

/**
 * 该法域在该图幅数下**是否应当出现图号**（渲染与核验共用这一判据）。
 * 单幅且 captionOnlyWhenMultiple 时无图号——CN 指南一部一章 4.3 把编号系于"两幅以上"，
 * 37 CFR 1.84(u)(1) 与 PCT 指南 IP 5.141 则明令单幅**不得**编号。
 */
export function shouldRenderCaption(profile: OfficeProfile, figureCount: number): boolean {
  return !(profile.captionOnlyWhenMultiple && figureCount < 2);
}

/**
 * 图号文本（无需标注时返回 undefined，调用方据此不画）。
 * `figureCount` 为本案附图总幅数（本案只有一幅时按档案规则可能不编号）。
 */
export function figureCaption(profile: OfficeProfile, figureNo: number, figureCount: number): string | undefined {
  if (!shouldRenderCaption(profile, figureCount)) {
    return undefined;
  }
  switch (profile.captionStyle) {
    case "fig":
      return `Fig. ${figureNo}`;
    case "fig-upper":
      return `FIG. ${figureNo}`;
    default:
      return `图${figureNo}`;
  }
}

/**
 * 页码文本：sheet-of 体例（PCT/US「斜线分隔两个阿拉伯数字」）或 sequential 体例（CN）。
 * 非法入参不静默纠正——页码错位是会被形式审查抓的缺陷，宁可 fail-loud（由调用方校验）。
 */
export function sheetNumberText(profile: OfficeProfile, index: number, total: number): string {
  return profile.sheetNumbering === "sheet-of" ? `${index}/${total}` : String(index);
}

/** 判 V7 用的字高下限：条文数值优先；缺条文时给出实践下限并**标注其来源性质**。 */
export function minCharHeight(profile: OfficeProfile): { mm: number; basis: "statute" | "practice" } | undefined {
  if (profile.minCharHeightMm !== undefined) {
    return { mm: profile.minCharHeightMm, basis: "statute" };
  }
  if (profile.practicalMinCharHeightMm !== undefined) {
    return { mm: profile.practicalMinCharHeightMm, basis: "practice" };
  }
  return undefined;
}
