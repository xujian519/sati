/**
 * Fuzzy find-and-replace for SKILL.md content.
 *
 * Full TypeScript port of hermes-agent `tools/fuzzy_match.py` — the same 9
 * strategies tried in the same order, so LLM-authored patches on markdown
 * skill files land with the same hit rate as hermes does.
 *
 * Strategy chain (each tried in order until one matches):
 *
 *   1. exact                 — direct string search.
 *   2. line_trimmed          — strip leading+trailing whitespace per line.
 *   3. whitespace_normalized — collapse multiple spaces/tabs to single space.
 *   4. indentation_flexible  — strip leading whitespace only.
 *   5. escape_normalized     — decode `\n` / `\t` / `\r` literals in pattern.
 *   6. trimmed_boundary      — trim only the first and last line.
 *   7. unicode_normalized    — ASCII-fold smart quotes, em/en dashes, …, nbsp.
 *   8. block_anchor          — match first+last lines, similarity gate for middle.
 *   9. context_aware         — ≥50% of lines have ≥0.80 similarity.
 *
 * Multi-occurrence matching is controlled via `replace_all`. When more than
 * one match is found and `replace_all` is false, returns an error asking the
 * caller to add more context.
 */

export type FuzzyStrategy =
  | 'exact'
  | 'line_trimmed'
  | 'whitespace_normalized'
  | 'indentation_flexible'
  | 'escape_normalized'
  | 'trimmed_boundary'
  | 'unicode_normalized'
  | 'block_anchor'
  | 'context_aware'

export type FuzzyResult = {
  newContent: string
  matchCount: number
  strategy: FuzzyStrategy | null
  error: string | null
}

type MatchSpan = [number, number] // [start, endExclusive]

/**
 * Find `oldString` in `content` using the 9-strategy chain and replace with
 * `newString`. Returns new content (or original on failure) + match count +
 * strategy name.
 */
