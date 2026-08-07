/**
 * src/patent/chemistry — 文本化学实体提取（三级流水线第一级：正则候选）。
 *
 * G3 约束：分子式候选要求 ≥2 种真实元素（元素周期表校验），天然排除
 * `C1-C6` 范围写法、`C12` 章节号、`式(I)` 引用等单元素噪声，同时过滤
 * CD4/DNA/ATP 等生物医药缩略词（评审 M3）；类 SMILES 词元要求以真实
 * 元素字母开头且含结构要素（芳环小写/环闭合数字/分支/双键/方括号），
 * 排除 M2=5、ratio=2 等非化学词元（评审 M4）。
 * 候选后续经 LLM 复核（analyze.ts）与 RDKit 验证（smiles.ts）。
 */

import { isPlausibleSmilesSyntax } from "./smiles.js";

/** 元素周期表符号（118 种）：分子式/类 SMILES 词首真实性校验。 */
const ELEMENT_SYMBOLS = new Set([
  "H",
  "He",
  "Li",
  "Be",
  "B",
  "C",
  "N",
  "O",
  "F",
  "Ne",
  "Na",
  "Mg",
  "Al",
  "Si",
  "P",
  "S",
  "Cl",
  "Ar",
  "K",
  "Ca",
  "Sc",
  "Ti",
  "V",
  "Cr",
  "Mn",
  "Fe",
  "Co",
  "Ni",
  "Cu",
  "Zn",
  "Ga",
  "Ge",
  "As",
  "Se",
  "Br",
  "Kr",
  "Rb",
  "Sr",
  "Y",
  "Zr",
  "Nb",
  "Mo",
  "Tc",
  "Ru",
  "Rh",
  "Pd",
  "Ag",
  "Cd",
  "In",
  "Sn",
  "Sb",
  "Te",
  "I",
  "Xe",
  "Cs",
  "Ba",
  "La",
  "Ce",
  "Pr",
  "Nd",
  "Pm",
  "Sm",
  "Eu",
  "Gd",
  "Tb",
  "Dy",
  "Ho",
  "Er",
  "Tm",
  "Yb",
  "Lu",
  "Hf",
  "Ta",
  "W",
  "Re",
  "Os",
  "Ir",
  "Pt",
  "Au",
  "Hg",
  "Tl",
  "Pb",
  "Bi",
  "Po",
  "At",
  "Rn",
  "Fr",
  "Ra",
  "Ac",
  "Th",
  "Pa",
  "U",
  "Np",
  "Pu",
  "Am",
  "Cm",
  "Bk",
  "Cf",
  "Es",
  "Fm",
  "Md",
  "No",
  "Lr",
  "Rf",
  "Db",
  "Sg",
  "Bh",
  "Hs",
  "Mt",
  "Ds",
  "Rg",
  "Cn",
  "Nh",
  "Fl",
  "Mc",
  "Lv",
  "Ts",
  "Og",
]);

/**
 * Hill 记法分子式校验（防幻觉评审 H1）：元素符号+数字序列且含 ≥2 种元素。
 * 图片/文本公式分支采信前的硬门槛——垃圾输入（如 `ABC!@#`）不得直通 usable。
 */
export function isValidHillFormula(formula: string): boolean {
  const f = formula.trim();
  if (f.length === 0 || f.length > 128) return false;
  if (!/^(?:[A-Z][a-z]?\d*)+$/.test(f)) return false;
  const groups = [...f.matchAll(/[A-Z][a-z]?/g)].map(m => m[0]);
  // 全部元素组必须为真实元素，且至少两种元素（排除单元素写法）
  return groups.every(g => ELEMENT_SYMBOLS.has(g)) && new Set(groups).size >= 2;
}

/** 提取文本中的分子式候选（Hill 序，≥2 种真实元素）。 */
export function extractFormulaCandidates(text: string): string[] {
  const found = new Set<string>();
  // 元素基团序列：C?H? + 其余元素（大写单字母或大写+小写），形如 C6H12O6 / H2SO4 / NaCl / CH4
  const pattern = /(?<![A-Za-z0-9])(?:C\d*(?:H\d+)?|H\d+|[A-Z][a-z]?\d*)(?:[A-Z][a-z]?\d*)+(?![A-Za-z0-9])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[0];
    // 至少两种元素且全部为真实元素（排除 C12 / N2 单元素噪声与 CD4 / DNA / ATP 缩略词）
    if (countDistinctElements(token) >= 2 && isValidHillFormula(token)) found.add(token);
  }
  return [...found];
}

/** 提取文本中的类 SMILES 词元候选（以真实元素开头且含结构要素的连续词元）。 */
export function extractSmilesCandidates(text: string): string[] {
  const found = new Set<string>();
  const tokenPattern = /[A-Za-z0-9@+\-\\#=()\[\]\/%.]{4,200}/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text)) !== null) {
    const token = match[0];
    if (looksLikeSmiles(token)) found.add(token);
  }
  return [...found];
}

/** 统一提取入口：分子式 + 类 SMILES 词元（去重保序）。 */
export function extractChemicalCandidates(text: string): { formulas: string[]; smilesTokens: string[] } {
  return {
    formulas: extractFormulaCandidates(text),
    smilesTokens: extractSmilesCandidates(text),
  };
}

function countDistinctElements(token: string): number {
  const elements = new Set<string>();
  const groupPattern = /[A-Z][a-z]?/g;
  let match: RegExpExecArray | null;
  while ((match = groupPattern.exec(token)) !== null) {
    elements.add(match[0]);
  }
  return elements.size;
}

function looksLikeSmiles(token: string): boolean {
  if (!isPlausibleSmilesSyntax(token)) return false;
  // 评审 M4：须以真实元素字母开头（或方括号原子）——排除 M2=5 / ratio=2 等非化学词元
  const headMatch = /^\[?(Cl|Br|[A-Z][a-z]?|[bcnops])/.exec(token);
  if (!headMatch) return false;
  const head = headMatch[1];
  const isAromatic = head === head.toLowerCase();
  if (!isAromatic && !ELEMENT_SYMBOLS.has(head)) return false;
  // 键/分支/方括号等结构要素，或芳环小写 + 环闭合数字（c1ccccc1）
  const hasBondOrBranch = /[=#()\[\]\\@%]/.test(token);
  const hasAromaticRingClosure = /[bcnops]/.test(token) && (token.match(/\d/g) ?? []).length >= 2;
  return hasBondOrBranch || hasAromaticRingClosure;
}
