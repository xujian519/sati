/**
 * 证据规则资产加载器（对齐 src/rule/runtime/patent-compliance.ts 的资产定位）。
 *
 * 资产路径定位顺序：
 *   1. 环境变量 SATI_RULES_DIR（目录，其下 patent/evidence-rules.yaml）
 *   2. 当前工作目录 rules/patent/
 *   3. 仓库根 rules/patent/（以 package.json 向上定位）
 * 全部失败时返回空规则集 + 警告（不抛错，引擎降级为默认权重）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { candidateRuleDirs } from "../../rule/runtime/asset-location.js";
import { EvidenceEngine } from "./engine.js";

const EVIDENCE_RULES_FILE = "evidence-rules.yaml";

export type EvidenceRulesLoadResult = {
  engine: EvidenceEngine;
  source: string | null;
  warnings: string[];
};

/** 加载内置证据规则集并构造引擎；找不到资产时返回默认引擎 + 警告。 */
export function loadEvidenceRulesEngine(): EvidenceRulesLoadResult {
  const warnings: string[] = [];
  for (const dir of candidateRuleDirs()) {
    const path = join(dir, EVIDENCE_RULES_FILE);
    if (!existsSync(path)) continue;
    try {
      const engine = new EvidenceEngine(readFileSync(path, "utf8"), path);
      return { engine, source: path, warnings: [...warnings, ...engine.getWarnings()] };
    } catch (error) {
      warnings.push(`证据规则资产加载失败 ${path}: ${(error as Error).message}`);
    }
  }
  warnings.push(
    "未找到证据规则资产（$SATI_RULES_DIR/patent/evidence-rules.yaml 或 rules/patent/evidence-rules.yaml），引擎降级为默认权重",
  );
  return { engine: new EvidenceEngine(), source: null, warnings };
}
