/**
 * 宪法规则引擎 — 内置资产加载（专利合规规则）。
 *
 * 资产路径定位顺序（对齐 BCIP paths.rs 的设计）：
 *   1. 环境变量 SATI_RULES_DIR（目录，其下 patent/compliance.yaml）
 *   2. 当前工作目录 rules/patent/
 *   3. 仓库根 rules/patent/（以 package.json 向上定位）
 * 全部失败时返回空规则集 + 警告（不抛错，门禁降级为放行）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { ConstitutionalRule, RuleSet } from "../protocol/types.js";
import { applyRuleOverrides, asRecord, isRuleAction, loadRuleSetFromFile, mergeRuleSets } from "./RuleLoader.js";
import { candidateRuleDirs } from "./asset-location.js";

const COMPLIANCE_FILE = "compliance.yaml";
const ELECTRICAL_FILE = "electrical-section-h.yaml";
const ACTIVATION_OVERRIDES_FILE = "activation-overrides.yaml";

/**
 * nuo 专利规则文件清单（由 scripts/port-nuo-rules.ts 生成，可重新生成）。
 * 显式列出而非扫目录：rules/patent/ 还含 evidence-rules.yaml（证据引擎自有格式）、
 * synonyms.yaml（同义词资产）等非宪法规则文件，扫目录会误加载产生噪音。
 */
const NUO_RULE_FILES = [
  "nuo-compliance-enforceable.yaml",
  "nuo-patent-core-rules.yaml",
  "nuo-patent-examination-rules.yaml",
  "nuo-patent-ipc-rules.yaml",
  "nuo-patent-judgment-rules.yaml",
  "nuo-patent-law.yaml",
  "nuo-patent-practice-rules.yaml",
] as const;

export type PatentComplianceLoadResult = {
  ruleSet: RuleSet;
  source: string | null;
  warnings: string[];
};

