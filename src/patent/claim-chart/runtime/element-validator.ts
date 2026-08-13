/**
 * 要素校验（纯函数）：LLM 拆分的要素必须与权利要求原文逐词一致
 * （剥离全部空白后为连续子串，容忍 PDF 提取的换行/多空格折行），
 * 编号（数字+小写字母）唯一且连续无跳号 —— 防幻觉拆分。
 */

import type { ClaimElement } from "../protocol/types.js";

export type ElementValidationResult = { ok: true; elements: ClaimElement[] } | { ok: false; errors: string[] };

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

const ELEMENT_ID_RE = /^(\d+)([a-z]+)$/;

export function validateElements(elements: ClaimElement[], claimText: string): ElementValidationResult {
  const errors: string[] = [];
  const normalizedClaim = stripWhitespace(claimText);
  if (normalizedClaim.length === 0) return { ok: false, errors: ["权利要求原文为空"] };
  if (elements.length === 0) return { ok: false, errors: ["要素列表为空"] };

  const seen = new Set<string>();
  const byClaim = new Map<number, string[]>();
  for (const el of elements) {
    if (seen.has(el.id)) {
      errors.push(`要素编号重复: ${el.id}`);
      continue;
    }
    seen.add(el.id);

    const m = ELEMENT_ID_RE.exec(el.id);
    if (!m) {
      errors.push(`要素编号格式非法（应为 数字+小写字母，如 1a）: ${el.id}`);
      continue;
    }
    const claimNo = Number(m[1]!);
    if (claimNo !== el.claimNo) {
      errors.push(`要素 ${el.id} 的 claimNo(${el.claimNo}) 与编号前缀(${claimNo})不一致`);
    }
    const letters = byClaim.get(claimNo) ?? [];
    letters.push(m[2]!);
    byClaim.set(claimNo, letters);

    const text = stripWhitespace(el.text);
    if (text.length === 0) {
      errors.push(`要素 ${el.id} 文本为空`);
      continue;
    }
    if (!normalizedClaim.includes(text)) {
      errors.push(`要素 ${el.id} 不是权利要求原文的连续子串: "${text.slice(0, 50)}…"`);
    }
  }

  for (const [claimNo, letters] of byClaim) {
    letters.sort();
    for (let i = 0; i < letters.length; i += 1) {
      const expected = String.fromCharCode("a".charCodeAt(0) + i);
      if (letters[i] !== expected) {
        errors.push(`权利要求 ${claimNo} 要素编号跳号：期望 ${claimNo}${expected}，实际含 ${claimNo}${letters[i]}`);
        break;
      }
    }
  }

  return errors.length === 0 ? { ok: true, elements } : { ok: false, errors };
}
