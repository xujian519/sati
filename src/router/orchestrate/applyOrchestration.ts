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
  /** When true the session was already orchestrating on a prior turn. */
  alreadyOrchestrating?: boolean;
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

  if (!input.alreadyOrchestrating) {
    const triggerTiers = config.triggerTiers ?? [];
    if (triggerTiers.length > 0 && (!input.tier || !triggerTiers.includes(input.tier))) {
      return { request, mutations: {}, applied: false };
    }
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
  if (tools && config.allowedTools && config.allowedTools.length > 0) {
    const before = tools.length;
    const allowed = new Set(config.allowedTools);
    const filtered = tools.filter((tool: CanonicalToolSchema) => allowed.has(tool.name));
    if (filtered.length !== before) {
      tools = filtered;
      mutations = {
        ...mutations,
        toolsStripped: { before, after: filtered.length, mode: "allowlist", patterns: config.allowedTools },
      };
      mutated = true;
    }
  } else if (tools && config.blockedTools && config.blockedTools.length > 0) {
    const before = tools.length;
    const blocked = new Set(config.blockedTools);
    const filtered = tools.filter((tool: CanonicalToolSchema) => !blocked.has(tool.name));
    if (filtered.length !== before) {
      tools = filtered;
      mutations = {
        ...mutations,
        toolsStripped: { before, after: filtered.length, mode: "blocklist", patterns: config.blockedTools },
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

const SLIM_HEADER = "You are an orchestration agent. Use the Agent tool to delegate all work to sub-agents.";
const MEMORY_KEYWORDS = [
  "memory_search", "memory_overview", "memory_get",
  "memory_list", "memory_flush", "memory_dream",
  "ClawXMemory", "cache_control",
];

function trimSystemPrompt(prompt: string): { text: string; preservedKeywords: string[] } {
  const lines = prompt.split("\n");
  const preservedKeywords: string[] = [];
  const memoryLines: string[] = [];
  let inMemoryBlock = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    const isMemory = MEMORY_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
    if (isMemory) {
      inMemoryBlock = true;
      memoryLines.push(line);
      preservedKeywords.push(line.trim().slice(0, 40));
    } else if (inMemoryBlock && line.trim().length > 0) {
      memoryLines.push(line);
    } else {
      inMemoryBlock = false;
    }
  }

  const text = memoryLines.length > 0
    ? SLIM_HEADER + "\n\n" + memoryLines.join("\n")
    : SLIM_HEADER;
  return { text, preservedKeywords };
}
