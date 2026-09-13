/**
 * 会话 Agent 配置构造（P4a 第八刀，类内拆分）：从 ProjectRuntimeRegistry.createAgentConfig 搬出。
 *
 * 输入面 = 会话标识 + 运行时投影 + 4 个注册表值 + 4 个取数函数。四处取数保持 accessor 是有意的：
 *
 * - `getLiveRuleSet()`：无显式会话覆盖时**会 mint 并缓存**一份 per-session 活规则数组
 *   （`ProjectRuntimeRegistry.fallbackRuleSets`），提前在调用点求值会把这份有状态的副作用
 *   挪到构造参数求值期；返回的 `allow` 数组与 gateway 权限 hook 是**同一引用**（remember=true
 *   写回它，同 turn 内下一个工具调用即生效，见 `getLiveRuleSet` 注释）。
 * - `getPolicyDenyRules()`：读的是 per-project 的 policy deny 表，由专利输出门禁构造时登记
 *   （见 `patentOutputGateFactory.ts`），原表达式带 `?? []` 兜底。
 * - `getSessionOverride()`：会话覆盖表可被 `updateSubsystems` **整体替换**。
 * - `permissionMode` / `env` / `additionalWorkingDirectories` / `methodologyRegistry` 是
 *   `readonly` 值（构造后不再替换），按值传入。
 */

import type { SessionConfigOverride } from "../always-on/runtime/SessionConfigOverrides.js";
import { type AgentRuntimeConfig, type CreateAgentSessionOptions } from "../agent/index.js";
import { brandEnv, ENV_KEY } from "../env.js";
import { injectMethodology, type MethodologyRegistry } from "../methodology/index.js";
import { type ModelRuntime } from "../model/index.js";
import { resolveModelInfo } from "../model/resolveModelInfo.js";
import { createDefaultPermissionContext, type PermissionRule } from "../permission/index.js";
import type { loadPilotConfig } from "../pilot/index.js";
import { mergePolicyDenyRules } from "../rule/index.js";
import { parsePositiveInt } from "../shared/env/index.js";

/** buildAgentSessionConfig 需要读的 ProjectRuntime 投影（类内 ProjectRuntime 不导出）。 */
export type AgentSessionConfigRuntimeView = {
  projectRoot: string;
  snapshot: ReturnType<typeof loadPilotConfig>;
  model: ModelRuntime;
};

/** 会话级活规则集（与 gateway 权限 hook 共享同一批数组引用）。 */
export type AgentSessionLiveRuleSet = {
  allow: PermissionRule[];
  deny: PermissionRule[];
  ask: PermissionRule[];
};

export type AgentSessionConfigInput = {
  sessionKey: string;
  /** M4 会话级模型路由覆盖（团队成员唤醒传快照 modelRoute）。 */
  modelRoute?: { provider: string; model: string };
  runtime: AgentSessionConfigRuntimeView;
  /** 取数：会话覆盖表可被 updateSubsystems 整体替换。 */
  getSessionOverride: () => SessionConfigOverride | undefined;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  env: Record<string, string | undefined>;
  additionalWorkingDirectories?: string[];
  /** 取数：无显式覆盖时会 mint per-session 活数组并缓存，故不得提前求值。 */
  getLiveRuleSet: () => AgentSessionLiveRuleSet;
  /** 取数：per-project policy deny 表（原表达式带 `?? []` 兜底）。 */
  getPolicyDenyRules: () => PermissionRule[];
  methodologyRegistry: MethodologyRegistry;
};

