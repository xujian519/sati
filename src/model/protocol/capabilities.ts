/**
 * 模型速度档（静态 catalog 维度，非实测吞吐）：fast = 交互延迟敏感场景，
 * balanced = 均衡，deep = 推理增强/吞吐与质量优先。供路由与 UI 选择参考。
 */
export type ModelSpeed = "fast" | "balanced" | "deep";

export type ModelCapabilities = {
  supportsToolUse: boolean;
  supportsStreaming: boolean;
  supportsParallelToolCalls: boolean;
  supportsThinking: boolean;
  supportsJsonSchema: boolean;
  supportsSystemPrompt: boolean;
  supportsPromptCache: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
};

export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
  supportsToolUse: false,
  supportsStreaming: true,
  supportsParallelToolCalls: false,
  supportsThinking: false,
  supportsJsonSchema: false,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 8192,
  maxOutputTokens: 65_536,
};

export function mergeCapabilities(
  defaults: ModelCapabilities,
  overrides: Partial<ModelCapabilities> | undefined,
): ModelCapabilities {
  return {
    ...defaults,
    ...(overrides ?? {}),
  };
}
