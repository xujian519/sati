/**
 * src/patent/figure — 生成侧声明 vs 识图结果的附图比对（纯函数）。
 *
 * 用途：把「出图时声明的标记清单」与「模型识图得到的标记清单」做确定性比对，报告
 * 缺标记、多标记、同号异名与同号异类型，供图文一致性闭环（生成 → 识图 → 比对）
 * 使用。本模块只回答两侧是否一致，不改写任何一侧。
 *
 * 本批边界：**只提供纯函数，不暴露成 builtin 工具**——新增工具会改动工具列表，
 * 触发 llm-replay fixture 重录（见 docs/development-standards.md 的重放契约）；
 * 待重录窗口再接线（barrel 导出由主代理统一添加，本模块不改 barrel）。
 *
 * 与 DSH 参考实现（packages/patent/patent-tools/src/figure/figure-comparison.ts）
 * 的差异：
 * - 标记口径只取**纯数字 1..999**（与本仓 V14 附图标记形态口径一致，见 bridge.ts）：
 *   字母前缀标记（S101/U1 等）不是附图标记，不参与比对，也不计入两侧组件数；
 * - 「类型」比对的是组件 `kind`（本仓 FigureComponent 既有字段，不臆造新字段），
 *   DSH 比的是图型；结果级 `figureType` 差异不在本批口径内（只比组件级）；
 * - 发现（finding）的 `kind` 取本仓四值，并附 `evidence` 证据行，便于人工复核。
 *
 * 纯函数：不读文件、不取时钟、不随机、不调用模型。
 */

import type { FigureAnalysisResult, FigureComponentKind } from "./types.js";

/** 一条比对发现。 */
export type FigureComparisonFinding = {
  /** 发现类型：缺标记 / 多标记 / 名称不符 / 类型不符。 */
  readonly kind: "missing-component" | "extra-component" | "name-mismatch" | "type-mismatch";
  /** 涉及的附图标记（空串表示两侧都没有可比对的标记）。 */
  readonly ref: string;
  /** 人类可读说明（中文）。 */
  readonly message: string;
  /** 证据行（声明侧与识图侧的取值）。 */
  readonly evidence?: readonly string[];
};

/** 比对报告。 */
export type FigureComparisonReport = {
  /** 声明侧组件数（去重后的可比对标记数）。 */
  readonly expectedCount: number;
  /** 识图侧组件数（去重后的可比对标记数）。 */
  readonly actualCount: number;
  readonly findings: readonly FigureComparisonFinding[];
  /** 无发现即 true。 */
  readonly consistent: boolean;
  /** 一句话摘要（中文）。 */
  readonly summary: string;
};

/** 参与比对的标记形态：纯数字 1..999（与本仓 V14 附图标记形态口径一致）。 */
const NUMERIC_REF_PATTERN = /^\d{1,3}$/u;

/** 单侧标记索引条目：名称 + 组件类型（均已 trim）。 */
type IndexedComponent = {
  /** 组件名称（去首尾空白；空串表示未识别出名称）。 */
  readonly name: string;
  /** 组件类型（FigureComponent.kind）。 */
  readonly kind: FigureComponentKind;
};

/**
 * 判断一个附图标记是否参与比对。
 *
 * 口径：去首尾空白后是纯数字且取值在 1..999。字母前缀标记（S101/U1 等）、
 * 空串与超出取值域的标记一律不参与。
 *
 * @param rawRef 原始标记串。
 * @returns 是否为可比对的附图标记。
 */
function isComparableRef(rawRef: string): boolean {
  const ref = rawRef.trim();
  if (!NUMERIC_REF_PATTERN.test(ref)) return false;
  const value = Number.parseInt(ref, 10);
  return Number.isInteger(value) && value >= 1;
}

/**
 * 把一侧的组件按标记归并成索引（同一标记重复出现时保留首个类型，名称取首个非空）。
 *
 * @param result 声明侧或识图侧的附图分析结果。
 * @returns 标记 → 组件条目，按标记数值升序。
 */
function indexComponents(result: FigureAnalysisResult): Map<string, IndexedComponent> {
  const index = new Map<string, IndexedComponent>();
  for (const component of result.components) {
    const ref = component.refNumber.trim();
    if (!isComparableRef(ref)) continue;
    const name = component.name.trim();
    const existing = index.get(ref);
    if (existing === undefined) {
      index.set(ref, { name, kind: component.kind });
      continue;
    }
    // 同一标记重复出现：类型保留首个；名称取首个非空（避免把「没识别出名字」说成「名字不一致」）。
    if (existing.name === "" && name !== "") index.set(ref, { name, kind: existing.kind });
  }
  return new Map(
    [...index.entries()].sort(([left], [right]) => Number.parseInt(left, 10) - Number.parseInt(right, 10)),
  );
}

