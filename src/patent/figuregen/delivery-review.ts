/**
 * src/patent/figuregen — 交付面复核（DR 族 + 图面用语终检）：只看**已交付的 SVG**。
 *
 * 移植源：deepseek-harness `packages/patent/patent-tools/src/figure/delivery-review.ts`
 * （`checkFigureDelivery`，80 行纯函数）。DSH 版给的是无规则号的 `{check, message}`，
 * 本仓把它**编号化**并与既有规则族同域：位图/照片 = DR1、横向摆放 = DR2、整幅框线 = DR3，
 * 级别 fail（与 RC 族同权：都属于"交付出去就违反提交要求"的缺陷，区别于"能读但不清"的 warn）。
 *
 * 判据与阈值与 DSH 同源（常量同值：`FULL_SHEET_RATIO = 0.9`、`LANDSCAPE_RATIO = 1.05`）：
 * - DR1 位图/照片：SVG 文本含 `<image`（不区分大小写）即命中。依据《专利审查指南》第一部分
 *   第一章 4.3（照片只在特殊情况下允许）。
 * - DR2 横向摆放：画布宽 > 高 × 1.05 即命中（方形/近方形不算横向）。
 * - DR3 整幅框线：存在一个**闭合子路径**，其包围盒宽 ≥ 画布宽 × 0.9 **且**高 ≥ 画布高 × 0.9。
 *
 * **四处必要的本地适配（与 DSH 的差异，均有实测依据，不是自由发挥）**：
 * 1. DR3 只看**有描边**的闭合轮廓：Sati 自产图在根下有一个铺满画布的白底矩形
 *    （`render-svg.ts` 的 `documentSvg`：`fill="#FFFFFF"`，无描边），照搬 DSH 的"任意闭合
 *    子路径"判据会把**每一张自产图**判成整幅框线。框线是画出来的线，没有描边的白底矩形
 *    不可能是框线。
 * 2. DR2 加了"**竖向页放不下、旋转后放得下**"的前置条件（阈值 LANDSCAPE_RATIO 与 DSH 同值）：
 *    本仓的 SVG 是**内容画布**而非附图页，实测自产图的比例——单节点流程图 45.5×37.3mm
 *    （宽/高 1.22）、任意 LR 块图 118.5×37.3mm（宽/高 3.18）——照搬 DSH 的"只看宽高比"
 *    会把这两类**合规**图全判成横向摆放（前者甚至是方图）。加上版心条件后，判到的才是
 *    真缺陷：画幅宽于竖向版心（cn 170mm，见 `office-profile.ts` 的档案），横着放不进
 *    竖向附图页、必须旋转。版心取自**法域档案**（cn/us/pct 各不相同）。
 * 3. 图面用语终检（DSH 的 `figure-wording`）：本仓**不重复实现**用语规则，改调既有
 *    `wording-rules.ts` 的 `inspectWording`（规则号 V12/V13/V14 与级别沿用 `WORDING_KIND_SPEC`）。
 *    DSH 版的用语复核吃的是 FigureSpec 的 label；本仓 `patent_figure_check` 的 `svg_paths`
 *    分支拿得到 SVG 文本、拿不到 label，故改为从 SVG 的 `<text>` 抽可见文字再跑同一条规则。
 * 4. 图号标注（"图1" / "FIG. 1"）不算图面词语：它在附图**正下方**，是 4.3 要求、V15/V16
 *    判定的对象；把它当图面词语判 V12 会与 V15 自相矛盾（每张带图号的图都被报一次）。
 *
 * 依据条文：本仓逐字核验锚见 `skills/patent-illustrator/references/cn-drawing-rules.md`
 * （4.3 收录「附图的周围不得有与图无关的框线」⇒ DR3；「附图中的词语应当使用中文」⇒ V13；
 * 「附图中除必需的词语外，不得含有其他注释」⇒ V12；「附图标记应当使用阿拉伯数字编号」⇒ V14）。
 * ⚠️ DR1（照片只在特殊情况下允许）与 DR2（附图竖向绘制）的条文表述沿用 DSH 的法律依据说明，
 * **本仓锚里未逐字核验这两句**——引用时按"沿用 DSH 依据说明"理解，不要当成本仓已核验原文。
 *
 * 与 DSH 的另一处结构性差异：DSH 版的用语复核输出的是自由文本 warning；本仓的用语发现与
 * DR 发现同属一个返回数组，但**规则号不同族**（V12/V13/V14 vs DR1–DR3）、级别也不同
 * （warn/info vs fail）——接线处据此分流（DR 族进阻断路径，用语发现只进报告）。
 *
 * 粒度：一条用语发现对应**一处命中**（`inspectWording` 按拉丁词元逐个报，故"Input Sensor"
 * 出两条 V13，命中片段分别是 Input 与 Sensor）；结构侧的 V12/V13/V14 是"按规则聚合成一条 +
 * 多行证据"，两者的报告形态不同，接线处不混用。
 */

