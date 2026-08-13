/**
 * pin-cite 校验（纯函数）：引用必须能在源文中定位 —— 防幻觉引用
 * （claude-for-legal "Every cell pin-cited" 护栏的落地）。
 */

import { normalizeWhitespace, stripWhitespace } from "./element-validator.js";

export type PinCiteCheckResult = { ok: true } | { ok: false; reason: string };

/** "[D1 段[0032] 图3]" / "[D1 段[0032]]"。 */
const PIN_CITE_RE = /^\[(\S+)\s+段\[(\d+)\](?:\s+图(\d+))?\]$/;

export function validatePinCite(pinCite: string, sourceText: string): PinCiteCheckResult {
  const m = PIN_CITE_RE.exec(pinCite.trim());
  if (!m) {
    return { ok: false, reason: `pin-cite 格式非法（应为 [文档 段[xxxx] 图n]）: ${pinCite}` };
  }
  const paragraph = m[2]!;
  if (!normalizeWhitespace(sourceText).includes(`[${paragraph}]`)) {
    return { ok: false, reason: `段号 [${paragraph}] 在源文中不存在` };
  }
  return { ok: true };
}

/** quote 剥离全部空白后必须是源文子串（空引用放行；容忍 PDF 提取的换行/多空格折行）。 */
export function verifyQuoteInSource(quote: string, sourceText: string): { ok: boolean; reason: string } {
  const q = stripWhitespace(quote);
  if (q.length === 0) return { ok: true, reason: "" };
  const ok = stripWhitespace(sourceText).includes(q);
  return ok ? { ok: true, reason: "" } : { ok: false, reason: `引用文本在源文中不存在: "${q.slice(0, 50)}…"` };
}
