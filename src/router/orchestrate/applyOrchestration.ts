import type {
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalToolSchema,
} from "../../model/index.js";
import type { RouterAutoOrchestrateConfig } from "../config/schema.js";
import type { RouterMutationsLog } from "../protocol/decision.js";

export type OrchestrationInput = {
  request: CanonicalModelRequest;
  config: RouterAutoOrchestrateConfig;
  isMainAgent: boolean;
  tier?: string;
  /**
   * Optional skill prompt loaded by the caller (typically through extension).
   * The router does not load files directly — it just receives prepared text.
   */
  skillPrompt?: string;
};

export type OrchestrationResult = {
  request: CanonicalModelRequest;
  mutations: RouterMutationsLog;
  /** True when orchestration actually mutated the request. */
  applied: boolean;
};

export function applyOrchestration(input: OrchestrationInput): OrchestrationResult {
  const { config, request, skillPrompt } = input;
  if (!config.enabled || !input.isMainAgent) {
    return { request, mutations: {}, applied: false };
  }

  const triggerTiers = config.triggerTiers ?? [];
  if (triggerTiers.length > 0 && (!input.tier || !triggerTiers.includes(input.tier))) {
    return { request, mutations: {}, applied: false };
  }

  let messages = request.messages;
  let mutations: RouterMutationsLog = {};
  let mutated = false;

  if (skillPrompt && skillPrompt.length > 0) {
    messages = injectOrchestrationPrompt(messages, skillPrompt);
    mutations = {
      ...mutations,
      orchestrationPromptInjected: { tier: input.tier ?? "main", chars: skillPrompt.length },
    };
    mutated = true;
  }

  let tools = request.tools;
  if (tools && config.blockedTools && config.blockedTools.length > 0) {
    const before = tools.length;
    const blocked = new Set(config.blockedTools);
    const filtered = tools.filter((tool: CanonicalToolSchema) => !blocked.has(tool.name));
    if (filtered.length !== before) {
      tools = filtered;
      mutations = {
        ...mutations,
        toolsStripped: { before, after: filtered.length, patterns: config.blockedTools },
      };
      mutated = true;
    }
  }

  let systemPrompt = request.systemPrompt;
  if (config.slimSystemPrompt && systemPrompt && systemPrompt.length > 0) {
    const trimmed = trimSystemPrompt(systemPrompt);
    if (trimmed.text !== systemPrompt) {
      mutations = {
        ...mutations,
        systemPromptSlim: {
          from: systemPrompt.length,
          to: trimmed.text.length,
          preservedKeywords: trimmed.preservedKeywords,
        },
      };
      systemPrompt = trimmed.text;
      mutated = true;
    }
  }

  if (!mutated) {
    return { request, mutations: {}, applied: false };
  }

  return {
    request: {
      ...request,
      messages,
      tools,
      systemPrompt,
    },
    mutations,
    applied: true,
  };
}

function injectOrchestrationPrompt(
  messages: CanonicalMessage[],
  prompt: string,
): CanonicalMessage[] {
  const reminder: CanonicalMessage = {
    role: "user",
    content: [{ type: "text", text: `<system-reminder>\n${prompt}\n</system-reminder>` }],
  };
  return [reminder, ...messages];
}

function trimSystemPrompt(prompt: string): { text: string; preservedKeywords: string[] } {
  const lines = prompt.split("\n");
  const preservedKeywords: string[] = [];
  const keptLines: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("memory") || lower.includes("cache_control")) {
      preservedKeywords.push(line.trim().slice(0, 40));
      keptLines.push(line);
    } else if (keptLines.length === 0) {
      keptLines.push(line);
    }
  }
  return { text: keptLines.join("\n"), preservedKeywords };
}