export function fuzzyFindAndReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): FuzzyResult {
  if (!oldString) {
    return {
      newContent: content,
      matchCount: 0,
      strategy: null,
      error: 'old_string cannot be empty',
    }
  }
  if (oldString === newString) {
    return {
      newContent: content,
      matchCount: 0,
      strategy: null,
      error: 'old_string and new_string are identical',
    }
  }

  const strategies: Array<{
    name: FuzzyStrategy
    fn: (c: string, p: string) => MatchSpan[]
  }> = [
    { name: 'exact', fn: strategyExact },
    { name: 'line_trimmed', fn: strategyLineTrimmed },
    { name: 'whitespace_normalized', fn: strategyWhitespaceNormalized },
    { name: 'indentation_flexible', fn: strategyIndentationFlexible },
    { name: 'escape_normalized', fn: strategyEscapeNormalized },
    { name: 'trimmed_boundary', fn: strategyTrimmedBoundary },
    { name: 'unicode_normalized', fn: strategyUnicodeNormalized },
    { name: 'block_anchor', fn: strategyBlockAnchor },
    { name: 'context_aware', fn: strategyContextAware },
  ]

  for (const { name, fn } of strategies) {
    const matches = fn(content, oldString)
    if (matches.length === 0) continue

    if (matches.length > 1 && !replaceAll) {
      return {
        newContent: content,
        matchCount: 0,
        strategy: null,
        error:
          `Found ${matches.length} matches for old_string. ` +
          `Provide more context to make it unique, or set replace_all=true.`,
      }
    }

    return {
      newContent: applyReplacements(content, matches, newString),
      matchCount: matches.length,
      strategy: name,
      error: null,
    }
  }

  return {
    newContent: content,
    matchCount: 0,
    strategy: null,
    error: 'Could not find a match for old_string in the file',
  }
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function applyReplacements(
  content: string,
  matches: MatchSpan[],
  newString: string,
): string {
  // Replace from end to start so earlier positions stay valid.
  const sorted = [...matches].sort((a, b) => b[0] - a[0])
  let result = content
  for (const [start, end] of sorted) {
    result = result.slice(0, start) + newString + result.slice(end)
  }
  return result
}

/**
 * Compute absolute character offsets [startOfLineN, endExclusiveOfLineM] from
 * a content-lines array. Mirrors hermes' `_calculate_line_positions`.
 */
function lineRangeToOffsets(
  contentLines: string[],
  startLine: number,
  endLine: number,
  contentLength: number,
): MatchSpan {
  let startPos = 0
  for (let i = 0; i < startLine; i++) {
    startPos += (contentLines[i]?.length ?? 0) + 1
  }
  let endPos = 0
  for (let i = 0; i < endLine; i++) {
    endPos += (contentLines[i]?.length ?? 0) + 1
  }
  endPos = Math.max(endPos - 1, 0) // drop trailing newline separator
  if (endPos >= contentLength) endPos = contentLength
  return [startPos, endPos]
}

function findNormalizedMatches(
  content: string,
  contentLines: string[],
  normalizedContentLines: string[],
  normalizedPattern: string,
): MatchSpan[] {
  const patternLines = normalizedPattern.split('\n')
  const numPatternLines = patternLines.length
  const matches: MatchSpan[] = []

  for (let i = 0; i <= normalizedContentLines.length - numPatternLines; i++) {
    const block = normalizedContentLines
      .slice(i, i + numPatternLines)
      .join('\n')
    if (block === normalizedPattern) {
      matches.push(
        lineRangeToOffsets(
          contentLines,
          i,
          i + numPatternLines,
          content.length,
        ),
      )
    }
  }
  return matches
}

// ---------------------------------------------------------------------------
// Strategy 1 — exact
// ---------------------------------------------------------------------------

function strategyExact(content: string, pattern: string): MatchSpan[] {
  const matches: MatchSpan[] = []
  let start = 0
  while (true) {
    const pos = content.indexOf(pattern, start)
    if (pos === -1) break
    matches.push([pos, pos + pattern.length])
    start = pos + 1
  }
  return matches
}

// ---------------------------------------------------------------------------
// Strategy 2 — line_trimmed (strip leading+trailing ws per line)
// ---------------------------------------------------------------------------

function strategyLineTrimmed(content: string, pattern: string): MatchSpan[] {
  const contentLines = content.split('\n')
  const normalizedLines = contentLines.map(l => l.trim())
  const normalizedPattern = pattern
    .split('\n')
    .map(l => l.trim())
    .join('\n')
  return findNormalizedMatches(
    content,
    contentLines,
    normalizedLines,
    normalizedPattern,
  )
}

// ---------------------------------------------------------------------------
// Strategy 3 — whitespace_normalized (collapse runs of space/tab to single)
// ---------------------------------------------------------------------------

function strategyWhitespaceNormalized(
  content: string,
  pattern: string,
): MatchSpan[] {
  const normalize = (s: string): string => s.replace(/[ \t]+/g, ' ')
  const normPattern = normalize(pattern)
  const normContent = normalize(content)

  // If neither side changed, skip this strategy (would just duplicate exact).
  if (normContent === content && normPattern === pattern) return []

  const normMatches = strategyExact(normContent, normPattern)
  if (normMatches.length === 0) return []

  return mapWhitespaceNormalizedPositions(content, normContent, normMatches)
}

/**
 * Walk original↔normalized in lockstep to recover original offsets for each
 * normalized match. Mirrors hermes' `_map_normalized_positions`, which is
 * specifically written for the whitespace-collapse transform.
 */
function mapWhitespaceNormalizedPositions(
  original: string,
  normalized: string,
  normMatches: MatchSpan[],
): MatchSpan[] {
  if (normMatches.length === 0) return []

  const origToNorm: number[] = new Array(original.length).fill(0)
  let origIdx = 0
  let normIdx = 0

  while (origIdx < original.length && normIdx < normalized.length) {
    const o = original[origIdx]!
    const n = normalized[normIdx]!
    if (o === n) {
      origToNorm[origIdx] = normIdx
      origIdx++
      normIdx++
    } else if ((o === ' ' || o === '\t') && n === ' ') {
      origToNorm[origIdx] = normIdx
      origIdx++
      if (origIdx < original.length && original[origIdx] !== ' ' && original[origIdx] !== '\t') {
        normIdx++
      }
    } else if (o === ' ' || o === '\t') {
      origToNorm[origIdx] = normIdx
      origIdx++
    } else {
      // Shouldn't happen under our normalization; keep walking defensively.
      origToNorm[origIdx] = normIdx
      origIdx++
    }
  }
  while (origIdx < original.length) {
    origToNorm[origIdx] = normalized.length
    origIdx++
  }

  const normToOrigStart = new Map<number, number>()
  const normToOrigEnd = new Map<number, number>()
  for (let i = 0; i < origToNorm.length; i++) {
    const np = origToNorm[i]!
    if (!normToOrigStart.has(np)) normToOrigStart.set(np, i)
    normToOrigEnd.set(np, i)
  }

  const out: MatchSpan[] = []
  for (const [normStart, normEnd] of normMatches) {
    let origStart = normToOrigStart.get(normStart)
    if (origStart === undefined) {
      // Fallback: find first index whose norm value ≥ normStart
      origStart = origToNorm.findIndex(n => n >= normStart)
      if (origStart < 0) origStart = 0
    }

    let origEnd: number
    if (normToOrigEnd.has(normEnd - 1)) {
      origEnd = (normToOrigEnd.get(normEnd - 1) as number) + 1
    } else {
      origEnd = origStart + (normEnd - normStart)
    }

    // Expand to include trailing whitespace that was normalized away.
    while (
      origEnd < original.length &&
      (original[origEnd] === ' ' || original[origEnd] === '\t')
    ) {
      origEnd++
    }

    out.push([origStart, Math.min(origEnd, original.length)])
  }
  return out
}

// ---------------------------------------------------------------------------
// Strategy 4 — indentation_flexible (strip leading ws only)
// ---------------------------------------------------------------------------

function strategyIndentationFlexible(
  content: string,
  pattern: string,
): MatchSpan[] {
  const contentLines = content.split('\n')
  const normalizedLines = contentLines.map(l => l.replace(/^[ \t]+/, ''))
  const normalizedPattern = pattern
    .split('\n')
    .map(l => l.replace(/^[ \t]+/, ''))
    .join('\n')
  return findNormalizedMatches(
    content,
    contentLines,
    normalizedLines,
    normalizedPattern,
  )
}

// ---------------------------------------------------------------------------
// Strategy 5 — escape_normalized (decode \n / \t / \r literals in pattern)
// ---------------------------------------------------------------------------

function strategyEscapeNormalized(
  content: string,
  pattern: string,
): MatchSpan[] {
  const unescape = (s: string): string =>
    s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
  const decoded = unescape(pattern)
  if (decoded === pattern) return [] // nothing to decode, skip
  return strategyExact(content, decoded)
}

// ---------------------------------------------------------------------------
// Strategy 6 — trimmed_boundary (trim first+last line only)
// ---------------------------------------------------------------------------

function strategyTrimmedBoundary(
  content: string,
  pattern: string,
): MatchSpan[] {
  const patternLines = pattern.split('\n')
  if (patternLines.length === 0) return []

  const trimmed = [...patternLines]
  trimmed[0] = (trimmed[0] ?? '').trim()
  if (trimmed.length > 1) {
    trimmed[trimmed.length - 1] = (trimmed[trimmed.length - 1] ?? '').trim()
  }
  const modifiedPattern = trimmed.join('\n')

  const contentLines = content.split('\n')
  const matches: MatchSpan[] = []
  const lineCount = patternLines.length

  for (let i = 0; i <= contentLines.length - lineCount; i++) {
    const block = contentLines.slice(i, i + lineCount)
    const check = [...block]
    check[0] = (check[0] ?? '').trim()
    if (check.length > 1) {
      check[check.length - 1] = (check[check.length - 1] ?? '').trim()
    }
    if (check.join('\n') === modifiedPattern) {
      matches.push(
        lineRangeToOffsets(contentLines, i, i + lineCount, content.length),
      )
    }
  }
  return matches
}

// ---------------------------------------------------------------------------
// Strategy 7 — unicode_normalized
// ---------------------------------------------------------------------------

// Smart punctuation / nbsp → ASCII equivalents. Some map 1→N (em-dash → "--",
// ellipsis → "..."), so we carry a position map when recovering offsets.
const UNICODE_MAP: Record<string, string> = {
  '\u201c': '"',
  '\u201d': '"',
  '\u2018': "'",
  '\u2019': "'",
  '\u2014': '--',
  '\u2013': '-',
  '\u2026': '...',
  '\u00a0': ' ',
}

function unicodeNormalize(text: string): string {
  let out = ''
  for (const ch of text) {
    out += UNICODE_MAP[ch] ?? ch
  }
  return out
}

/**
 * Build a list of length `original.length + 1` where entry `i` is the
 * normalized index that original character `i` maps to. Mirrors hermes'
 * `_build_orig_to_norm_map`, accounting for 1→N expansions.
 */
function buildOrigToNormMap(original: string): number[] {
  const result: number[] = []
  let normPos = 0
  for (const ch of original) {
    result.push(normPos)
    const repl = UNICODE_MAP[ch]
    normPos += repl !== undefined ? repl.length : 1
  }
  result.push(normPos)
  return result
}

function mapPositionsNormToOrig(
  origToNorm: number[],
  normMatches: MatchSpan[],
): MatchSpan[] {
  const normToOrigStart = new Map<number, number>()
  for (let origPos = 0; origPos < origToNorm.length - 1; origPos++) {
    const np = origToNorm[origPos]!
    if (!normToOrigStart.has(np)) normToOrigStart.set(np, origPos)
  }
  const origLen = origToNorm.length - 1
  const out: MatchSpan[] = []
  for (const [normStart, normEnd] of normMatches) {
    if (!normToOrigStart.has(normStart)) continue
    const origStart = normToOrigStart.get(normStart) as number
    let origEnd = origStart
    while (origEnd < origLen && origToNorm[origEnd]! < normEnd) {
      origEnd++
    }
    out.push([origStart, origEnd])
  }
  return out
}

function strategyUnicodeNormalized(
  content: string,
  pattern: string,
): MatchSpan[] {
  const normPattern = unicodeNormalize(pattern)
  const normContent = unicodeNormalize(content)
  if (normContent === content && normPattern === pattern) return []

  let normMatches = strategyExact(normContent, normPattern)
  if (normMatches.length === 0) {
    // Fall back to line_trimmed over the normalized text — pulled inline so
    // we stay on the normalized string instead of bouncing through helpers
    // that would rebuild their own line splits.
    const normContentLines = normContent.split('\n')
    const trimmedContentLines = normContentLines.map(l => l.trim())
    const trimmedPattern = normPattern
      .split('\n')
      .map(l => l.trim())
      .join('\n')
    normMatches = findNormalizedMatches(
      normContent,
      normContentLines,
      trimmedContentLines,
      trimmedPattern,
    )
  }
  if (normMatches.length === 0) return []

  const origToNorm = buildOrigToNormMap(content)
  return mapPositionsNormToOrig(origToNorm, normMatches)
}

// ---------------------------------------------------------------------------
// Similarity helpers (for block_anchor / context_aware)
// ---------------------------------------------------------------------------

/**
 * Gestalt/Ratcliff–Obershelp-style similarity ratio, modelled on Python's
 * `difflib.SequenceMatcher.ratio()`. Returns 2·M/T where M is the length of
 * the longest common subsequence and T is the sum of input lengths.
 *
 * Uses rolling-array LCS so memory stays O(min(|a|, |b|)). Good enough for
 * short line-by-line or small middle-block comparisons — which is all the
 * block_anchor / context_aware strategies ever feed it.
 */
export function similarityRatio(a: string, b: string): number {
  const total = a.length + b.length
  if (total === 0) return 1.0
  if (a.length === 0 || b.length === 0) return 0.0

  // Ensure |b| ≤ |a| so the rolling array is the shorter of the two.
  let s1 = a
  let s2 = b
  if (s2.length > s1.length) {
    ;[s1, s2] = [s2, s1]
  }
  const m = s2.length
  let prev = new Uint16Array(m + 1)
  let curr = new Uint16Array(m + 1)
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= m; j++) {
      if (s1.charCodeAt(i - 1) === s2.charCodeAt(j - 1)) {
        curr[j] = prev[j - 1]! + 1
      } else {
        curr[j] = Math.max(prev[j]!, curr[j - 1]!)
      }
    }
    const tmp = prev
    prev = curr
    curr = tmp
    // Reset curr for next iteration (prev role). Only index 0 needs 0 anyway.
    for (let k = 0; k <= m; k++) curr[k] = 0
  }
  const lcs = prev[m] ?? 0
  return (2 * lcs) / total
}

