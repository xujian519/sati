/**
 * 宪法规则引擎 — 同义词匹配增强（移植自 Mady rule_engine.go 的 synonymMap + negationPatterns）。
 *
 * 中文专利文本术语变体丰富（"新颖性"↔"新创性"、"单独对比"↔"一一对比"），
 * 纯关键词匹配会漏检。本引擎在 keyword_blocklist / structural_analysis 之外
 * 提供同义词展开匹配：关键词（或其同义词）在文本中以肯定形式出现即视为命中，
 * 命中位置前 60 字符窗口内的否定模式（"不具有""无法证明"等）豁免。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { SynonymRequirement } from "../protocol/types.js";
import { candidateRuleDirs } from "./asset-location.js";
import { hasNegationContext as sharedHasNegationContext } from "./text-utils.js";

/** 同义词表：关键词 → 同义词列表（不含关键词本身）。 */
export type SynonymMap = Map<string, string[]>;

/**
 * 否定模式（移植 Mady negationPatterns，12 个多字短语；补"不具备/未具备"——
 * "权利要求1不具备创造性"是 OA 答复最常见句式，"不具有"覆盖不到）。
 * 命中位置前窗口内出现任一模式且无句界分隔时视为否定性描述，不报告。
 */
const NEGATION_PATTERNS: readonly string[] = [
  "不具有",
  "不具备",
  "未具备",
  "不构成",
  "无法证明",
  "缺少",
  "未发现",
  "没有公开",
  "不满足",
  "不符合",
  "难以看出",
  "不能证明",
];

/** 否定语境检查窗口（命中词前多少个字符；对齐 Mady 60 字符窗口）。 */
const NEGATION_WINDOW = 60;

/**
 * 在命中位置前查找否定语境：窗口内出现否定短语/否定词且无句界分隔。
 * 复用共享实现（text-utils.ts），窗口与词表按本引擎语义传入。
 */
export function hasNegationContext(text: string, matchStart: number): boolean {
  return sharedHasNegationContext(text, matchStart, {
    window: NEGATION_WINDOW,
    negationWords: NEGATION_PATTERNS,
  });
}

/**
 * 检查关键词是否以肯定形式出现：关键词或其任一同义词在文本中命中，
 * 且命中位置前无否定语境。返回命中的词（原词或同义词）。
 *
 * 遍历全部出现位置：首个命中处于否定语境时不阻断——同词后续的肯定出现
 * （"不具有新颖性，但…方案具有新颖性"）仍算命中（对齐 quality-gate 的
 * filterNegatedHits 循环语义）。同义词表 key 统一小写存储/查找。
 */
export function matchKeyword(text: string, keyword: string, synonyms: SynonymMap): string | null {
  const candidates = [keyword, ...(synonyms.get(keyword.toLowerCase()) ?? [])];
  const lower = text.toLowerCase();
  for (const candidate of candidates) {
    const needle = candidate.toLowerCase();
    let searchFrom = 0;
    while (true) {
      const idx = lower.indexOf(needle, searchFrom);
      if (idx < 0) break;
      if (!hasNegationContext(text, idx)) {
        return candidate;
      }
      searchFrom = idx + needle.length;
    }
  }
  return null;
}

export type SynonymCheckResult = {
  /** 命中要素数 / 总要素数。 */
  confidence: number;
  /** 未命中的要素名列表。 */
  missing: string[];
  /** 每个要素命中的词（未命中为 null）。 */
  matched: Array<string | null>;
};

/**
 * 检查一段文本是否包含全部要求要素（同义词展开 + 否定豁免）。
 * 返回置信度与缺失要素。
 */
export function checkSynonymRequirements(
  text: string,
  requirements: SynonymRequirement[],
  synonyms: SynonymMap,
): SynonymCheckResult {
  const missing: string[] = [];
  const matched: Array<string | null> = [];
  let hit = 0;
  for (const req of requirements) {
    // 单次扫描：每个关键词只调用一次 matchKeyword（命中即满足该要素）
    let foundWord: string | null = null;
    for (const kw of req.keywords) {
      foundWord = matchKeyword(text, kw, synonyms);
      if (foundWord !== null) break;
    }
    if (foundWord !== null) {
      hit += 1;
      matched.push(foundWord);
    } else {
      missing.push(req.element);
      matched.push(null);
    }
  }
  return {
    confidence: requirements.length === 0 ? 1 : hit / requirements.length,
    missing,
    matched,
  };
}

/** 从 YAML 文本解析同义词表；返回空表（不抛错）与警告。 */
export function parseSynonyms(yamlText: string, source = "<inline>"): { synonyms: SynonymMap; warnings: string[] } {
  const warnings: string[] = [];
  const synonyms: SynonymMap = new Map();
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    warnings.push(`同义词 YAML 解析失败 ${source}: ${doc.errors[0]?.message ?? "unknown"}`);
    return { synonyms, warnings };
  }
  const root = doc.toJS();
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    warnings.push(`同义词文件顶层必须是对象 ${source}`);
    return { synonyms, warnings };
  }
  const raw = (root as Record<string, unknown>).synonyms;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`同义词文件缺少 synonyms 映射 ${source}`);
    return { synonyms, warnings };
  }
  for (const [keyword, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value) || !value.every(v => typeof v === "string")) {
      warnings.push(`同义词条目 ${keyword} 需为字符串数组，跳过`);
      continue;
    }
    // key 统一小写存储，与 matchKeyword 的小写查找一致（拉丁词如 "US"/"inventive step"）
    synonyms.set(keyword.toLowerCase(), value as string[]);
  }
  return { synonyms, warnings };
}

// ---------------------------------------------------------------------------
// 资产定位（复用 asset-location.ts 的 candidateRuleDirs，勿重复实现）
// ---------------------------------------------------------------------------

const SYNONYMS_FILE = "synonyms.yaml";

export type SynonymsLoadResult = {
  synonyms: SynonymMap;
  source: string | null;
  warnings: string[];
};

/** 加载内置同义词资产；找不到资产时返回空表 + 警告（降级为纯关键词匹配）。 */
export function loadSynonymsAsset(): SynonymsLoadResult {
  const warnings: string[] = [];
  for (const dir of candidateRuleDirs()) {
    const path = join(dir, SYNONYMS_FILE);
    if (!existsSync(path)) continue;
    try {
      const { synonyms, warnings: parseWarnings } = parseSynonyms(readFileSync(path, "utf8"), path);
      return { synonyms, source: path, warnings: [...warnings, ...parseWarnings] };
    } catch (error) {
      warnings.push(`同义词资产加载失败 ${path}: ${(error as Error).message}`);
    }
  }
  warnings.push(
    "未找到同义词资产（$SATI_RULES_DIR/patent/synonyms.yaml 或 rules/patent/synonyms.yaml），降级为纯关键词匹配",
  );
  return { synonyms: new Map(), source: null, warnings };
}
