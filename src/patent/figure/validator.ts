/**
 * src/patent/figure — 电学符号确定性校验器（对标 chemistry/RDKit 防幻觉闭环）。
 *
 * 电学深度分析（Step3）的模型输出经本校验器做三重确定性检查，结果仅追加
 * warnings（不阻断、不修改识别结果），延续 Sati 附图分析「容错降级」哲学：
 *
 * 1. 标号前缀 ↔ 符号类别一致性：R→电阻、C→电容、Q→晶体管…（依据符号库 refPrefix）
 * 2. 拓扑合理性：net 至少一端有效、引用元件存在、无孤立元件（悬空）
 * 3. 图文对齐：claim_context 中提及的元件（按符号库前缀识别）vs 识别结果
 *
 * 纯函数、无模型依赖，输入 ElectricalAnalysis，输出校验警告。
 */

import { parseRefNumber, querySymbolByRefPrefix } from "./symbols/loader.js";
import type { ElectricalAnalysis, ElectricalComponent } from "./types.js";

export type ElectricalValidationResult = {
  /** 校验警告（结构性问题/疑似错误/信息提示）。 */
  warnings: string[];
  /** 是否存在结构性错误（前缀冲突/悬空/缺失元件）。 */
  hasStructuralIssues: boolean;
};

/** 单端符号（网络符号），允许只出现在一个 net 中，不视为悬空。 */
const SINGLE_TERMINAL_SYMBOLS = new Set(["ground", "antenna", "terminal"]);

/** 电源/地类网络名（信息提示级别使用）。 */
const POWER_NET_NAMES = /^(vcc|vdd|vee|vss|gnd|\+v|v[+-]|bat|ac)$/i;

/**
 * 解析 "R1.1" → { ref: "R1", pin: "1" }；无法解析返回 null。
 * 兼容无引脚号写法（"R1"）。
 */
function parsePinRef(pin: string): { ref: string; pin?: string } | null {
  const trimmed = pin.trim();
  const match = /^([A-Za-z][A-Za-z0-9]*)\.(\d+)$/.exec(trimmed);
  if (match) return { ref: match[1], pin: match[2] };
  const refMatch = /^[A-Za-z][A-Za-z0-9]*$/.exec(trimmed);
  if (refMatch) return { ref: trimmed };
  return null;
}

/** 数字档排除前缀：这些词后的数字是编号（式(1)/步骤(2)/实施例3…），不是附图标记。 */
const NUMERAL_PREFIX_EXCLUSION = /(?:式|公式|步骤|例|图|表|第|共|约|款|条|项|章|节|claim|step|formula|fig)$/iu;

/** 纯数字型附图标记（机械/实用新型案：`壳体(10)`、`盖板20`）。 */
function extractNumericRefs(text: string, limit: number): number[] {
  const found = new Set<number>();
  // ① 括号形：`(10)` / `（10）`——前置词排除式(1)/步骤(2)；`(?<!\d)` 与 `(?!\d)` 防
  //    四位年份（2023）被截出三位数字。
  for (const match of text.matchAll(/(?<!\d)[（(]\s*(\d{1,3})\s*[)）](?!\d)/gu)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 2), match.index ?? 0);
    if (NUMERAL_PREFIX_EXCLUSION.test(before)) continue;
    found.add(Number(match[1]));
    if (found.size >= limit) return [...found].sort((a, b) => a - b);
  }
  // ② 直连形：`壳体10`（≥2 个汉字直接跟数字，其后为列举分隔符或行尾）——与核验器
  //    V10 同一词法：只认枚举式裸标记，避免把数量词/数值范围判成附图标记。
  for (const match of text.matchAll(/[\u4e00-\u9fff]{2,}\s*(\d{1,3})(?=\s*(?:[，,；;、。：:]|$))/gmu)) {
    const digitsStart = (match.index ?? 0) + match[0].length - match[1].length;
    const before = text.slice(Math.max(0, digitsStart - 2), digitsStart);
    if (NUMERAL_PREFIX_EXCLUSION.test(before)) continue;
    found.add(Number(match[1]));
    if (found.size >= limit) break;
  }
  return [...found].sort((a, b) => a - b);
}

/** 主张文本的两档标记抽取结果。 */
export type ClaimRefExtraction = {
  /** 高置信档：符号库已知前缀（R1/C2/IC3）。 */
  symbols: string[];
  /** 数字档：机械/实用新型的附图标记数字（壳体(10)、盖板20）。 */
  numerals: number[];
};

/**
 * 两档抽取（供图文对齐与多图一致性使用）。
 *
 * 两档分离是有意的：电学档（符号前缀）与机械档（纯数字）的"什么算标记"判据不同，
 * 混在一处会让电学链路的图文对齐把普通数字判成元件（`extractClaimRefs` 保持只返回
 * 电学档，行为不变）。
 */
export function extractClaimRefsDetailed(text: string | undefined, limit = 40): ClaimRefExtraction {
  if (!text) return { symbols: [], numerals: [] };
  const found = new Set<string>();
  const pattern = /(?:[\u4e00-\u9fa5]{0,6}?[A-Za-z]{1,4}\d{1,4})/g;
  for (const match of text.matchAll(pattern)) {
    const token = match[0];
    // 从 token 末尾提取最可能的标号段（如“包括电阻R1” → “R1”）
    const inner = /[A-Za-z]+\d+$/.exec(token);
    if (!inner) continue;
    const parsed = parseRefNumber(inner[0]);
    if (!parsed) continue;
    // 仅收录符号库已知前缀的标记（R1/C2/IC1…），排除普通文本数字
    if (querySymbolByRefPrefix(parsed.prefix).length === 0) continue;
    const ref = `${parsed.prefix}${parsed.number}`;
    found.add(ref);
    if (found.size >= limit) break;
  }
  return { symbols: [...found], numerals: extractNumericRefs(text, limit) };
}

