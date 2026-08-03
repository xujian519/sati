/**
 * 无依赖的 XML/Atom 提取工具（移植自 OpenScience literature/shared.ts）。
 *
 * 覆盖学术 API 的常规 XML 需求：Atom 条目提取（arXiv）、PubMed EFetch，
 * 不引入 XML 解析器。全部防御式：畸形输入返回 `undefined` / 空数组而非
 * 抛错。
 *
 * 已知边界（fragile by design）：不处理 CDATA 与深层命名空间；行为由
 * fixture 测试锁定。
 */
import { decodeEntities } from "./text.js";

/** 第一个 `<tag>…</tag>` 的内部文本，实体解码。 */
export function xmlText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m) return undefined;
  const text = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  return text.length ? text : undefined;
}

/** 每个 `<tag>…</tag>` 块的内部文本。 */
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) out.push(m[1]);
  return out;
}

/** 第一个 `<tag …>` 上 `attr` 属性的值。 */
export function xmlAttr(xml: string, tag: string, attr: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`).exec(xml);
  return m ? decodeEntities(m[1]) : undefined;
}

/** 一个自闭合元素：属性映射 + 原文。 */
export interface SelfClosing {
  attrs: Record<string, string>;
  raw: string;
}

/**
 * 每个自闭合 `<tag … />` 元素及其属性。
 *
 * `xmlBlocks` 只匹配配对的 `<tag>…</tag>`，自闭合标签（Atom `<link …/>`、
 * `<category …/>`）对它不可见——而 `xmlAttr` 却匹配自闭合开头，这是个陷阱。
 * 此函数补齐缺口：返回每个出现的属性映射，调用方可按任意属性选择
 * （如 arXiv 的 `title="pdf"` 链接），与属性顺序无关。
 */
export function xmlSelfClosing(xml: string, tag: string): SelfClosing[] {
  const re = new RegExp(`<${tag}\\b([^>]*?)/\\s*>`, "g");
  const out: SelfClosing[] = [];
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    out.push({ attrs: parseAttrs(m[1]), raw: m[0] });
  }
  return out;
}

/** 解析一串 `key="value"` 属性对为实体解码映射。 */
function parseAttrs(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  for (let m = re.exec(input); m !== null; m = re.exec(input)) {
    attrs[m[1]] = decodeEntities(m[2]);
  }
  return attrs;
}