function loadFirstExistingRuleSet(fileName: string): PatentComplianceLoadResult {
  const warnings: string[] = [];
  for (const dir of candidateRuleDirs()) {
    const path = join(dir, fileName);
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
  return { ruleSet: { rules: [] }, source: null, warnings };
}

const COMPLIANCE_MISSING_WARNING =
  "未找到专利合规规则资产（SATI_RULES_DIR 或 rules/patent/compliance.yaml），门禁降级为放行";

/** 加载基础 compliance 规则集；资产缺失时附「门禁降级为放行」警告。 */
function loadComplianceBase(): PatentComplianceLoadResult {
  const base = loadFirstExistingRuleSet(COMPLIANCE_FILE);
  if (base.source === null) {
    base.warnings.push(COMPLIANCE_MISSING_WARNING);
  }
  return base;
}

/** 加载内置专利合规规则集；找不到资产时返回空规则集并附警告。 */
export function loadPatentComplianceRuleSet(): PatentComplianceLoadResult {
  return loadComplianceBase();
}

/**
 * 加载电学案件增强规则集（compliance.yaml + electrical-section-h.yaml 合并）。
 * 用于 H 部电学案件的额外审查/撰写约束；找不到电学增强资产时回退到通用合规规则。
 */
export function loadPatentElectricalRuleSet(): PatentComplianceLoadResult {
  const base = loadComplianceBase();
  if (base.source === null) {
    return base;
  }
  const extra = loadFirstExistingRuleSet(ELECTRICAL_FILE);
  const merged: RuleSet = {
    version: base.ruleSet.version ?? extra.ruleSet.version ?? "1.0",
    rules: [...base.ruleSet.rules, ...extra.ruleSet.rules],
  };
  return {
    ruleSet: merged,
    source: extra.source ? `${base.source},${extra.source}` : base.source,
    warnings: [...base.warnings, ...extra.warnings],
  };
}

/** 激活评审覆盖补丁：id → 字段级覆盖（当前仅 action）。 */
export type ActivationOverrides = {
  byId: Map<string, Partial<ConstitutionalRule>>;
  source: string | null;
  warnings: string[];
};

/**
 * 加载 nuo 规则激活评审覆盖（activation-overrides.yaml）。
 * 轻量补丁格式：`overrides: { <id>: { action, reason } }`（非标准 RuleSet 形态，
 * 由本函数专门解析）。action 非法时跳过该条并告警（fail-safe：不应用非法覆盖）。
 * 文件不存在时返回空补丁 + 警告（不阻塞专利全量规则加载）。
 */
export function loadActivationOverrides(): ActivationOverrides {
  const warnings: string[] = [];
  for (const dir of candidateRuleDirs()) {
    const path = join(dir, ACTIVATION_OVERRIDES_FILE);
    if (!existsSync(path)) continue;
    try {
      const doc = parseDocument(readFileSync(path, "utf8"));
      if (doc.errors.length > 0) {
        warnings.push(`激活覆盖文件解析失败 ${path}: ${doc.errors[0]?.message ?? "unknown"}`);
        continue;
      }
      const raw = asRecord(asRecord(doc.toJS())?.overrides) ?? {};
      const byId = new Map<string, Partial<ConstitutionalRule>>();
      for (const [id, value] of Object.entries(raw)) {
        const record = asRecord(value);
        if (record === null) {
          warnings.push(`激活覆盖 ${id}: 覆盖值必须是对象，已跳过`);
          continue;
        }
        if (!isRuleAction(record.action)) {
          warnings.push(`激活覆盖 ${id}: 非法 action "${String(record.action)}"，已跳过`);
          continue;
        }
        byId.set(id, { action: record.action });
      }
      return { byId, source: path, warnings };
    } catch (error) {
      warnings.push(`激活覆盖文件加载失败 ${path}: ${(error as Error).message}`);
    }
  }
  return { byId: new Map(), source: null, warnings };
}

/**
 * 输出门禁规则子集：只保留「出现即违规」的 keyword_blocklist 规则，且排除 compliance
 * 规则（id 以 PAT- 开头）。
 *
 * - structural_analysis（缺失即违规 = 完整性期望）对任意 assistant 输出会海量误报
 *   （普通文本天然「缺失」几十个期望要素），只适用 rule_check 显式自检（A 链）；
 * - compliance 的 keyword/citation 规则已由关键词门禁（quality-gate 镜像词表）处理，
 *   规则门禁若重复接入会产生双重提示，故排除 PAT-* 前缀。
 *
 * 结果 = nuo 的 keyword_blocklist 规则（占位符/商业宣传/公序良俗/清楚性/事后诸葛亮/
 * 编造对比文件等），即 B 链规则门禁的「新增」能力。
 */
export function selectGateRules(ruleSet: RuleSet): RuleSet {
  return {
    version: ruleSet.version,
    rules: ruleSet.rules.filter(rule => rule.check.type === "keyword_blocklist" && !rule.id.startsWith("PAT-")),
  };
}

/**
 * 加载专利全量规则集（compliance.yaml + nuo-*.yaml，经 activation-overrides 降级）。
 * 供 rule_check scope=patent-full 与规则驱动输出门禁（B 链）使用。
 * 任一 nuo 文件缺失/损坏均跳过并告警（不拖垮整个规则集）；compliance 缺失时
 * 沿用既有「门禁降级为放行」语义。
 */
export function loadPatentFullRuleSet(): PatentComplianceLoadResult {
  const base = loadComplianceBase();
  if (base.source === null) {
    return base;
  }
  const nuoRuleSets: RuleSet[] = [];
  const warnings = [...base.warnings];
  for (const file of NUO_RULE_FILES) {
    const loaded = loadFirstExistingRuleSet(file);
    if (loaded.source === null) {
      warnings.push(`nuo 规则文件未找到: ${file}`);
      continue;
    }
    nuoRuleSets.push(loaded.ruleSet);
    warnings.push(...loaded.warnings);
  }
  const nuoMerged = mergeRuleSets(nuoRuleSets);
  const { byId, source: overrideSource, warnings: overrideWarnings } = loadActivationOverrides();
  warnings.push(...overrideWarnings);
  const nuoPatched = applyRuleOverrides(nuoMerged, byId);
  const merged: RuleSet = {
    version: base.ruleSet.version ?? nuoPatched.version ?? "1.0",
    rules: [...base.ruleSet.rules, ...nuoPatched.rules],
  };
  return {
    ruleSet: merged,
    source: overrideSource ? `${base.source}+${overrideSource}` : base.source,
    warnings,
  };
}
