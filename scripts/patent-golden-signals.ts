/**
 * 为金标语料补写子图结论信号（#830 R1）。
 *
 * 背景：normalizeGoldenCase 此前丢弃 signals → 金标路径的 A26.3/A26.4 维度
 * 恒走"确定性代理"（signalSource=deterministic、列入 unverifiedDimensions），
 * 子图结论永远进不了金标回归，A26.4 在金标集上从未被真正核验。
 *
 * 本脚本按每件金标的**实际内容**判定并写入 signals：
 * - A26.3（enablement）：说明书是否充分公开（缺章节/缺实施例/效果无定量的缺陷件判否）；
 * - A26.4（claimBreadth）：权要是否清楚、是否以说明书为依据
 *   （不确定用语件 clarityOk=false；无说明书支撑的特征件 supportOk=false）。
 *
 * 判定为**确定性启发式**（读文本关键词/章节/特征命中），不调模型——保持金标
 * 回归零 LLM、可离线复现。写入后需人工复核：这是"录制的子图结论"，不是
 * 子图当场的真实输出（子图 live 输出见 `pnpm eval:patent-drafting --live`）。
 *
 * 来源标注（#847）：每件金标的 `signals` 带 `source: "recorded"`——语料层
 * 自带可辨识标记，报告与下游据此区分「录制的结论」与「子图真实结论」，
 * 避免后续误用。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkEffectQuantification, checkSectionCompleteness } from "../src/patent/spec/checks.js";

const GOLDEN = join(process.cwd(), "tests/patent/fixtures/drafting-golden/cases.jsonl");

/** A26.4 清楚性：权利要求中的不确定用语（与 claim-lint 规则 1 同词表）。 */
const UNCERTAIN_TERMS = ["等", "约", "适当", "可以", "基本上", "大致"];

/** A26.3 充分公开的自述缺陷词（说明书自认缺实施方式/无法实施）。 */
const DISCLOSURE_DEFECT_MARKERS = ["未提供实施例", "缺少实施例", "无具体实施方式", "无法实施", "效果无法验证"];

function hasEmbodiment(spec: string) {
  return /实施例\s*[0-9０-９一二三四五六七八九十]/.test(spec);
}

/**
 * A26.3 充分公开的确定性判定。
 *
 * 复用项目既有规则（spec/checks.ts）：章节完整性 + 效果量化，避免另造口径。
 * 判否条件：缺必需章节 / 无实施例 / 效果套话无定量 / 自述缺陷。
 */
function judgeEnablement(spec: string) {
  const missingSections = checkSectionCompleteness(spec);
  const vagueEffects = checkEffectQuantification(spec);
  const hasEmb = hasEmbodiment(spec);
  const selfReported = DISCLOSURE_DEFECT_MARKERS.filter(marker => spec.includes(marker));
  const sufficientlyDisclosed =
    missingSections.length === 0 && hasEmb && vagueEffects.length === 0 && selfReported.length === 0;
  const reasons = [];
  if (missingSections.length > 0) reasons.push(`缺章节：${missingSections.join("/")}`);
  if (!hasEmb) reasons.push("无实施例");
  if (vagueEffects.length > 0) reasons.push(`效果无定量：${vagueEffects[0]}`);
  if (selfReported.length > 0) reasons.push(`自述缺陷：${selfReported[0]}`);
  return { sufficientlyDisclosed, reasons };
}

function findUncertainTerms(claims: string) {
  return UNCERTAIN_TERMS.filter(term => claims.includes(term));
}

/** 权要特征是否在说明书中出现（连续子串，确定性）。 */
function unsupportedFeatures(claims: string, spec: string, requiredFeatures: string[] | undefined) {
  const missing = [];
  for (const feature of requiredFeatures ?? []) {
    if (!spec.includes(feature)) missing.push(feature);
  }
  // 权要特征候选：逐权项取「其特征在于」之后的特征部分，按分句切分
  // （口径对齐 claim-breadth 的 extractClaimFeatures，但**不**取整句标题）。
  for (const claim of claims.split(/\n+/)) {
    const body = claim.split("其特征在于")[1] ?? claim;
    for (const segment of body.split(/[，,；;。]/)) {
      const cleaned = segment
        .replace(/^\s*(?:其特征在于|其中|并且|且|还|所述)+/u, "")
        .replace(/^\s*根据权利要求\s*[0-9、,，和或及与\-~～至到\s]+?所述(?:的)?/u, "")
        .replace(/^\s*[0-9０-９]+\s*[.、．,，:：]?\s*/u, "")
        .trim();
      if (cleaned.length < 4) continue;
      if (/^(?:其特征在于|包括|包含|所述)$/u.test(cleaned)) continue;
      // 主题名称（"一种双层真空保温容器"）不是技术特征，不作支持性判定。
      if (/^一种.+容器$/.test(cleaned)) continue;
      if (!spec.includes(cleaned) && !missing.includes(cleaned)) missing.push(cleaned);
    }
  }
  return missing;
}

const lines = readFileSync(GOLDEN, "utf8")
  .split("\n")
  .map(line => line.trim())
  .filter(Boolean);

const out = lines.map(line => {
  const record = JSON.parse(line);
  const claims = record.claims ?? "";
  const spec = record.spec ?? "";

  // A26.3 充分公开：章节齐全 + 有实施例 + 效果有定量 + 无自述缺陷。
  const enablement = judgeEnablement(spec);
  const sufficientlyDisclosed = enablement.sufficientlyDisclosed;

  // A26.4 清楚：无不确定用语。
  const uncertain = findUncertainTerms(claims);
  const clarityOk = uncertain.length === 0;

  // A26.4 支持：权要特征（含金标必要特征）在说明书中均可找到。
  const missing = unsupportedFeatures(claims, spec, record.requiredFeatures);
  const supportOk = missing.length === 0;

  const signals = {
    // 来源口径（#847）：显式标注为「录制」——这些结论由上方确定性规则生成，
    // 不是 enablement / claim_breadth 子图的当场输出。语料层自带标记，
    // 后续人不必翻脚本就能看出两者口径不同（当场输出口径见 --live）。
    source: "recorded" as const,
    enablement: { sufficientlyDisclosed },
    claimBreadth: { supportOk, clarityOk },
  };
  record.signals = signals;
  console.log(
    `${record.id}: A26.3=${sufficientlyDisclosed ? "充分" : "不充分"} A26.4支持=${supportOk ? "有据" : "无据"} A26.4清楚=${clarityOk ? "清楚" : "不清楚"}` +
      (enablement.reasons.length > 0 ? `（${enablement.reasons.join("；")}）` : "") +
      (uncertain.length > 0 ? `（不确定用语：${uncertain.join("/")}）` : "") +
      (missing.length > 0 ? `（无支撑特征：${missing.slice(0, 3).join("/")}）` : ""),
  );
  return JSON.stringify(record);
});

writeFileSync(GOLDEN, `${out.join("\n")}\n`, "utf8");
console.log(`\n已写入 ${out.length} 件金标的子图结论信号 → ${GOLDEN}`);
