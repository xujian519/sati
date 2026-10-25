/**
 * 争议范围粗定位（dispute_framing）的文本契约与解析器。
 *
 * OA 答复 / 无效 / 侵权三场景先粗定「争议法条/理由」与「涉及权项」，再让 `parse`
 * 按此过滤；顺序反了会让解析阶段把无关事实一起展开。该阶段**不声明 atom**：
 * 它由主代理（收口模式）或脚本化 executor 产出文本，没有 outputSchema 可约束，
 * 所以契约用两段固定标记表达，下游用 `parseDisputeFraming` 读取。
 *
 * 空集语义：两段都为空 ⇒ `unidentified: true`。调用方必须据此写「未识别争点」，
 * 不得写成「无争点」——后者会让下游误以为「已确认没有争点」，静默收窄提取面。
 */

/** 争议法条/理由段落标记。 */
export const DISPUTE_GROUNDS_HEADING = "## dispute_grounds";
/** 涉及权项段落标记。 */
export const DISPUTE_CLAIMS_HEADING = "## dispute_claims";
/** 未识别标记（两段都为空时的唯一合法表述）。 */
export const DISPUTE_UNIDENTIFIED_LABEL = "未识别争点";

/** 阶段输出的文本契约（manifest 描述与解析器共用，避免两处措辞漂移）。 */
export const DISPUTE_FRAMING_OUTPUT_CONTRACT =
  `按两段输出：${DISPUTE_GROUNDS_HEADING}（争议法条/理由，每行一条）与 ` +
  `${DISPUTE_CLAIMS_HEADING}（涉及权项，每行一条）。两段都识别不到时段落留空，` +
  `并写明「${DISPUTE_UNIDENTIFIED_LABEL}」——不得写成「无争点」。`;

/** 解析结果。 */
export type DisputeFraming = {
  /** 争议法条/理由（按出现顺序）。 */
  grounds: string[];
  /** 涉及权项（按出现顺序）。 */
  claims: string[];
  /** 两段都为空：调用方须写「未识别争点」，不得写「无争点」。 */
  unidentified: boolean;
};

/** 允许作为「未识别」占位行出现的标记（归一化后小写比较）。 */
const UNIDENTIFIED_MARKERS = new Set([
  "未识别",
  "未识别争点",
  "无法识别",
  "无法识别争点",
  "none",
  "n/a",
  "na",
  "-",
  "—",
]);

const HEADING = /^#{1,6}\s*(dispute_grounds|dispute_claims)\s*[:：]?\s*$/i;
const ANY_HEADING = /^#{1,6}\s+/;
const BULLET_PREFIX = /^\s*(?:[-*+•]|\d+[.、)])\s+/;

/** 去掉项目符号与包裹标点，用于判定「未识别」占位行。 */
function normalizeMarker(line: string): string {
  return line
    .replace(BULLET_PREFIX, "")
    .replace(/^[（(【\[]\s*/, "")
    .replace(/\s*[）)】\]]$/, "")
    .trim()
    .toLowerCase();
}

/**
 * 解析 `dispute_framing` 阶段输出。
 *
 * 只读取 `## dispute_grounds` / `## dispute_claims` 两个段落；其它标题会结束当前段。
 * 每行一条（接受 `-` / `*` / `•` / `1.` 等项目符号）；「未识别」「N/A」等占位行不计为条目。
 */
export function parseDisputeFraming(text: string): DisputeFraming {
  const grounds: string[] = [];
  const claims: string[] = [];
  let current: string[] | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = HEADING.exec(line);
    if (heading !== null) {
      current = heading[1]!.toLowerCase() === "dispute_grounds" ? grounds : claims;
      continue;
    }
    if (ANY_HEADING.test(line)) {
      current = undefined;
      continue;
    }
    if (current === undefined || line === "") continue;
    const item = line.replace(BULLET_PREFIX, "").trim();
    if (item === "" || UNIDENTIFIED_MARKERS.has(normalizeMarker(item))) continue;
    current.push(item);
  }
  return { grounds, claims, unidentified: grounds.length === 0 && claims.length === 0 };
}

/**
 * 生成「未识别争点」的标准输出。
 *
 * 自动执行路径（`patent_workflow_run` 的 manifest 模式）没有收口模式的阶段产出，
 * 回显输入原文会被下游误当成「已定争点」；这里显式落两段空标题 + 未识别标记。
 */
export function renderUnidentifiedDisputeFraming(reason?: string): string {
  // 说明放在两个标题之前：标题后的非占位行会被解析成条目，原因文本不能被当成争点。
  return [
    ...(reason !== undefined ? [reason] : []),
    DISPUTE_GROUNDS_HEADING,
    DISPUTE_CLAIMS_HEADING,
    DISPUTE_UNIDENTIFIED_LABEL,
  ].join("\n");
}
