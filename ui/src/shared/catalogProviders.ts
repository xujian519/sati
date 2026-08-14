/**
 * UI-side mirror of the provider catalog in `src/model/catalog/providers.ts`.
 * Kept here as a hand-curated subset because the UI bundle can't reach into
 * the engine catalog (different tsconfig / build root).
 *
 * Keep this in sync with the engine catalog when adding providers/models.
 * The engine catalog auto-fills capabilities and multimodal — this UI list
 * only needs the IDs and display names.
 *
 * Order note: common domestic providers (DeepSeek / Kimi / GLM / Qwen /
 * Doubao / MiniMax) are listed first so they surface prominently in the
 * onboarding provider grid and the Settings → 模型 "add provider" picker.
 */

export type CatalogModel = {
  id: string;
  displayName: string;
  /** Whether the model accepts image input. Drives the 🖼 indicator in the UI. */
  supportsImage?: boolean;
  /** Context window size (tokens). Drives the placeholder in the max-context-tokens setting. */
  maxContextTokens?: number;
  /** Output cap (tokens). Drives the placeholder in the max-output-tokens setting. */
  maxOutputTokens?: number;
};

export type CatalogProviderProtocol = "anthropic" | "openai" | "openai-responses" | "google";

export type CatalogProvider = {
  id: string;
  displayName: string;
  protocol: CatalogProviderProtocol;
  defaultUrl: string;
  modelListUrl?: string;
  requiresApiKey?: boolean;
  models: CatalogModel[];
};

