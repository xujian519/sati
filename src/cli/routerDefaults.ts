/**
 * router 配置默认值构造（2026-09-11 由 createLocalGateway.ts 抽出，architecture-fix-plan P4a 第一刀）。
 *
 * 逐字迁移，行为不变；组合根（createLocalGateway）仅保留编排与装配调用。
 */

import { type PilotAgentModelSelection } from "../pilot/config/types.js";
import { isOptionalFeatureEnabled } from "../pilot/config/optionalFeature.js";
import {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_JUDGE_TIMEOUT_MS,
  DEFAULT_TRIGGER_TIERS,
  type RouterConfig,
} from "../router/config/schema.js";

export function ensureRouterConfig(
  router: RouterConfig | undefined,
  defaultSelection: PilotAgentModelSelection,
): RouterConfig {
  const defaultRef = { id: defaultSelection.id, provider: defaultSelection.provider, model: defaultSelection.model };
  // 段缺失 = 关（上游 #588）：未配置 router 的用户不再拿到一个全开的智能路由，
  // 请求也就不再凭空多出分类调用。判据同时承担「非空」窄化。
  if (!isOptionalFeatureEnabled(router)) {
    return { enabled: false };
  }
  // Scenarios is optional at the parse boundary (see schema.ts) — the UI
  // can persist a partial `router:` block, e.g. user toggled `enabled`
  // and seeded `tokenSaver.*` without ever opening the Scenarios editor.
  // Fill `scenarios.default` from `agent.model` so RouterRuntime always
  // sees a valid map. 只对显式配置过的 router 补默认值。
  return {
    enabled: true,
    ...router,
    scenarios: router.scenarios ?? { default: defaultRef },
    fallback: router.fallback ?? { default: [defaultRef] },
    tokenSaver: router.tokenSaver ?? buildDefaultTokenSaver(defaultRef),
    autoOrchestrate: router.autoOrchestrate ?? buildDefaultAutoOrchestrate(),
    stats: { enabled: true, baselineModel: defaultRef, ...(router.stats ?? {}) },
  };
}

export function buildDefaultTokenSaver(defaultRef: { id: string; provider: string; model: string }) {
  return {
    enabled: true,
    judge: defaultRef,
    defaultTier: "medium",
    judgeTimeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
    tiers: {
      simple: { model: defaultRef },
      medium: { model: defaultRef },
      complex: { model: defaultRef },
      reasoning: { model: defaultRef },
    },
  };
}

export function buildDefaultAutoOrchestrate() {
  return {
    enabled: true,
    triggerTiers: [...DEFAULT_TRIGGER_TIERS],
    slimSystemPrompt: true,
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],
  };
}
