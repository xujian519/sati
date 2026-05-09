import type { RouterTokenSaverConfig } from "../config/schema.js";

export type JudgePromptInput = {
  userMessage: string;
  config: RouterTokenSaverConfig;
};

export function generateJudgePrompt({ userMessage, config }: JudgePromptInput): string {
  const tierLines = Object.entries(config.tiers)
    .map(([name, tier]) => {
      const desc = tier.description ? `: ${tier.description}` : "";
      return `- ${name}${desc}`;
    })
    .join("\n");

  const ruleLines = (config.rules ?? []).map((rule) => `- ${rule}`).join("\n");
  const rulesSection = ruleLines.length > 0 ? `\nRouting rules:\n${ruleLines}\n` : "";

  return `You are a model-tier classifier for the PilotDeck router. Given the following user message, return exactly one tier wrapped in <tier>...</tier>.\n\nAvailable tiers:\n${tierLines}\n${rulesSection}\nUser message:\n"""\n${userMessage}\n"""\n\nDefault tier when uncertain: ${config.defaultTier}.\nRespond with only <tier>NAME</tier>.`;
}