export const CATALOG_PROVIDERS: CatalogProvider[] = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    protocol: "openai",
    defaultUrl: "https://api.deepseek.com/v1",
    modelListUrl: "https://api.deepseek.com/models",
    models: [
      { id: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", maxContextTokens: 1048576, maxOutputTokens: 393216 },
      { id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", maxContextTokens: 1048576, maxOutputTokens: 393216 },
      {
        id: "deepseek-chat",
        displayName: "DeepSeek Chat (V4 Flash)",
        maxContextTokens: 1048576,
        maxOutputTokens: 393216,
      },
      { id: "deepseek-reasoner", displayName: "DeepSeek Reasoner", maxContextTokens: 1048576, maxOutputTokens: 393216 },
    ],
  },
  {
    id: "moonshot",
    displayName: "Moonshot AI (Kimi)",
    protocol: "openai",
    defaultUrl: "https://api.moonshot.cn/v1",
    models: [
      { id: "kimi-k3", displayName: "Kimi K3", supportsImage: true, maxContextTokens: 1048576 },
      { id: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", supportsImage: true, maxContextTokens: 262144 },
      {
        id: "kimi-k2.7-code-highspeed",
        displayName: "Kimi K2.7 Code Highspeed",
        supportsImage: true,
        maxContextTokens: 262144,
      },
      { id: "kimi-k2.6", displayName: "Kimi K2.6", supportsImage: true, maxContextTokens: 262144 },
      { id: "kimi-k1.5", displayName: "Kimi K1.5", supportsImage: true, maxContextTokens: 131072 },
    ],
  },
  {
    id: "zhipu",
    displayName: "智谱 Z.AI",
    protocol: "openai",
    defaultUrl: "https://api.z.ai/api/paas/v4",
    models: [
      { id: "glm-5.2", displayName: "GLM-5.2", maxContextTokens: 131072, maxOutputTokens: 131072 },
      { id: "glm-5.1", displayName: "GLM-5.1", maxContextTokens: 131072, maxOutputTokens: 131072 },
      { id: "glm-5-turbo", displayName: "GLM-5 Turbo", maxContextTokens: 131072, maxOutputTokens: 131072 },
      { id: "glm-4.6", displayName: "GLM-4.6", maxContextTokens: 131072, maxOutputTokens: 131072 },
      { id: "glm-4.7", displayName: "GLM-4.7", maxContextTokens: 200000, maxOutputTokens: 131072 },
      { id: "glm-4.7-flashx", displayName: "GLM-4.7 FlashX", maxContextTokens: 200000, maxOutputTokens: 131072 },
      { id: "glm-4.7-flash", displayName: "GLM-4.7 Flash", maxContextTokens: 200000, maxOutputTokens: 131072 },
      { id: "glm-4-plus", displayName: "GLM-4 Plus", maxContextTokens: 128000, maxOutputTokens: 8192 },
      { id: "glm-4-air-250414", displayName: "GLM-4 Air 250414", maxContextTokens: 128000, maxOutputTokens: 8192 },
      { id: "glm-4-airx", displayName: "GLM-4 AirX", maxContextTokens: 128000, maxOutputTokens: 8192 },
      {
        id: "glm-4-flashx-250414",
        displayName: "GLM-4 FlashX 250414",
        maxContextTokens: 128000,
        maxOutputTokens: 8192,
      },
      { id: "glm-4-flash-250414", displayName: "GLM-4 Flash 250414", maxContextTokens: 128000, maxOutputTokens: 8192 },
    ],
  },
  {
    id: "dashscope",
    displayName: "阿里云百炼 (DashScope)",
    protocol: "openai",
    defaultUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      { id: "qwen3.7-max", displayName: "Qwen3.7 Max", maxContextTokens: 1000000, maxOutputTokens: 65536 },
      {
        id: "qwen3.7-plus",
        displayName: "Qwen3.7 Plus",
        supportsImage: true,
        maxContextTokens: 1000000,
        maxOutputTokens: 65536,
      },
      { id: "qwen3.6-flash", displayName: "Qwen3.6 Flash", maxContextTokens: 1000000, maxOutputTokens: 65536 },
      { id: "qwen-max", displayName: "Qwen Max", maxContextTokens: 131072, maxOutputTokens: 2000 },
      { id: "qwen-plus", displayName: "Qwen Plus", maxContextTokens: 131072, maxOutputTokens: 2000 },
      { id: "qwen-turbo", displayName: "Qwen Turbo", maxContextTokens: 131072, maxOutputTokens: 1500 },
    ],
  },
  {
    id: "volc_ark",
    displayName: "火山方舟 (Volcano Ark)",
    protocol: "openai",
    defaultUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [
      { id: "doubao-1.5-pro-256k", displayName: "Doubao 1.5 Pro 256K", supportsImage: true, maxContextTokens: 262144 },
      { id: "doubao-1.5-pro", displayName: "Doubao 1.5 Pro", supportsImage: true, maxContextTokens: 131072 },
      { id: "doubao-1.5-lite-128k", displayName: "Doubao 1.5 Lite 128K", maxContextTokens: 131072 },
      { id: "doubao-1.5-lite", displayName: "Doubao 1.5 Lite", maxContextTokens: 32768 },
      { id: "deepseek-r1", displayName: "DeepSeek R1 (Volc)", maxContextTokens: 65536 },
    ],
  },
  {
    id: "siliconflow",
    displayName: "硅基流动 (SiliconFlow)",
    protocol: "openai",
    defaultUrl: "https://api.siliconflow.cn/v1",
    modelListUrl: "https://api.siliconflow.cn/v1/models",
    models: [
      { id: "deepseek-ai/DeepSeek-V3", displayName: "DeepSeek V3", maxContextTokens: 64000, maxOutputTokens: 8192 },
      { id: "deepseek-ai/DeepSeek-R1", displayName: "DeepSeek R1", maxContextTokens: 64000, maxOutputTokens: 8192 },
      {
        id: "Qwen/Qwen2.5-72B-Instruct",
        displayName: "Qwen 2.5 72B Instruct",
        maxContextTokens: 32768,
        maxOutputTokens: 8192,
      },
      {
        id: "Qwen/Qwen2.5-7B-Instruct",
        displayName: "Qwen 2.5 7B Instruct",
        maxContextTokens: 32768,
        maxOutputTokens: 8192,
      },
      { id: "THUDM/GLM-4-9B-Chat", displayName: "GLM-4 9B Chat", maxContextTokens: 128000, maxOutputTokens: 8192 },
      {
        id: "moonshotai/Kimi-K2-Instruct",
        displayName: "Kimi K2 Instruct",
        maxContextTokens: 262144,
        maxOutputTokens: 8192,
      },
    ],
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    protocol: "openai",
    defaultUrl: "https://api.minimax.io/v1",
    modelListUrl: "https://api.minimax.io/v1/models",
    models: [
      { id: "MiniMax-M3", displayName: "MiniMax M3", maxContextTokens: 1000000, maxOutputTokens: 131072 },
      { id: "MiniMax-M2.7", displayName: "MiniMax M2.7", maxContextTokens: 204800, maxOutputTokens: 16384 },
      {
        id: "MiniMax-M2.7-highspeed",
        displayName: "MiniMax M2.7 Highspeed",
        maxContextTokens: 204800,
        maxOutputTokens: 16384,
      },
      { id: "MiniMax-M2.5", displayName: "MiniMax M2.5", maxContextTokens: 204800, maxOutputTokens: 16384 },
      {
        id: "MiniMax-M2.5-highspeed",
        displayName: "MiniMax M2.5 Highspeed",
        maxContextTokens: 204800,
        maxOutputTokens: 16384,
      },
      { id: "MiniMax-M2.1", displayName: "MiniMax M2.1", maxContextTokens: 204800, maxOutputTokens: 16384 },
      {
        id: "MiniMax-M2.1-highspeed",
        displayName: "MiniMax M2.1 Highspeed",
        maxContextTokens: 204800,
        maxOutputTokens: 16384,
      },
      { id: "MiniMax-M2", displayName: "MiniMax M2", maxContextTokens: 204800, maxOutputTokens: 10240 },
    ],
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    protocol: "anthropic",
    defaultUrl: "https://api.anthropic.com",
    models: [
      {
        id: "claude-sonnet-4.6",
        displayName: "Claude Sonnet 4.6",
        supportsImage: true,
        maxContextTokens: 200000,
        maxOutputTokens: 128000,
      },
      {
        id: "claude-opus-4-20250514",
        displayName: "Claude Opus 4",
        supportsImage: true,
        maxContextTokens: 200000,
        maxOutputTokens: 32768,
      },
      {
        id: "claude-sonnet-4-20250514",
        displayName: "Claude Sonnet 4",
        supportsImage: true,
        maxContextTokens: 200000,
        maxOutputTokens: 16384,
      },
      {
        id: "claude-sonnet-4-5-20250929",
        displayName: "Claude Sonnet 4.5",
        supportsImage: true,
        maxContextTokens: 200000,
        maxOutputTokens: 8192,
      },
      {
        id: "claude-haiku-3-5-20241022",
        displayName: "Claude 3.5 Haiku",
        supportsImage: true,
        maxContextTokens: 200000,
        maxOutputTokens: 8192,
      },
    ],
  },
  {
    id: "openai",
    displayName: "OpenAI",
    protocol: "openai",
    defaultUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-4.1", displayName: "GPT-4.1", supportsImage: true, maxContextTokens: 1047576, maxOutputTokens: 32768 },
      {
        id: "gpt-4.1-mini",
        displayName: "GPT-4.1 Mini",
        supportsImage: true,
        maxContextTokens: 1047576,
        maxOutputTokens: 32768,
      },
      { id: "gpt-4o", displayName: "GPT-4o", supportsImage: true, maxContextTokens: 128000, maxOutputTokens: 16384 },
      {
        id: "gpt-4o-mini",
        displayName: "GPT-4o Mini",
        supportsImage: true,
        maxContextTokens: 128000,
        maxOutputTokens: 16384,
      },
      { id: "o3", displayName: "o3", supportsImage: true, maxContextTokens: 200000, maxOutputTokens: 100000 },
      { id: "o3-mini", displayName: "o3 Mini", maxContextTokens: 200000, maxOutputTokens: 100000 },
    ],
  },
  {
    id: "openai-responses",
    displayName: "OpenAI (Responses API)",
    protocol: "openai-responses",
    defaultUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-4.1", displayName: "GPT-4.1", supportsImage: true, maxContextTokens: 1047576, maxOutputTokens: 32768 },
      {
        id: "gpt-4.1-mini",
        displayName: "GPT-4.1 Mini",
        supportsImage: true,
        maxContextTokens: 1047576,
        maxOutputTokens: 32768,
      },
      { id: "gpt-4o", displayName: "GPT-4o", supportsImage: true, maxContextTokens: 128000, maxOutputTokens: 16384 },
      {
        id: "gpt-4o-mini",
        displayName: "GPT-4o Mini",
        supportsImage: true,
        maxContextTokens: 128000,
        maxOutputTokens: 16384,
      },
      { id: "o3", displayName: "o3", supportsImage: true, maxContextTokens: 200000, maxOutputTokens: 100000 },
      { id: "o3-mini", displayName: "o3 Mini", maxContextTokens: 200000, maxOutputTokens: 100000 },
    ],
  },
  {
    id: "google",
    displayName: "Google AI (Gemini)",
    protocol: "google",
    defaultUrl: "https://generativelanguage.googleapis.com",
    models: [
      {
        id: "gemini-3.1-pro-preview",
        displayName: "Gemini 3.1 Pro Preview",
        supportsImage: true,
        maxContextTokens: 1048576,
        maxOutputTokens: 65536,
      },
      {
        id: "gemini-2.5-flash",
        displayName: "Gemini 2.5 Flash",
        supportsImage: true,
        maxContextTokens: 1048576,
        maxOutputTokens: 65536,
      },
      {
        id: "gemini-2.5-pro",
        displayName: "Gemini 2.5 Pro",
        supportsImage: true,
        maxContextTokens: 1048576,
        maxOutputTokens: 65536,
      },
      {
        id: "gemini-2.0-flash",
        displayName: "Gemini 2.0 Flash",
        supportsImage: true,
        maxContextTokens: 1048576,
        maxOutputTokens: 8192,
      },
    ],
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    protocol: "openai",
    defaultUrl: "https://openrouter.ai/api/v1",
    models: [
      {
        id: "anthropic/claude-sonnet-4.6",
        displayName: "Claude Sonnet 4.6",
        supportsImage: true,
        maxContextTokens: 200000,
      },
      { id: "google/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportsImage: true, maxContextTokens: 1048576 },
      { id: "deepseek/deepseek-v4-flash", displayName: "DeepSeek V4 Flash", maxContextTokens: 1048576 },
      { id: "moonshotai/kimi-k2.6", displayName: "Kimi K2.6", supportsImage: true, maxContextTokens: 262144 },
    ],
  },
  {
    id: "ollama",
    displayName: "Ollama",
    protocol: "openai",
    defaultUrl: "http://localhost:11434/v1",
    requiresApiKey: false,
    // 模型列表不写死：onboarding / 设置页从本地 Ollama 实时拉取
    // 用户已安装的模型（/api/tags 或 /v1/models），失败时允许手动输入。
    models: [],
  },
];

export function findCatalogProviderById(id: string): CatalogProvider | undefined {
  return CATALOG_PROVIDERS.find(p => p.id === id);
}

export function findCatalogProviderByUrl(url: string): CatalogProvider | undefined {
  return CATALOG_PROVIDERS.find(p => p.defaultUrl === url);
}
