/**
 * src/patent/figure/symbols — 电学符号知识库加载器。
 *
 * 惰性加载 electrical-symbols.yaml 到内存索引（进程内单例），提供：
 * - querySymbolByRefPrefix：按附图标记前缀查询（R → 电阻…）
 * - querySymbolById：按 id 查询
 * - formatSymbolsAsContext：格式化符号库摘要（供 Step3 提示词注入）
 *
 * 模式对齐 src/knowledge/patent/ipc-standards-loader.ts。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import {
  ELECTRICAL_SYMBOL_CATEGORIES,
  ELECTRICAL_SYMBOL_CATEGORY_NAMES,
  type ElectricalSymbolCategory,
  type ElectricalSymbolEntry,
  type ElectricalSymbolIndex,
} from "./types.js";

const SYMBOLS_PATH = join(fileURLToPath(new URL(".", import.meta.url)), "electrical-symbols.yaml");

let cachedIndex: ElectricalSymbolIndex | null = null;

function parseSymbols(yamlText: string): ElectricalSymbolEntry[] {
  const doc = parseDocument(yamlText);
  const root = doc.toJS() as { symbols?: unknown[] };
  const symbols = root?.symbols ?? [];
  return symbols.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const category = String(s.category ?? "");
    return {
      id: typeof s.id === "string" ? s.id : `symbol-${i}`,
      nameZh: typeof s.nameZh === "string" ? s.nameZh : "",
      nameEn: typeof s.nameEn === "string" ? s.nameEn : "",
      category: (ELECTRICAL_SYMBOL_CATEGORIES as readonly string[]).includes(category)
        ? (category as ElectricalSymbolCategory)
        : "misc",
      refPrefix: Array.isArray(s.refPrefix) ? s.refPrefix.map(String).map(p => p.toUpperCase()) : [],
      terminalCount: typeof s.terminalCount === "number" ? s.terminalCount : undefined,
      valueUnit: typeof s.valueUnit === "string" ? s.valueUnit : undefined,
      drawingHints: typeof s.drawingHints === "string" ? s.drawingHints : "",
      semantics: typeof s.semantics === "string" ? s.semantics : "",
    };
  });
}

/** 加载电学符号索引（惰性，进程内单例）。 */
export function loadElectricalSymbols(overridePath?: string): ElectricalSymbolIndex {
  if (cachedIndex) return cachedIndex;
  const path = overridePath ?? SYMBOLS_PATH;
  const all = parseSymbols(readFileSync(path, "utf8"));

  const byRefPrefix = new Map<string, ElectricalSymbolEntry[]>();
  const byId = new Map<string, ElectricalSymbolEntry>();
  for (const entry of all) {
    byId.set(entry.id, entry);
    for (const prefix of entry.refPrefix) {
      const list = byRefPrefix.get(prefix) ?? [];
      if (!list.some(e => e.id === entry.id)) list.push(entry);
      byRefPrefix.set(prefix, list);
    }
  }

  cachedIndex = { all, byRefPrefix, byId };
  return cachedIndex;
}

/** 按附图标记前缀查询符号（如 "R" → 电阻；前缀自动大写）。 */
export function querySymbolByRefPrefix(prefix: string): ElectricalSymbolEntry[] {
  return loadElectricalSymbols().byRefPrefix.get(prefix.trim().toUpperCase()) ?? [];
}

/** 按 id 查询符号（如 "resistor"）。 */
export function querySymbolById(id: string): ElectricalSymbolEntry | undefined {
  return loadElectricalSymbols().byId.get(id);
}

/**
 * 解析附图标记（如 "R1" / "IC2"）为前缀与编号。
 * 返回 null 表示无法解析（无字母前缀）。
 */
export function parseRefNumber(ref: string): { prefix: string; number: string } | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!match) return null;
  return { prefix: match[1].toUpperCase(), number: match[2] };
}

/** 将符号库格式化为上下文文本（供 Step3 提示词注入；默认全量，可限量）。 */
export function formatSymbolsAsContext(limit = 40): string {
  const all = loadElectricalSymbols().all;
  const entries = limit > 0 ? all.slice(0, limit) : all;
  return entries
    .map(entry => {
      const category = ELECTRICAL_SYMBOL_CATEGORY_NAMES[entry.category];
      const prefix = entry.refPrefix.length > 0 ? entry.refPrefix.join("/") : "—";
      const pins = entry.terminalCount !== undefined ? `，${entry.terminalCount} 端` : "";
      const unit = entry.valueUnit ? `，参数单位 ${entry.valueUnit}` : "";
      return `- ${entry.nameZh}（${entry.nameEn}，${category}${pins}${unit}）标号前缀：${prefix}\n  画法：${entry.drawingHints}\n  语义：${entry.semantics}`;
    })
    .join("\n");
}
