export type RouterModelPricing = {
  input?: number;
  output?: number;
  cacheRead?: number;
};

export type RouterModelPricingMap = Record<string, RouterModelPricing>;

// $/million tokens – fallback when neither nativeCost nor user modelPricing is available
const DEFAULT_PRICING: Array<{ pattern: RegExp; input: number; output: number; cacheRead?: number }> = [
  // DeepSeek v4（官方人民币价按 ≈7.2 汇率折算为美元，来源 api-docs.deepseek.com/quick_start/pricing）
  { pattern: /deepseek.*v4-flash/i, input: 0.14, output: 0.28, cacheRead: 0.003 },
  { pattern: /deepseek.*v4-pro/i, input: 0.42, output: 0.83, cacheRead: 0.0035 },
  // DeepSeek（旧版，随 deprecated 模型保留）
  { pattern: /deepseek.*flash/i, input: 0.2, output: 0.6 },
  { pattern: /deepseek.*chat/i, input: 0.5, output: 1.5 },
  { pattern: /deepseek.*reasoner/i, input: 0.8, output: 2.0 },
  { pattern: /deepseek.*v3/i, input: 0.27, output: 1.1 },
  // Anthropic Claude
  { pattern: /claude.*opus/i, input: 15.0, output: 75.0, cacheRead: 1.5 },
  { pattern: /claude.*sonnet/i, input: 3.0, output: 15.0, cacheRead: 0.3 },
  { pattern: /claude.*haiku/i, input: 0.8, output: 4.0, cacheRead: 0.08 },
  // OpenAI
  { pattern: /gpt-4o-mini/i, input: 0.15, output: 0.6, cacheRead: 0.075 },
  { pattern: /gpt-4o/i, input: 2.5, output: 10.0, cacheRead: 1.25 },
  { pattern: /gpt-4\.1/i, input: 2.0, output: 8.0, cacheRead: 0.5 },
  { pattern: /gpt-5/i, input: 2.0, output: 8.0, cacheRead: 0.5 },
  { pattern: /o[134]-mini/i, input: 1.1, output: 4.4 },
  { pattern: /o[134]-pro/i, input: 10.0, output: 40.0 },
  { pattern: /o[134]/i, input: 2.5, output: 10.0 },
  // Google Gemini
  { pattern: /gemini.*flash/i, input: 0.1, output: 0.4 },
  { pattern: /gemini.*pro/i, input: 1.25, output: 5.0 },
  // GLM / ChatGLM / Zhipu
  { pattern: /glm/i, input: 0.5, output: 1.0 },
  // Qwen / Tongyi
  { pattern: /qwen.*turbo/i, input: 0.3, output: 0.6 },
  { pattern: /qwen.*plus/i, input: 0.8, output: 2.0 },
  { pattern: /qwen.*max/i, input: 2.0, output: 6.0 },
  { pattern: /qwen/i, input: 0.5, output: 1.5 },
  // Llama / Meta
  { pattern: /llama.*70b/i, input: 0.8, output: 0.8 },
  { pattern: /llama.*405b/i, input: 3.0, output: 3.0 },
  { pattern: /llama/i, input: 0.2, output: 0.2 },
  // Mistral
  { pattern: /mistral.*large/i, input: 2.0, output: 6.0 },
  { pattern: /mistral.*small/i, input: 0.1, output: 0.3 },
  { pattern: /mistral/i, input: 0.25, output: 0.25 },
  // Yi / 01.AI
  { pattern: /yi-/i, input: 0.3, output: 0.3 },
  // Moonshot / Kimi（官方人民币价按 ≈7.2 汇率折算为美元，来源 platform.kimi.com/docs/pricing）
  { pattern: /kimi-k3/i, input: 2.78, output: 13.89, cacheRead: 0.28 },
  { pattern: /kimi-k2\.7-code-highspeed/i, input: 1.81, output: 7.5, cacheRead: 0.36 },
  { pattern: /kimi-k2\.7-code/i, input: 0.9, output: 3.75, cacheRead: 0.18 },
  { pattern: /kimi-k2\.6/i, input: 0.9, output: 3.75, cacheRead: 0.15 },
  { pattern: /moonshot|kimi/i, input: 1.0, output: 2.0 },
  // Doubao / ByteDance
  { pattern: /doubao/i, input: 0.4, output: 0.8 },
];

const FALLBACK_PRICING = { input: 0.5, output: 1.5 };

export function lookupModelPricing(
  provider: string,
  model: string,
  modelPricing?: RouterModelPricingMap,
): RouterModelPricing {
  const combined = `${provider}/${model}`;
  if (modelPricing) {
    const exact = modelPricing[combined];
    if (exact) return exact;
    // 含前缀/包含匹配时取最长 key，避免 "kimi-k2.7-code" 误命中 "kimi-k2.7-code-highspeed"。
    let bestKey: string | undefined;
    let best: RouterModelPricing | undefined;
    for (const [key, val] of Object.entries(modelPricing)) {
      if (model.includes(key) || key.includes(model)) {
        if (bestKey === undefined || key.length > bestKey.length) {
          bestKey = key;
          best = val;
        }
      }
    }
    if (best) return best;
  }
  for (const entry of DEFAULT_PRICING) {
    if (entry.pattern.test(combined) || entry.pattern.test(model)) {
      return { input: entry.input, output: entry.output, cacheRead: entry.cacheRead };
    }
  }
  return FALLBACK_PRICING;
}

export function calculateInputCost(
  tokens: number,
  provider: string,
  model: string,
  modelPricing?: RouterModelPricingMap,
): number {
  const pricing = lookupModelPricing(provider, model, modelPricing);
  return (tokens / 1_000_000) * (pricing.input ?? 0);
}

export function calculateCacheReadCost(
  tokens: number,
  provider: string,
  model: string,
  modelPricing?: RouterModelPricingMap,
): number {
  const pricing = lookupModelPricing(provider, model, modelPricing);
  return (tokens / 1_000_000) * (pricing.cacheRead ?? pricing.input ?? 0);
}
