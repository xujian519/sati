/**
 * 法律证据规则资产加载器。
 *
 * 资产定位顺序（与 `candidateDomainRuleDirs("legal")` 一致）：
 *   1. 环境变量 SATI_RULES_DIR（其下 legal/legal-evidence-rules.yaml）
 *   2. 当前工作目录 rules/legal/
 *   3. 仓库根 rules/legal/
 * 全部失败时返回默认权重引擎 + 警告（不抛错），并在工具输出中显式标注降级。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { candidateDomainRuleDirs } from "../../../rule/runtime/asset-location.js";
import { LegalEvidenceEngine } from "./engine.js";

const LEGAL_EVIDENCE_RULES_FILE = "legal-evidence-rules.yaml";

export type LegalEvidenceRulesLoadResult = {
  engine: LegalEvidenceEngine;
  source: string | null;
  warnings: string[];
};

/** 加载内置法律证据规则集；找不到资产时返回默认引擎 + 警告。 */
export function loadLegalEvidenceRulesEngine(): LegalEvidenceRulesLoadResult {
  for (const dir of candidateDomainRuleDirs("legal")) {
    const path = join(dir, LEGAL_EVIDENCE_RULES_FILE);
    if (!existsSync(path)) continue;
    try {
      const engine = new LegalEvidenceEngine(readFileSync(path, "utf8"), path);
      return { engine, source: path, warnings: engine.getWarnings() };
    } catch (error) {
      return {
        engine: new LegalEvidenceEngine(),
        source: null,
        warnings: [`法律证据规则资产加载失败 ${path}: ${(error as Error).message}，已回退默认权重`],
      };
    }
  }
  return {
    engine: new LegalEvidenceEngine(),
    source: null,
    warnings: [
      "未找到法律证据规则资产（$SATI_RULES_DIR/legal/legal-evidence-rules.yaml 或 rules/legal/legal-evidence-rules.yaml），已回退默认权重（权重与评分不受影响，但规则检查项清单缺失）",
    ],
  };
}
