const TIER_TAG_PATTERN = /<tier>\s*([a-z0-9_-]+)\s*<\/tier>/i;

export function parseTier(judgeOutput: string, knownTiers: string[]): string | undefined {
  const match = TIER_TAG_PATTERN.exec(judgeOutput);
  if (match) {
    const candidate = match[1].toLowerCase();
    return knownTiers.includes(candidate) ? candidate : undefined;
  }
  const lowered = judgeOutput.toLowerCase();
  for (const tier of knownTiers) {
    if (lowered.includes(tier.toLowerCase())) {
      return tier;
    }
  }
  return undefined;
}
