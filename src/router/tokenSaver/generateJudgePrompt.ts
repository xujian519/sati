import type { RouterTokenSaverConfig } from "../config/schema.js";

export type JudgePromptInput = {
  userMessage: string;
  config: RouterTokenSaverConfig;
  /** Tier from the previous turn; helps the judge avoid mis-downgrading short continuation messages. */
  previousTier?: string;
};

export function generateJudgePrompt({ userMessage, config, previousTier }: JudgePromptInput): string {
  const tierLines = Object.entries(config.tiers)
    .map(([name, tier]) => {
      const desc = tier.description ? `: ${tier.description}` : "";
      return `- ${name}${desc}`;
    })
    .join("\n");

  const ruleLines = (config.rules ?? []).map((rule) => `- ${rule}`).join("\n");
  const rulesSection = ruleLines.length > 0 ? `\nRouting rules:\n${ruleLines}\n` : "";

  const contextSection = previousTier
    ? `\nPrevious turn was classified as: ${previousTier}. If the new message is a brief continuation (e.g. "continue", "go on", "好的", "继续"), prefer keeping the previous tier.\n`
    : "";

  return `You are a model-tier classifier for the PilotDeck router. Given the following user message, return exactly one tier wrapped in <tier>...</tier>.\n\nAvailable tiers:\n${tierLines}\n${rulesSection}${contextSection}\nUser message:\n"""\n${userMessage}\n"""\n\nDefault tier when uncertain: ${config.defaultTier}.\nRespond with only <tier>NAME</tier>.`;
}
