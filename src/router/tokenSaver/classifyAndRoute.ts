import type {
  CanonicalMessage,
  CanonicalModelRequest,
  ModelRuntime,
} from "../../model/index.js";
import type { RouterModelRef, RouterTokenSaverConfig } from "../config/schema.js";
import { extractLastUserMessage } from "./extractLastUserMessage.js";
import { generateJudgePrompt } from "./generateJudgePrompt.js";
import { parseTier } from "./parseTier.js";

export type TokenSaverDecision = {
  tier: string;
  selection: RouterModelRef;
  resolvedFrom: "judge" | "default" | "fallback";
  failureReason?: "timeout" | "model_error" | "parse_error";
};

export type ClassifyAndRouteInput = {
  config: RouterTokenSaverConfig;
  messages: CanonicalMessage[];
  judgeRuntime: ModelRuntime;
  abortSignal?: AbortSignal;
};

export async function classifyAndRoute(
  input: ClassifyAndRouteInput,
): Promise<TokenSaverDecision | undefined> {
  const { config } = input;
  if (!config.enabled) {
    return undefined;
  }

  const defaultTier = config.tiers[config.defaultTier];
  if (!defaultTier) {
    return undefined;
  }

  const userMessage = extractLastUserMessage(input.messages);
  if (!userMessage) {
    return {
      tier: config.defaultTier,
      selection: defaultTier.model,
      resolvedFrom: "default",
    };
  }

  const knownTiers = Object.keys(config.tiers);
  const prompt = generateJudgePrompt({ userMessage, config });
  const judgeRequest: CanonicalModelRequest = {
    provider: config.judge.provider,
    model: config.judge.model,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    ],
    maxOutputTokens: 64,
    temperature: 0,
    stream: false,
  };

  const timeoutMs = Math.max(500, config.judgeTimeoutMs ?? 5_000);
  let timeout: NodeJS.Timeout | undefined;
  try {
    const response = await Promise.race([
      input.judgeRuntime.complete(judgeRequest),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new TokenSaverTimeoutError()), timeoutMs);
      }),
    ]);
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const tier = parseTier(text, knownTiers);
    if (!tier) {
      return {
        tier: config.defaultTier,
        selection: defaultTier.model,
        resolvedFrom: "fallback",
        failureReason: "parse_error",
      };
    }
    const selection = config.tiers[tier]?.model;
    if (!selection) {
      return {
        tier: config.defaultTier,
        selection: defaultTier.model,
        resolvedFrom: "fallback",
        failureReason: "parse_error",
      };
    }
    return { tier, selection, resolvedFrom: "judge" };
  } catch (error) {
    return {
      tier: config.defaultTier,
      selection: defaultTier.model,
      resolvedFrom: "fallback",
      failureReason: error instanceof TokenSaverTimeoutError ? "timeout" : "model_error",
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

class TokenSaverTimeoutError extends Error {
  readonly name = "TokenSaverTimeoutError";
}
