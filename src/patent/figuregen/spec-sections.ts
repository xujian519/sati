/**
 * src/patent/figuregen — 说明书文字面的启发式分节（权利要求面 / 说明书正文面）。
 *
 * 依据（本项目知识库已核）：细则第 22 条要求**权利要求**中的附图标记置于括号内；而
 * **说明书正文**的惯例是"名称+数字"不加括号。两种括号规则相反，故 V10（权利要求漏
 * 括号）/V11（正文多括号）必须按面判定，不能对混合文本整体扫括号。
 *
 * 分节是**启发式**（按小节标题定位），不引入新入参（零 schema 变更）。启发式失败时
 * **如实降级**：两个面都返回 undefined，由调用方在报告里注明"未分面，V10/V11 未生效"，
 * 绝不"猜一个面"再据此判违规。
 */

/** 权利要求书标题行（`## 权利要求书` / `权利要求书:` / 纯标题行）。 */
const CLAIMS_HEADING = /^\s*#{0,6}\s*权利要求书\s*[:：]?\s*$/u;
/** 说明书标题行（`## 说明书`）。 */
const DESCRIPTION_HEADING = /^\s*#{0,6}\s*说明书\s*[:：]?\s*$/u;
/** 说明书下属小节标题行（缺"说明书"总标题时以其首个子标题为正文起点）。 */
const DESCRIPTION_SECTION_HEADING =
  /^\s*#{0,6}\s*(?:技术领域|背景技术|发明内容|附图说明|具体实施方式|实施例|摘要)\s*[:：]?\s*$/u;
/** 附图说明小节标题（V11 排除该小节：其惯例是"1—混料器"式，不适用正文括号规则）。 */
const BRIEF_HEADING = /^\s*#{0,6}\s*附图说明\s*[:：]?\s*$/u;
/** 权利要求条目起始行（无"权利要求书"标题时的兜底判据之一）。 */
const CLAIM_ITEM = /^\s*1\s*[.、．]\s*\S/u;

export type SpecFaces = {
  /** 识别出的权利要求面（未识别出为 undefined）。 */
  claims?: string;
  /** 识别出的说明书正文面（未识别出为 undefined）。 */
  description?: string;
  /** 正文面去掉"附图说明"小节后的文本（V11 的判定范围；缺省等于 description）。 */
  descriptionSansBrief?: string;
  /** 分节结论（成功/失败原因，供报告如实展示）。 */
  reason: string;
};

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 首个匹配标题行的行首偏移（无则 undefined）。 */
function findHeadingOffset(text: string, pattern: RegExp): number | undefined {
  const starts = lineStarts(text);
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) return starts[index];
  }
  return undefined;
}

/** 按小节标题把说明书文字部分切成两个面（启发式；失败即如实降级）。 */
export function splitSpecFaces(specText: string): SpecFaces {
  if (specText.trim().length === 0) {
    return { reason: "文字部分为空" };
  }
  const claimsHeadingOffset = findHeadingOffset(specText, CLAIMS_HEADING);
  const descriptionHeadingOffset = findHeadingOffset(specText, DESCRIPTION_HEADING);
  const sectionHeadingOffset = findHeadingOffset(specText, DESCRIPTION_SECTION_HEADING);
  const descriptionOffset =
    descriptionHeadingOffset === undefined
      ? sectionHeadingOffset
      : sectionHeadingOffset === undefined
        ? descriptionHeadingOffset
        : Math.min(descriptionHeadingOffset, sectionHeadingOffset);

  if (descriptionOffset === undefined) {
    return {
      reason:
        "未找到说明书小节标题（说明书/技术领域/背景技术/发明内容/附图说明/具体实施方式），无法分面——V10/V11 未生效",
    };
  }

  let claimsOffset = claimsHeadingOffset;
  const beforeDescription = specText.slice(0, descriptionOffset);
  if (claimsOffset === undefined && (beforeDescription.includes("其特征在于") || CLAIM_ITEM.test(beforeDescription))) {
    // 无"权利要求书"标题但首段形如权利要求条目：以前导块为权利要求面。
    claimsOffset = 0;
  }

  const claims =
    claimsOffset === undefined || claimsOffset >= descriptionOffset
      ? undefined
      : specText.slice(claimsOffset, descriptionOffset).trim();
  const description = specText.slice(descriptionOffset).trim();

  // 附图说明小节（V11 排除）：从该标题到下一个"非附图说明"的标题行。
  let descriptionSansBrief = description;
  const briefOffset = findHeadingOffset(description, BRIEF_HEADING);
  if (briefOffset !== undefined) {
    const rest = description.slice(briefOffset);
    const nextStart = lineStarts(rest)
      .slice(1)
      .find(offset => DESCRIPTION_SECTION_HEADING.test(rest.slice(offset).split("\n")[0] ?? ""));
    const briefEnd = briefOffset + (nextStart ?? rest.length);
    descriptionSansBrief = (description.slice(0, briefOffset) + description.slice(briefEnd)).trim();
  }

  const parts = [
    claims === undefined ? "未识别权利要求面" : "已识别权利要求面",
    "已识别说明书正文面",
    briefOffset === undefined ? "未找到附图说明小节（V11 未排除任何文本）" : "已排除附图说明小节",
  ];
  return {
    ...(claims === undefined ? {} : { claims }),
    description,
    descriptionSansBrief,
    reason: parts.join("；"),
  };
}