import { scanSvg } from "./render-check-scan.js";
import type { Scan } from "./render-check-types.js";
import { printableArea, profileForJurisdiction } from "./office-profile.js";
import type { Jurisdiction } from "./types.js";
import {
  inspectWording,
  WORDING_KIND_SPEC,
  type WordingIssueKind,
  type WordingRuleId,
  type WordingSeverity,
} from "./wording-rules.js";

/** 交付复核发现类别：位图/照片、横向摆放、整幅框线。 */
export type DeliveryReviewKind = "figure-photo" | "figure-orientation" | "figure-frame";

/** 一条交付复核发现。rule 为本仓规则号（DR1/DR2/DR3），severity 固定 "fail"。 */
export type DeliveryReviewFinding = {
  readonly rule: "DR1" | "DR2" | "DR3";
  readonly kind: DeliveryReviewKind;
  readonly severity: "fail";
  readonly message: string;
  readonly evidence?: readonly string[];
};

/**
 * 一条图面用语终检发现：规则号沿用既有用语规则（V12/V13/V14），级别取 `WORDING_KIND_SPEC`。
 *
 * 与 {@link DeliveryReviewFinding} 分开成型：DR 族的级别恒为 fail，用语发现的级别是
 * warn/info（"能读但不合体例"），两者在接线处走不同的路径。
 */
export type DeliveryWordingFinding = {
  readonly rule: WordingRuleId;
  readonly kind: WordingIssueKind;
  readonly severity: WordingSeverity;
  readonly message: string;
  readonly evidence?: readonly string[];
};

/** 交付复核的全部发现：DR 族（fail）+ 图面用语终检（warn/info）。 */
export type DeliveryFinding = DeliveryReviewFinding | DeliveryWordingFinding;

/** 整幅框线判据：闭合轮廓覆盖画布两轴的比例阈值（与 DSH 同值）。 */
const FULL_SHEET_RATIO = 0.9;

/** 横向判据：宽 > 高 × 该比值即判横向（方形/近方形不算横向；与 DSH 同值）。 */
const LANDSCAPE_RATIO = 1.05;

/**
 * 图号标注的形态（"图1" / "图 2a" / "FIG. 1"）：这类文本不是图面词语，跳过用语终检。
 *
 * 理由：图号按 4.3 标注在附图正下方（V15/V16 判的就是它的有无与写法），把它当图面词语
 * 报 V12「图面出现图号字样」会与 V15 自相矛盾——每张带图号的合规图都会被报一次。
 */
const FIGURE_NUMBER_ONLY = /^(?:图\s*\d+[a-z]?|fig(?:ure)?\.?\s*\d+[a-z]?)$/iu;

/** 用语规则的依据出处（cn 引 CN 条文；域外引 37 CFR / PCT 明文，与 check-rules.ts 同源）。 */
const WORDING_BASIS: Record<WordingRuleId, { readonly cn: string; readonly intl: string }> = {
  V12: {
    cn: "细则第 21 条第 3 款：附图中除必需的词语外，不应当含有其他注释",
    intl: '37 CFR 1.84(k) / PCT Guide IP 5.150: indications such as "actual size" or "scale 1/2" are not permitted',
  },
  V13: {
    cn: "指南一部一章 4.3：附图中的词语应当使用中文，必要时可以在其后的括号里注明原文",
    intl: "CNIPA Guidelines Part I Chapter 1 §4.3: wording in drawings should be in Chinese",
  },
  V14: {
    cn: "指南一部一章 4.3：附图标记应当使用阿拉伯数字编号",
    intl: "37 CFR 1.84(p)(1) / PCT Rule 11.13(e): reference numerals must not be used with brackets or inverted commas",
  },
};