// ---------------------------------------------------------------------------
// Strategy 8 — block_anchor (first+last line match, middle similarity gate)
// ---------------------------------------------------------------------------

function strategyBlockAnchor(content: string, pattern: string): MatchSpan[] {
  const normPattern = unicodeNormalize(pattern)
  const normContent = unicodeNormalize(content)

  const patternLines = normPattern.split('\n')
  if (patternLines.length < 2) return []

  const firstLine = (patternLines[0] ?? '').trim()
  const lastLine = (patternLines[patternLines.length - 1] ?? '').trim()

  const normContentLines = normContent.split('\n')
  const origContentLines = content.split('\n')
  const patternLineCount = patternLines.length

  const potential: number[] = []
  for (let i = 0; i <= normContentLines.length - patternLineCount; i++) {
    if (
      (normContentLines[i] ?? '').trim() === firstLine &&
      (normContentLines[i + patternLineCount - 1] ?? '').trim() === lastLine
    ) {
      potential.push(i)
    }
  }

  const matches: MatchSpan[] = []
  // 0.50 when a single candidate; 0.70 when multiple candidates compete. Same
  // thresholds as hermes — anything looser produced dangerous false positives.
  const threshold = potential.length === 1 ? 0.5 : 0.7

  for (const i of potential) {
    let similarity: number
    if (patternLineCount <= 2) {
      similarity = 1.0
    } else {
      const contentMiddle = normContentLines
        .slice(i + 1, i + patternLineCount - 1)
        .join('\n')
      const patternMiddle = patternLines.slice(1, -1).join('\n')
      similarity = similarityRatio(contentMiddle, patternMiddle)
    }

    if (similarity >= threshold) {
      matches.push(
        lineRangeToOffsets(
          origContentLines,
          i,
          i + patternLineCount,
          content.length,
        ),
      )
    }
  }
  return matches
}

// ---------------------------------------------------------------------------
// Strategy 9 — context_aware (≥50% lines have ≥0.80 similarity)
// ---------------------------------------------------------------------------

function strategyContextAware(content: string, pattern: string): MatchSpan[] {
  const patternLines = pattern.split('\n')
  const contentLines = content.split('\n')
  if (patternLines.length === 0) return []

  const matches: MatchSpan[] = []
  const patternLineCount = patternLines.length
  const threshold = patternLineCount * 0.5

  for (let i = 0; i <= contentLines.length - patternLineCount; i++) {
    const blockLines = contentLines.slice(i, i + patternLineCount)
    let highSimilarityCount = 0
    for (let k = 0; k < patternLineCount; k++) {
      const sim = similarityRatio(
        (patternLines[k] ?? '').trim(),
        (blockLines[k] ?? '').trim(),
      )
      if (sim >= 0.8) highSimilarityCount++
    }
    if (highSimilarityCount >= threshold) {
      matches.push(
        lineRangeToOffsets(
          contentLines,
          i,
          i + patternLineCount,
          content.length,
        ),
      )
    }
  }
  return matches
}