/** 从权利要求/技术方案文本提取元件标记（仅匹配符号库已知前缀，避免误报普通数字）。 */
export function extractClaimRefs(text: string | undefined, limit = 40): string[] {
  return extractClaimRefsDetailed(text, limit).symbols;
}

function validateComponentPrefix(component: ElectricalComponent): string | undefined {
  const parsed = parseRefNumber(component.ref);
  if (!parsed) {
    // 无编号的电源/地类符号（GND/VCC）属正常；其余提示
    const isPowerSymbol =
      component.symbol === "ground" || component.symbol === "dc_power" || component.symbol === "battery";
    return isPowerSymbol ? undefined : `元件 ${component.ref} 标号缺少字母前缀+编号（如 R1），请核对`;
  }
  const candidates = querySymbolByRefPrefix(parsed.prefix);
  if (candidates.length === 0) {
    return `元件 ${component.ref} 的标号前缀 ${parsed.prefix} 不在符号库中（R/C/L/D/Q/U/IC/XT/K/F/BAT/GND…），请核对`;
  }
  const expected = candidates.map(c => `${c.nameZh}(${c.id})`).join("/");
  // symbol 精确校验：标号前缀的候选符号集应包含识别出的符号 id（提示词强约束 symbol 从符号集选择）
  if (component.symbol !== "unknown") {
    if (candidates.some(c => c.id === component.symbol)) return undefined;
    return `元件 ${component.ref}（${component.name}）的符号 ${component.symbol} 与标号前缀 ${parsed.prefix}（通常对应 ${expected}）不一致，请核对`;
  }
  // symbol 未识别（unknown）：类别一致则提示性放行，类别也不一致才告警
  const categoryMatch = component.category !== "unknown" && candidates.some(c => c.category === component.category);
  if (!categoryMatch) {
    return `元件 ${component.ref} 的符号未识别（unknown），且类别与标号前缀 ${parsed.prefix}（通常对应 ${expected}）不一致，请核对`;
  }
  return undefined;
}

/**
 * 校验电学深度分析结果。
 *
 * @param analysis Step3 识别结果
 * @param claimContext 权利要求/技术方案文本（可选，用于图文对齐）
 */
export function validateElectricalAnalysis(
  analysis: ElectricalAnalysis,
  claimContext?: string,
): ElectricalValidationResult {
  const warnings: string[] = [];
  let hasStructuralIssues = false;

  const components = analysis.components;
  const componentRefs = new Set(components.map(c => c.ref.toUpperCase()));
  const refToComponent = new Map(components.map(c => [c.ref.toUpperCase(), c]));

  // 1. 标号前缀 ↔ 符号类别一致性
  for (const component of components) {
    const warning = validateComponentPrefix(component);
    if (warning) {
      warnings.push(warning);
      hasStructuralIssues = true;
    }
  }

  // 2. 拓扑合理性
  const referencedRefs = new Set<string>();
  for (const net of analysis.nets) {
    if (net.connectedRefs.length === 0) {
      warnings.push(`网络 ${net.name} 没有任何连接的元件引脚（悬空网络）`);
      hasStructuralIssues = true;
      continue;
    }
    if (net.connectedRefs.length === 1 && !POWER_NET_NAMES.test(net.name)) {
      warnings.push(`网络 ${net.name} 仅连接 1 个引脚，疑似悬空（${net.connectedRefs[0]}）`);
    }
    for (const pinRef of net.connectedRefs) {
      const parsed = parsePinRef(pinRef);
      if (!parsed) {
        warnings.push(`网络 ${net.name} 中的引脚引用格式无法解析：${pinRef}（应为 元件标号.引脚号）`);
        hasStructuralIssues = true;
        continue;
      }
      referencedRefs.add(parsed.ref.toUpperCase());
      if (!componentRefs.has(parsed.ref.toUpperCase())) {
        warnings.push(`网络 ${net.name} 引用了不存在的元件 ${parsed.ref}`);
        hasStructuralIssues = true;
      }
    }
  }

  // 孤立元件（未出现在任何网络中）：两脚及以上元件视为悬空
  if (analysis.nets.length > 0) {
    for (const component of components) {
      const ref = component.ref.toUpperCase();
      if (referencedRefs.has(ref)) continue;
      if (SINGLE_TERMINAL_SYMBOLS.has(component.symbol)) continue;
      const terminalCount = component.terminalCount ?? 2;
      if (terminalCount >= 2) {
        warnings.push(`元件 ${component.ref}（${component.name}）未出现在任何网络中，疑似悬空或连接提取遗漏`);
        hasStructuralIssues = true;
      }
    }
  }

  // 3. 图文对齐（claim_context 提及元件 vs 识别结果）
  if (claimContext && claimContext.trim().length > 0) {
    const claimRefs = extractClaimRefs(claimContext);
    const claimedSet = new Set(claimRefs.map(r => r.toUpperCase()));
    const missing = claimRefs.filter(r => !componentRefs.has(r.toUpperCase()));
    for (const ref of missing) {
      warnings.push(`权利要求/技术方案提及 ${ref}，但附图分析未识别到该元件（可能识别遗漏）`);
      hasStructuralIssues = true;
    }
    for (const ref of [...componentRefs]) {
      if (refToComponent.get(ref)?.symbol === "ground") continue;
      if (!claimedSet.has(ref)) {
        // 附图有而文字未提及：不一定是错误（权利要求未必列全），仅信息提示
        warnings.push(`附图识别到元件 ${ref}，但权利要求/技术方案中未提及（请人工确认是否需在说明书中描述）`);
      }
    }
  }

  return { warnings, hasStructuralIssues };
}
