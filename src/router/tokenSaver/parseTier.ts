const TIER_TAG_PATTERN = /<tier>\s*([a-z0-9_-]+)\s*<\/tier>/i;

export function parseTier(judgeOutput: string, knownTiers: string[]): string | undefined {
  const match = TIER_TAG_PATTERN.exec(judgeOutput);
  if (match) {
    const candidate = match[1];
    const found = knownTiers.find(t => t.toLowerCase() === candidate.toLowerCase());
    if (found) return found;
  }
  for (const tier of knownTiers) {
    const pattern = new RegExp(`\\b${escapeRegex(tier)}\\b`, "i");
    if (pattern.test(judgeOutput)) {
      return tier;
    }
  }
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
