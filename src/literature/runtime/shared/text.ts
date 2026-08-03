/**
 * 学术文献元数据文本工具（移植自 OpenScience literature/shared.ts）。
 *
 * 覆盖学术 API 的常规文本需求：XML/HTML 实体解码、JATS 标签剥离、摘要片段
 * 截断、OpenAlex 倒排摘要重建。全部防御式：畸形输入返回 `undefined` / 空
 * 数组而非抛错。
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

/** 解码学术元数据中出现的少量 XML/HTML 实体（含数字/十六进制字符引用）。 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&[a-zA-Z]+;/g, m => ENTITIES[m] ?? m);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** 剥离 XML/HTML 标签（如 JATS `<jats:p>` 摘要）并折叠空白。 */
export function stripTags(input?: string): string | undefined {
  if (!input) return undefined;
  const text = decodeEntities(input.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return text.length ? text : undefined;
}

/** 截断到可读长度，不硬切单词。 */
export function snippet(input?: string, max = 600): string | undefined {
  const text = stripTags(input);
  if (!text) return undefined;
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

/** 原样透传源 API 记录作为不透明 `extra` 负载。 */
export function raw(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * 从 OpenAlex 的 `abstract_inverted_index`（词 → 位置数组）重建纯文本摘要。
 */
export function fromInverted(index?: Record<string, number[]> | null): string | undefined {
  if (!index) return undefined;
  const words: string[] = [];
  for (const word of Object.keys(index)) {
    for (const pos of index[word] ?? []) {
      if (Number.isInteger(pos) && pos >= 0) words[pos] = word;
    }
  }
  const text = words
    .filter(w => w !== undefined)
    .join(" ")
    .trim();
  return text.length ? text : undefined;
}