/** 一位小数的毫米显示（证据行用）。 */
function mm(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** 两位小数的比值显示（证据行用）。 */
function ratio(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * 有描边的闭合子路径的包围盒（毫米）。
 *
 * 只收 `stroked` 的图形：填充图元（`stroke: none`）画不出线，不可能是"框线"。
 * @param scan - 图面事实。
 * @returns 每个候选闭合轮廓的包围盒宽高（毫米）。
 */
function strokedClosedBounds(scan: Scan): { readonly width: number; readonly height: number }[] {
  const bounds: { readonly width: number; readonly height: number }[] = [];
  for (const shape of scan.shapes) {
    if (!shape.stroked) continue;
    for (const subpath of shape.subpaths) {
      if (!subpath.closed || subpath.points.length === 0) continue;
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (const point of subpath.points) {
        const [x, y] = point;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      bounds.push({ width: maxX - minX, height: maxY - minY });
    }
  }
  return bounds;
}

/**
 * 图面上的可见文字：优先用扫描器给出的 `<text>` 内容，取不到时回退到正则抽取。
 *
 * 回退的理由：扫描器会跳过 `display:none`、未识别容器等子树；那些子树的文字虽不渲染，
 * 但文件里确实存在（可能被后续工具渲染出来），漏检不如多检。
 * @param scan - 图面事实。
 * @param svg - 完整 SVG 文本。
 * @returns 图面文字（已去首尾空白）。
 */
function figureTexts(scan: Scan, svg: string): string[] {
  const scanned = scan.texts.map(text => text.content.trim()).filter(content => content !== "");
  if (scanned.length > 0) return scanned;
  const extracted: string[] = [];
  for (const match of svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/giu)) {
    const content = (match[1] ?? "")
      .replace(/<[^>]*>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (content !== "") extracted.push(content);
  }
  return extracted;
}

/**
 * 复核一份已交付 SVG：位图/照片、横向摆放、整幅框线 + 图面用语终检。
 *
 * @param svg - 完整 SVG 文本（调用方负责先过安全门与可读性检查）。
 * @param options - `jurisdiction` 决定用语规则的法域适用性（缺省 cn）。
 * @returns 发现列表（报告顺序：DR1 → DR2 → DR3 → 用语终检）；无命中返回空数组。
 */
export function checkFigureDelivery(
  svg: string,
  options?: { readonly jurisdiction?: Jurisdiction },
): DeliveryFinding[] {
  const jurisdiction = options?.jurisdiction ?? "cn";
  const findings: DeliveryFinding[] = [];
  const scan = scanSvg(svg);

  // DR1 位图/照片：只看 SVG 文本里有没有 <image>（含 <image> 的任意写法与大小写）。
  if (/<image\b/iu.test(svg)) {
    findings.push({
      rule: "DR1",
      kind: "figure-photo",
      severity: "fail",
      message:
        "图面含位图或照片（<image>）：《专利审查指南》第一部分第一章 4.3 只在特殊情况下允许照片，" +
        "请确认属于允许情形，否则改用线条图",
      evidence: ["SVG 文本含 <image> 元素（位图/照片引用）"],
    });
  }

  const { widthMm, heightMm } = scan;
  if (widthMm !== undefined && heightMm !== undefined && heightMm > 0) {
    // DR2 横向摆放：画布宽明显大于高（方形/近方形不算），**且**该画幅竖向页放不下、
    // 旋转后放得下——"横着画且竖向附图页容不下"才是要人改的缺陷。
    const printable = printableArea(profileForJurisdiction(jurisdiction));
    const landscape = widthMm > heightMm * LANDSCAPE_RATIO;
    const tooWideForPortraitPage = widthMm > printable.widthMm;
    const fitsWhenRotated = heightMm <= printable.heightMm;
    if (landscape && tooWideForPortraitPage && fitsWhenRotated) {
      findings.push({
        rule: "DR2",
        kind: "figure-orientation",
        severity: "fail",
        message:
          `图为横向（${mm(widthMm)}×${mm(heightMm)} 毫米，宽于竖向版心 ${mm(printable.widthMm)} 毫米）：` +
          "《专利审查指南》第一部分第一章 4.3 要求附图竖向绘制，请旋转为纵向",
        evidence: [
          `画布 ${mm(widthMm)}×${mm(heightMm)}mm（宽/高 = ${ratio(widthMm / heightMm)}，阈值 ${LANDSCAPE_RATIO}；` +
            `竖向版心 ${mm(printable.widthMm)}×${mm(printable.heightMm)}mm）`,
        ],
      });
    }
    // DR3 整幅框线：有描边的闭合轮廓覆盖了画布两轴的九成。
    const frame = strokedClosedBounds(scan).find(
      bounds => bounds.width >= widthMm * FULL_SHEET_RATIO && bounds.height >= heightMm * FULL_SHEET_RATIO,
    );
    if (frame !== undefined) {
      findings.push({
        rule: "DR3",
        kind: "figure-frame",
        severity: "fail",
        message:
          "图面画有覆盖整幅图纸的边框：《专利审查指南》第一部分第一章 4.3「附图的周围不得有与图无关的框线」，" +
          "请删除外框，保留视图自身的轮廓",
        evidence: [
          `描边闭合轮廓包围盒 ${mm(frame.width)}×${mm(frame.height)}mm ≥ 画布 ${mm(widthMm)}×${mm(heightMm)}mm 的 ${FULL_SHEET_RATIO * 100}%`,
        ],
      });
    }
  }

  // 图面用语终检：复用既有用语规则（不重复实现规则），逐条跑 SVG 里的可见文字。
  for (const text of figureTexts(scan, svg)) {
    if (FIGURE_NUMBER_ONLY.test(text)) continue;
    for (const issue of inspectWording(text, jurisdiction)) {
      const spec = WORDING_KIND_SPEC[issue.kind];
      const basis = jurisdiction === "cn" ? WORDING_BASIS[spec.rule].cn : WORDING_BASIS[spec.rule].intl;
      findings.push({
        rule: spec.rule,
        kind: issue.kind,
        severity: spec.severity,
        message: `图面文字「${text}」${spec.describe}：「${issue.text}」（${spec.rule}，${basis}）`,
        evidence: [`图面文字「${text}」`, `命中：「${issue.text}」`],
      });
    }
  }

  return findings;
}