/**
 * 摘要：只报出发生过的事，通过时明说通过。
 *
 * @param expectedCount 声明侧可比对标记数。
 * @param actualCount 识图侧可比对标记数。
 * @param findings 逐条发现。
 * @returns 中文一句话摘要。
 */
function buildSummary(
  expectedCount: number,
  actualCount: number,
  findings: readonly FigureComparisonFinding[],
): string {
  const count = (kind: FigureComparisonFinding["kind"]): number =>
    findings.filter(finding => finding.kind === kind).length;
  const missing = count("missing-component");
  const extra = count("extra-component");
  const renamed = count("name-mismatch");
  const retyped = count("type-mismatch");
  const parts = [`声明 ${String(expectedCount)} 个标记，识图 ${String(actualCount)} 个。`];
  if (missing > 0) parts.push(`缺标记 ${String(missing)} 个。`);
  if (extra > 0) parts.push(`多标记 ${String(extra)} 个。`);
  if (renamed > 0) parts.push(`名称不符 ${String(renamed)} 个。`);
  if (retyped > 0) parts.push(`类型不符 ${String(retyped)} 个。`);
  if (findings.length === 0) parts.push("图文比对通过。");
  return parts.join("");
}

/**
 * 比对「声明的附图」与「模型识图结果」。
 *
 * 判定口径：
 * - `missing-component`：声明侧有某标记，识图结果里没有（该部件在图上没被认出来）；
 * - `extra-component`：识图结果里有声明侧没有的标记（图上出现了没声明的部件）；
 * - `name-mismatch`：同一标记两侧名称不同（两侧名称去空白后比较；空名称不算冲突）；
 * - `type-mismatch`：同一标记两侧组件类型（`kind`）不同。
 *
 * 只比对纯数字标记（1..999）。`expected.imagePath` 与 `actual.imagePath` 可以不同
 * （一个是生成产物、一个是被分析的图），不因此报发现。
 *
 * @param expected 声明侧（出图时声明的标记清单）。
 * @param actual 识图侧（模型识别出的标记清单）。
 * @returns 比对报告：逐条发现 + 计数 + 摘要。
 */
export function compareFigureAnalysis(
  expected: FigureAnalysisResult,
  actual: FigureAnalysisResult,
): FigureComparisonReport {
  const expectedIndex = indexComponents(expected);
  const actualIndex = indexComponents(actual);
  const findings: FigureComparisonFinding[] = [];

  for (const [ref, declaration] of expectedIndex) {
    const recognized = actualIndex.get(ref);
    if (recognized === undefined) {
      findings.push({
        kind: "missing-component",
        ref,
        message: `标记 ${ref}${declaration.name === "" ? "" : `（${declaration.name}）`} 已在声明中列出，但识图结果未识别到`,
        evidence:
          declaration.name === "" ? [`声明标记：${ref}`] : [`声明标记：${ref}`, `声明名称：${declaration.name}`],
      });
      continue;
    }
    // 名称比对：两侧名称都非空且不同才算冲突；空名称不判冲突。
    if (declaration.name !== "" && recognized.name !== "" && declaration.name !== recognized.name) {
      findings.push({
        kind: "name-mismatch",
        ref,
        message: `标记 ${ref} 名称不符：声明「${declaration.name}」，识图为「${recognized.name}」`,
        evidence: [`声明名称：${declaration.name}`, `识图名称：${recognized.name}`],
      });
    }
    // 类型比对：组件类型（kind）不同即报；本仓不设「未识别类型」的豁免。
    if (declaration.kind !== recognized.kind) {
      findings.push({
        kind: "type-mismatch",
        ref,
        message: `标记 ${ref} 类型不符：声明为 ${declaration.kind}，识图为 ${recognized.kind}`,
        evidence: [`声明类型：${declaration.kind}`, `识图类型：${recognized.kind}`],
      });
    }
  }

  for (const [ref, recognized] of actualIndex) {
    if (expectedIndex.has(ref)) continue;
    findings.push({
      kind: "extra-component",
      ref,
      message: `标记 ${ref}${recognized.name === "" ? "" : `（${recognized.name}）`} 只出现在识图结果中，声明中未列出`,
      evidence: recognized.name === "" ? [`识图标记：${ref}`] : [`识图标记：${ref}`, `识图名称：${recognized.name}`],
    });
  }

  return {
    expectedCount: expectedIndex.size,
    actualCount: actualIndex.size,
    findings,
    consistent: findings.length === 0,
    summary: buildSummary(expectedIndex.size, actualIndex.size, findings),
  };
}
