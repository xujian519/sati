import type { CanonicalModelRequest, CanonicalUsage } from "../../model/index.js";
import type { RouterConfig, RouterModelRef } from "../config/schema.js";
import type { RouterMutationsLog } from "../protocol/decision.js";
import { countMessagesTokens } from "../utils/countTokens.js";
import { calculateCacheReadCost, calculateInputCost } from "../utils/modelPricing.js";

/**
 * cache-aware 切换判定：从「上一轮的模型」换到「本轮选中的模型」是否划算。
 *
 * 输入是**上一轮观测到的缓存命中率**（`SessionUsageCache` 的产物）与本轮估算的
 * 输入 token，输出最终选择 + 一条 `cacheAwareSwitch` mutation。纯函数——除
 * `countMessagesTokens`（本地分词估算）外无 I/O，因此可直接构造输入单测。
 */

export function preserveStickyForCache(
  current: RouterModelRef | undefined,
  next: RouterModelRef,
  messages: CanonicalModelRequest["messages"],
  lastUsage: CanonicalUsage | undefined,
  config: RouterConfig,
): { selection: RouterModelRef; mutation?: RouterMutationsLog["cacheAwareSwitch"] } {
  const cacheAware = config.tokenSaver?.cacheAwareSwitching;
  if (cacheAware?.enabled === false || !current) {
    return { selection: next };
  }
  if (current.provider === next.provider && current.model === next.model) {
    return { selection: next };
  }

  const estimatedInputTokens = countMessagesTokens(messages);
  const observedInputTokens = lastUsage?.inputTokens ?? 0;
  const observedCacheReadTokens = lastUsage?.cacheReadTokens ?? 0;
  const observedCacheHitRatio =
    observedInputTokens > 0 ? Math.min(1, Math.max(0, observedCacheReadTokens / observedInputTokens)) : 0;
  if (observedCacheHitRatio <= 0) {
    return { selection: next };
  }

  const estimatedCacheReadTokens = Math.floor(estimatedInputTokens * observedCacheHitRatio);
  const estimatedUncachedTokens = Math.max(0, estimatedInputTokens - estimatedCacheReadTokens);
  const cachedCost =
    calculateCacheReadCost(estimatedCacheReadTokens, current.provider, current.model, config.stats?.modelPricing) +
    calculateInputCost(estimatedUncachedTokens, current.provider, current.model, config.stats?.modelPricing);
  const prefillCost = calculateInputCost(estimatedInputTokens, next.provider, next.model, config.stats?.modelPricing);

  const minSavingsRatio = cacheAware?.minSavingsRatio ?? 0;
  const requiredSavings = cachedCost * minSavingsRatio;
  const shouldSwitch = prefillCost + Number.EPSILON < cachedCost - requiredSavings;
  const from = `${current.provider}/${current.model}`;
  const to = `${next.provider}/${next.model}`;

  if (shouldSwitch) {
    return {
      selection: next,
      mutation: {
        action: "switched",
        from,
        to,
        cachedCost,
        prefillCost,
        estimatedInputTokens,
      },
    };
  }

  return {
    selection: current,
    mutation: {
      action: "kept_sticky",
      from,
      to,
      cachedCost,
      prefillCost,
      estimatedInputTokens,
    },
  };
}