export function buildAgentSessionConfig(deps: AgentSessionConfigInput): CreateAgentSessionOptions["config"] {
  const { runtime } = deps;

  const agent = runtime.snapshot.config.agent;
  const override = deps.getSessionOverride();
  const permissionMode = override?.permissionMode ?? deps.permissionMode;
  const cwd = override?.cwd ?? runtime.projectRoot;
  // M4：会话级模型路由覆盖（团队成员唤醒传快照 modelRoute）——仅覆盖本次会话的
  // provider/model，不改全局配置、不动 PilotConfigStore。整体应用（质量评审 M3）：
  // provider/model 双字段非空才覆盖——WS 线协议可直传部分字段（编译期约束管不到
  // 线协议），任一缺失整体回落项目默认，避免 provider 与 model 拼错对。
  let provider = agent.model.provider;
  let model = agent.model.model;
  const modelRoute = deps.modelRoute;
  if (
    modelRoute !== undefined &&
    typeof modelRoute.provider === "string" &&
    modelRoute.provider.length > 0 &&
    typeof modelRoute.model === "string" &&
    modelRoute.model.length > 0
  ) {
    provider = modelRoute.provider;
    model = modelRoute.model;
  }
  // Hand `PermissionContext` the same live rule-set reference the
  // gateway permission hook owns (see `getLiveRuleSet`). With this
  // shared reference, an "allow + remember" decision pushed by the
  // hook is visible to `PermissionRuntime.decide` on the very next
  // tool call inside the same turn — no roundtrip back to the client
  // needed, even when the client lives in a different process.
  const liveRuleSet = deps.getLiveRuleSet();
  // 阶段四 T3：统一能力解析（config → catalog → 协议默认），未知模型按
  // catalog/默认回退，而非盲目 text-only。
  const modelMultimodal: import("../model/index.js").MultimodalConstraints | undefined = resolveModelInfo(
    runtime.model,
    provider,
    model,
  ).multimodal;
  let maxContextTokens: number | undefined;
  let maxOutputTokens: number | undefined;
  try {
    const caps = runtime.model.getCapabilities(provider, model);
    maxContextTokens = agent.maxContextTokens ?? caps.maxContextTokens;
    maxOutputTokens = caps.maxOutputTokens;
  } catch {
    // 能力查询失败 → 上下文上限退回显式配置，输出上限留 undefined 由后续链路兜底。
    maxContextTokens = agent.maxContextTokens;
  }
  maxOutputTokens =
    parsePositiveInt(brandEnv(deps.env, ENV_KEY.MAX_OUTPUT_TOKENS)) ?? agent.maxOutputTokens ?? maxOutputTokens;
  const subagentModel = agent.subagents?.default;
  let subagentRuntimeModel: CreateAgentSessionOptions["config"]["subagentModel"];
  if (subagentModel) {
    let subagentModelMultimodal: import("../model/index.js").MultimodalConstraints | undefined;
    try {
      subagentModelMultimodal = resolveModelInfo(runtime.model, subagentModel.provider, subagentModel.model).multimodal;
    } catch {
      // Model or provider not found — keep the override but fall back to inherited caps.
    }
    let subagentMaxContextTokens: number | undefined;
    let subagentMaxOutputTokens: number | undefined;
    try {
      const caps = runtime.model.getCapabilities(subagentModel.provider, subagentModel.model);
      subagentMaxContextTokens = caps.maxContextTokens;
      subagentMaxOutputTokens = caps.maxOutputTokens;
    } catch {
      // Keep the override even if capability lookup fails.
    }
    subagentRuntimeModel = {
      provider: subagentModel.provider,
      model: subagentModel.model,
      ...(subagentModelMultimodal ? { modelMultimodal: subagentModelMultimodal } : {}),
      ...(subagentMaxContextTokens !== undefined ? { maxContextTokens: subagentMaxContextTokens } : {}),
      ...(subagentMaxOutputTokens !== undefined
        ? {
            maxOutputTokens: parsePositiveInt(brandEnv(deps.env, ENV_KEY.MAX_OUTPUT_TOKENS)) ?? subagentMaxOutputTokens,
          }
        : {}),
    };
  }
  return {
    provider,
    model,
    modelMultimodal,
    cwd,
    permissionMode,
    jsonSelfCorrect: true,
    workspaceLedger: brandEnv(deps.env, ENV_KEY.WORKSPACE_LEDGER_ENABLED) === "1",
    metacognitiveControl: brandEnv(deps.env, ENV_KEY.METACOGNITIVE_CONTROL_ENABLED) === "1",
    claimGuard: brandEnv(deps.env, ENV_KEY.CLAIM_GUARD_ENABLED) === "1",
    ...(subagentRuntimeModel ? { subagentModel: subagentRuntimeModel } : {}),
    subagentTimeoutMs: agent.subagents?.timeoutMs,
    maxContextTokens,
    maxOutputTokens,
    thinking: agent.thinking,
    methodologyInjection: lastUserMessage => {
      // minScore 0.2：要求至少命中约 2 个触发词（1/8≈0.12 的单词偶然命中
      // 会被过滤，如"问题/优化/流程"单独出现时），避免日常对话被强制注入格式。
      const result = injectMethodology(deps.methodologyRegistry, lastUserMessage, { minScore: 0.2 });
      return result.applied && result.prompt ? result.prompt : null;
    },
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: permissionMode,
      canPrompt: override?.canPrompt ?? true,
      bypassAvailable: override?.bypassAvailable ?? true,
      additionalWorkingDirectories: deps.additionalWorkingDirectories,
      rules: {
        allow: liveRuleSet.allow,
        // policy deny 前置是不变式：PermissionRuntime 取 deny 首个匹配，仅在来源为
        // "user" 时才允许被 session allow 覆盖——policy 若排后会被该短路路径绕过。
        deny: mergePolicyDenyRules(liveRuleSet.deny, deps.getPolicyDenyRules()),
        ask: liveRuleSet.ask,
      },
    }),
  };
}
