import type { ModelRuntime, ModelTokenLimitSource } from "../../model/index.js";
import type { PilotAgentModelSelection } from "../../pilot/config/types.js";

export type ResolveRoutedModelMaxContextTokensInput = {
  modelRuntime: Pick<ModelRuntime, "getCapabilities">;
  agentModel: PilotAgentModelSelection;
  agentMaxContextTokens?: number;
  provider: string;
  model: string;
};

export function resolveRoutedModelMaxContextTokens(input: ResolveRoutedModelMaxContextTokensInput): number | undefined {
  if (
    input.agentMaxContextTokens !== undefined &&
    input.provider === input.agentModel.provider &&
    input.model === input.agentModel.model
  ) {
    return input.agentMaxContextTokens;
  }

  try {
    return input.modelRuntime.getCapabilities(input.provider, input.model).maxContextTokens;
  } catch {
    // 能力探测失败（未知模型/远端未返回能力）→ 回退 agent 配置值。
    return undefined;
  }
}

export type ResolveSubagentTokenLimitsInput = {
  parentProvider: string;
  parentMaxContextTokens?: number;
  parentMaxOutputTokens?: number;
  subagentProvider: string;
  subagentMaxContextTokens: number;
  subagentMaxOutputTokens?: number;
  subagentContextSource?: ModelTokenLimitSource;
  subagentOutputSource?: ModelTokenLimitSource;
};

export type SubagentTokenLimitResolution = {
  maxContextTokens: number;
  maxOutputTokens?: number;
  /** 子代理窗口未知（协议默认）→ 采用同 provider 父级已知窗口。 */
  inheritedContextWindow: boolean;
  /** 子代理输出上限未知（协议默认）→ 采用同 provider 父级已知上限。 */
  inheritedOutputLimit: boolean;
};

/**
 * 子代理 token 上限解析：模型能力是事实时直接采用；只有「协议默认」
 * （未命中 catalog / 未声明 / 无探测覆盖 = 我们不知道真实容量）才允许
 * 继承同 provider 父级的已知窗口，并且只在父级更大时继承。
 *
 * 背景：自定义/别名模型的窗口解析会落到协议默认（OpenAI 128k），而当前
 * 主流模型常见 1M；把兜底假设当事实会让子代理在远未到真实上限时反复压缩、
 * 甚至复核卡死。跨 provider 不继承（协议与容量语义不同）。
 */
export function resolveSubagentTokenLimits(input: ResolveSubagentTokenLimitsInput): SubagentTokenLimitResolution {
  const sameProvider = input.subagentProvider === input.parentProvider;
  const inheritedContextWindow =
    sameProvider &&
    input.subagentContextSource === "protocol-default" &&
    input.parentMaxContextTokens !== undefined &&
    input.parentMaxContextTokens > input.subagentMaxContextTokens;
  const inheritedOutputLimit =
    sameProvider &&
    input.subagentOutputSource === "protocol-default" &&
    input.parentMaxOutputTokens !== undefined &&
    input.subagentMaxOutputTokens !== undefined &&
    input.parentMaxOutputTokens > input.subagentMaxOutputTokens;
  return {
    maxContextTokens: inheritedContextWindow ? input.parentMaxContextTokens! : input.subagentMaxContextTokens,
    maxOutputTokens: inheritedOutputLimit ? input.parentMaxOutputTokens : input.subagentMaxOutputTokens,
    inheritedContextWindow,
    inheritedOutputLimit,
  };
}
