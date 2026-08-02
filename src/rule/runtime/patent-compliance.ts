/**
 * 宪法规则引擎 — 内置资产加载（专利合规规则）。
 *
 * 资产路径定位顺序（对齐 BCIP paths.rs 的设计）：
 *   1. 环境变量 SATI_RULES_DIR（目录，其下 patent/compliance.yaml）
 *   2. 当前工作目录 rules/patent/
 *   3. 仓库根 rules/patent/（以 package.json 向上定位）
 * 全部失败时返回空规则集 + 警告（不抛错，门禁降级为放行）。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuleSet } from "../protocol/types.js";
import { loadRuleSetFromFile } from "./RuleLoader.js";
import { candidateRuleDirs } from "./asset-location.js";

const COMPLIANCE_FILE = "compliance.yaml";

export type PatentComplianceLoadResult = {
  ruleSet: RuleSet;
  source: string | null;
  warnings: string[];
};

/** 加载内置专利合规规则集；找不到资产时返回空规则集并附警告。 */
export function loadPatentComplianceRuleSet(): PatentComplianceLoadResult {
  const warnings: string[] = [];
  for (const dir of candidateRuleDirs()) {
    const path = join(dir, COMPLIANCE_FILE);
    if (!existsSync(path)) continue;
    try {
      const loaded = loadRuleSetFromFile(path);
      return {
        ruleSet: loaded.ruleSet,
        source: loaded.source,
        warnings: [...warnings, ...loaded.warnings.map(w => w.message)],
      };
    } catch (error) {
      warnings.push(`规则资产加载失败 ${path}: ${(error as Error).message}`);
    }
  }
  warnings.push("未找到专利合规规则资产（SATI_RULES_DIR 或 rules/patent/compliance.yaml），门禁降级为放行");
  return { ruleSet: { rules: [] }, source: null, warnings };
}
