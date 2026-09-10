const TIER_TAG_PATTERN = /<tier>\s*([a-z0-9_-]+)\s*<\/tier>/i;

export function parseTier(judgeOutput: string, knownTiers: string[]): string | undefined {
  const cleaned = judgeOutput
    .replace(/```[a-z]*\n?/g, "")
    .replace(/```/g, "")
    .trim();

  const match = TIER_TAG_PATTERN.exec(cleaned);
  if (match) {
    const found = findExactTier(match[1], knownTiers);
    if (found) return found;
  }

  const exact = findExactTier(cleaned, knownTiers);
  if (exact) return exact;

  // Declared order (tiers are declared cheapest first), so a judge that names
  // several tiers ("not complex, it is simple") resolves to the cheaper one.
  // `-` and `_` count as name characters here: `\b` alone would let a tier that
  // is a word-prefix of a hyphenated one ("fast" inside "fast-pro") match first.
  for (const tier of knownTiers) {
    if (tierPattern(tier).test(cleaned)) {
      return tier;
    }
  }

  return undefined;
}

function findExactTier(value: string, knownTiers: string[]): string | undefined {
  const lowered = value.toLowerCase();
  return knownTiers.find(t => t.toLowerCase() === lowered);
}

/** Tier-name boundary: `\w` plus `-`/`_`, so prefixes never match inside a longer tier name. */
function tierPattern(tier: string): RegExp {
  return new RegExp(`(?<![\\w-])${escapeRegex(tier)}(?![\\w-])`, "i");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
