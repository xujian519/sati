/**
 * registerLeak — inspect outgoing text for inner-register leakage and failure
 * signatures (J-Space `ship` check).
 *
 * Report-only: it never blocks delivery. It detects:
 *   1. Dense-track symbols in prose (not inside fenced code).
 *   2. State markers in outgoing text.
 *   3. A "verified/confirmed" claim that does not state what the verification
 *      covered.
 *   4. Repetition loops (a line repeated 3+ times, or a character run of 20+).
 */

/** Symbols that belong to the inner register and nowhere a person reads. */
export const INNER_ONLY = ["⇒", "⟹", "⟸", "∴", "∵", "⊆", "⊇", "∋", "??", "?!", "💀"];

/** State markers that should not appear in delivered prose. */
export const STATE_MARKERS = ["GRRR", "GAAAH", "PHEW", "I see meltdown", "DATA DATA", "I'M DROWNING"];

const CLAIM_RE =
  /(?:verified|confirmed|validated|tested|proven|already (?:verified|confirmed|tested)|已验证|已经验证|经验证|验证通过|已确认|确认无误|已经测试|经测试|测试通过|已经证明|经证明)/i;

const COVERAGE_RE =
  /(?:all|each|every|cases?|inputs?|samples?|bounds?|boundaries|edges?|random(?:ized|ised)?|files?|modules?|sections?|lines?|scenarios?|environments?|platforms?|datasets?|records?|routes?|commands?|branches?|ranges?|including|through|up\s+to|Windows|Linux|macOS|Chrome|Firefox|Safari)\b|\b(?:Python|Node(?:\.js)?)\s*\d|\bn\s*[<≤=]\s*\d|(?:覆盖|全部|所有|每个|每条|各条|每项|逐一|逐条|边界|上下限|上限|下限|输入|用例|文件|目录|模块|章节|区段|分段|行数|行号|场景|平台|环境|浏览器|数据集|记录|路径|路由|命令|分支|范围|包括|包含|至多|至少|最多|最少|随机|样本|样例|截至)/i;

const MARKDOWN_FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const SETEXT_UNDERLINE = /^\s{0,3}(?:=+|-+)\s*$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const MARKDOWN_LIST_ITEM = /^\s{0,3}(?:[-+*]|\d+[.)])\s+/;
const THEMATIC_BREAK = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

export type RegisterLeakFinding = {
  /** 1-based line number, when the finding is line-local. */
  line?: number;
  text: string;
};

export type RegisterLeakResult = {
  findings: RegisterLeakFinding[];
  /** True when nothing was found. */
  clean: boolean;
};

export function scanRegisterLeak(text: string): RegisterLeakResult {
  const lines = text.split(/\r?\n/);
  const structural = markdownStructuralLines(lines);
  const findings: RegisterLeakFinding[] = [];

  const prose = lines.filter((_, index) => !structural.has(index)).join("\n");

  const leaked = INNER_ONLY.filter(symbol => prose.includes(symbol));
  if (leaked.length > 0) {
    findings.push({ text: `Inner-register dense-track symbols in prose: ${leaked.join(" ")}` });
  }

  const hotMarkers = STATE_MARKERS.filter(marker => prose.toLowerCase().includes(marker.toLowerCase()));
  if (hotMarkers.length > 0) {
    findings.push({ text: `State markers in outgoing text: ${hotMarkers.join(", ")}` });
  }

  const uncovered = firstClaimWithoutCoverage(lines, structural);
  if (uncovered !== undefined) {
    findings.push({ line: uncovered, text: `A verification claim does not state what it covered.` });
  }

  const repeatLine = findRepeatedLine(lines, structural);
  if (repeatLine !== undefined) {
    findings.push({ line: repeatLine, text: `A line repeats three or more times.` });
  }

  const charRun = findCharacterRun(lines, structural);
  if (charRun !== undefined) {
    findings.push({ line: charRun, text: `A character run of 20 or more.` });
  }

  return { findings, clean: findings.length === 0 };
}

function markdownStructuralLines(lines: string[]): Set<number> {
  const structural = new Set<number>();
  // Fenced code blocks: everything between matching fences is structural.
  let fenceChar: string | undefined;
  let fenceSize = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fenceChar === undefined) {
      const match = MARKDOWN_FENCE.exec(line);
      if (!match) continue;
      fenceChar = match[1]![0]!;
      fenceSize = match[1]!.length;
      structural.add(index);
      continue;
    }
    structural.add(index);
    const closing = new RegExp(`^\\s{0,3}${escapeRegExp(fenceChar)}{${fenceSize},}\\s*$`);
    if (closing.test(line)) {
      fenceChar = undefined;
      fenceSize = 0;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (structural.has(index)) continue;
    const line = lines[index]!;
    if (MARKDOWN_HEADING.test(line) || THEMATIC_BREAK.test(line)) {
      structural.add(index);
    }
    if (
      index + 1 < lines.length &&
      !structural.has(index + 1) &&
      line.trim().length > 0 &&
      SETEXT_UNDERLINE.test(lines[index + 1]!)
    ) {
      structural.add(index);
      structural.add(index + 1);
    }
    if (TABLE_DELIMITER.test(line)) {
      // Include the table's header rows above and body rows below the delimiter.
      let start = index - 1;
      while (start >= 0 && !structural.has(start) && lines[start]!.trim().length > 0 && lines[start]!.includes("|")) {
        structural.add(start);
        start -= 1;
      }
      let end = index;
      while (end < lines.length && !structural.has(end) && lines[end]!.trim().length > 0 && lines[end]!.includes("|")) {
        structural.add(end);
        end += 1;
      }
    }
  }
  return structural;
}

function firstClaimWithoutCoverage(lines: string[], structural: Set<number>): number | undefined {
  let paragraph: Array<[number, string]> = [];

  const flush = (): number | undefined => {
    if (paragraph.length === 0) return undefined;
    const joined = paragraph.map(([, line]) => line.trim()).join(" ");
    if (!CLAIM_RE.test(joined) || COVERAGE_RE.test(joined)) return undefined;
    const hit = paragraph.find(([, line]) => CLAIM_RE.test(line));
    return hit?.[0];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const stripped = line.trim();
    if (stripped.length === 0 || structural.has(index)) {
      const uncovered = flush();
      if (uncovered !== undefined) return uncovered;
      paragraph = [];
      continue;
    }
    if (MARKDOWN_LIST_ITEM.test(line) || line.includes("|")) {
      const uncovered = flush();
      if (uncovered !== undefined) return uncovered;
      paragraph = [[index + 1, line]];
      const after = flush();
      if (after !== undefined) return after;
      paragraph = [];
      continue;
    }
    paragraph.push([index + 1, line]);
  }
  return flush();
}

function findRepeatedLine(lines: string[], structural: Set<number>): number | undefined {
  let run = 1;
  for (let index = 0; index < lines.length; index += 1) {
    if (structural.has(index) || structural.has(index + 1)) {
      run = 1;
      continue;
    }
    const current = lines[index]!.trim();
    const next = lines[index + 1]?.trim() ?? "";
    run = current.length > 0 && current === next ? run + 1 : 1;
    if (run >= 3) return index + 1;
  }
  return undefined;
}

function findCharacterRun(lines: string[], structural: Set<number>): number | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    if (structural.has(index)) continue;
    if (/([.\-‐'’…])\1{19,}/.test(lines[index]!)) {
      return index + 1;
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
