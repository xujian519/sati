/**
 * 审查意见/无效理由分型（纯规则，不调用模型）。
 *
 * 为什么单独一层：`dispute_framing` 在自动执行路径上固定是「未识别争点」
 * （manifestRun 不提供收口 executor），不能当作理由来源。理由必须从材料
 * 原文里按法条与常用表述识别。
 *
 * 只做**有据可查**的识别：一条理由可以命中多个代码（通知书常同时评新颖性
 * 与创造性）；规则没覆盖的行标 `other` 并保留原文，不替用户补写法律结论。
 */

import { normalizeText } from "../anchor/index.js";

export type GroundCode =
  | "novelty"
  | "inventiveness"
  | "clarity"
  | "enablement"
  | "amendment_scope"
  | "unity"
  | "other"
  | "unidentified";

/** 输出顺序固定，避免同一输入因匹配次序不同产出不同数组。 */
const CODE_ORDER: readonly GroundCode[] = [
  "novelty",
  "inventiveness",
  "clarity",
  "enablement",
  "amendment_scope",
  "unity",
  "other",
  "unidentified",
];

type Rule = {
  code: Exclude<GroundCode, "other" | "unidentified">;
  matches: (line: string) => boolean;
};

/** 第 X 条第 Y 款：允许全角/半角数字与空白差异（调用前已归一化）。 */
function articlePattern(article: number, paragraph: number): RegExp {
  return new RegExp(`第\\s*${article}\\s*条\\s*第\\s*${paragraph}\\s*款`, "u");
}

/** 只有条号、没有款号的引用（第 33 条、第 31 条）。 */
function articleOnly(article: number): RegExp {
  return new RegExp(`第\\s*${article}\\s*条`, "u");
}

const NOVELTY_ARTICLE = articlePattern(22, 2);
const INVENTIVENESS_ARTICLE = articlePattern(22, 3);
const CLARITY_ARTICLE = articlePattern(26, 4);
const ENABLEMENT_ARTICLE = articlePattern(26, 3);
const AMENDMENT_ARTICLE = articleOnly(33);
const UNITY_ARTICLE = articleOnly(31);

const RULES: readonly Rule[] = [
  {
    code: "novelty",
    matches: line => line.includes("新颖性") || NOVELTY_ARTICLE.test(line),
  },
  {
    code: "inventiveness",
    matches: line => line.includes("创造性") || INVENTIVENESS_ARTICLE.test(line),
  },
  {
    code: "clarity",
    // 第 26 条第 4 款同时覆盖「清楚」与「支持」，单看条号会把支持问题误报成清楚问题。
    matches: line => line.includes("不清楚") || (CLARITY_ARTICLE.test(line) && line.includes("清楚")),
  },
  {
    code: "enablement",
    matches: line => line.includes("公开不充分") || ENABLEMENT_ARTICLE.test(line),
  },
  {
    code: "amendment_scope",
    matches: line => line.includes("修改超范围") || line.includes("超出原说明书") || AMENDMENT_ARTICLE.test(line),
  },
  {
    code: "unity",
    matches: line => line.includes("单一性") || UNITY_ARTICLE.test(line),
  },
];

/** 「未识别争点」等占位写法：不算实质理由，也不产生 `other`。 */
const PLACEHOLDERS = new Set(["未识别", "未识别争点", "无法识别", "无法识别争点", "none", "n/a", "na", "-", "—"]);

/** Markdown 标题行不承载理由，避免「## 审查意见」被记成 `other`。 */
const HEADING = /^#{1,6}\s+/;

export type GroundEvidence = {
  code: GroundCode;
  /** 命中该代码的原文行（未归一化，便于人工核对）。 */
  text: string;
};

export type GroundClassification = {
  /** 去重后的代码，按固定顺序排列。 */
  codes: GroundCode[];
  /** 全文没有可用理由（与 `disputeFraming` 的空集语义一致）。 */
  unidentified: boolean;
  /** 每条代码的首个命中行。 */
  evidence: GroundEvidence[];
};

function isPlaceholder(line: string): boolean {
  return PLACEHOLDERS.has(normalizeText(line).trim().toLowerCase());
}

/**
 * 按行分型。
 *
 * 空行、Markdown 标题、已知占位行不参与判断。同一代码只保留首个命中行作为证据。
 */
export function classifyGroundsFromLines(lines: readonly string[]): GroundClassification {
  const hitCodes = new Set<GroundCode>();
  const evidence: GroundEvidence[] = [];
  let hasSubstantiveLine = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || HEADING.test(line) || isPlaceholder(line)) continue;
    hasSubstantiveLine = true;

    const normalized = normalizeText(line);
    let hitAnyRule = false;
    for (const rule of RULES) {
      if (!rule.matches(normalized)) continue;
      hitAnyRule = true;
      if (hitCodes.has(rule.code)) continue;
      hitCodes.add(rule.code);
      evidence.push({ code: rule.code, text: line });
    }
    if (!hitAnyRule) {
      hitCodes.add("other");
      if (!evidence.some(item => item.code === "other")) {
        evidence.push({ code: "other", text: line });
      }
    }
  }

  if (!hasSubstantiveLine) {
    return {
      codes: ["unidentified"],
      unidentified: true,
      evidence: [],
    };
  }

  const codes = CODE_ORDER.filter(code => hitCodes.has(code));
  return { codes, unidentified: false, evidence };
}

/** 从材料全文分型（换行切分；空文本得到 `unidentified`）。 */
export function classifyGrounds(text: string): GroundClassification {
  return classifyGroundsFromLines(text.split(/\r?\n/));
}
