/**
 * Shared text utilities for IM channels.
 */

/**
 * 解析 `/new` 会话切换命令：非 `/new` 命令返回 null；否则返回命令后的
 * 消息内容（去掉 `/new` 前缀并 trim）。判断与提取合一，调用方无需
 * 记得两者必须配对使用。
 */
export function newSessionMessage(trimmed: string): string | null {
  if (trimmed !== "/new" && !trimmed.startsWith("/new ")) return null;
  return trimmed.slice("/new".length).trim();
}

/**
 * Split long text into chunks of at most `max` characters, preferring to
 * break on newlines (then spaces) to keep messages readable.
 */
export function chunkText(content: string, max: number): string[] {
  if (content.length <= max) return [content];
  const out: string[] = [];
  let rest = content;
  while (rest.length > max) {
    let split = rest.lastIndexOf("\n", max);
    if (split < max / 2) split = rest.lastIndexOf(" ", max);
    if (split < max / 2) split = max;
    out.push(rest.slice(0, split));
    rest = rest.slice(split).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}
