/**
 * SKILL.md frontmatter 解析（含兼容回退）。
 *
 * 2026-09-11 由 `SkillManager.ts` 抽出（issue #152：把 915 行巨型类文件的
 * 解析/校验职责分离），实现逐字迁移，行为不变。
 */

import { parse as parseYaml } from "yaml";

/**
 * Parse the YAML frontmatter block at the head of `content`. Returns an
 * empty object when the document doesn't start with `---`, when the
 * closing fence is missing, or when YAML fails to parse — callers should
 * treat the skill as still loadable in those cases (we surface name +
 * description for display only).
 */
type FrontmatterParseResult = {
  frontmatter: Record<string, unknown>;
  usedCompatibilityFallback: boolean;
};

export function parseSkillFrontmatter(content: string): Record<string, unknown> {
  return parseSkillFrontmatterWithMeta(content).frontmatter;
}

export function parseSkillFrontmatterWithMeta(content: string): FrontmatterParseResult {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, usedCompatibilityFallback: false };
  }
  // Accept both `\n---\n` and `\n---` (no trailing newline) closing
  // fences; some editors strip the trailing newline on save.
  const endRel = content.slice(3).search(/\r?\n---/);
  if (endRel === -1) {
    return { frontmatter: {}, usedCompatibilityFallback: false };
  }
  const fmRaw = content.slice(3, 3 + endRel).replace(/^\r?\n/, "");
  try {
    const parsed = parseYaml(fmRaw);
    return {
      frontmatter:
        parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {},
      usedCompatibilityFallback: false,
    };
  } catch {
    // YAML frontmatter 解析失败 → 回退兼容式解析并标记 usedCompatibilityFallback。
    const compat = parseCompatFrontmatter(fmRaw);
    return {
      frontmatter: compat,
      usedCompatibilityFallback: Object.keys(compat).length > 0,
    };
  }
}

function parseCompatFrontmatter(fmRaw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = fmRaw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const scalarMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$/);
    if (!scalarMatch) continue;

    const key = scalarMatch[1];
    const rawValue = scalarMatch[2];
    const blockMatch = rawValue.match(/^([>|])\s*$/);
    if (blockMatch) {
      const blockLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (/^[A-Za-z][A-Za-z0-9_-]*\s*:/.test(next)) {
          i -= 1;
          break;
        }
        blockLines.push(next.replace(/^ {1,2}/, ""));
        i += 1;
      }
      result[key] = blockLines.join("\n").trim();
      continue;
    }

    result[key] = rawValue.trim().replace(/^["']|["']$/g, "");
  }

  return result;
}
