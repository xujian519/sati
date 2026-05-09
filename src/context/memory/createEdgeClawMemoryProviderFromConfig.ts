/**
 * Build an `EdgeClawMemoryProvider` from `PolitMemoryConfig` + project root.
 * The factory is intentionally small — it just constructs the underlying
 * `EdgeClawMemoryService` with a sensible default rootDir and forwards the
 * relevant config fields.
 *
 * Returns `undefined` when the config is missing or `enabled === false`.
 *
 * Behavior parity goals:
 *   - The provider lives at the per-project scope (one DB per project root).
 *   - When `config.rootDir` is set we pin the workspace dir there; otherwise
 *     we anchor it under the project root so memory data lives next to the
 *     code it was captured from (matches legacy default).
 *   - `apiKey` for the LLM extractor is **lazily forwarded** — the user is
 *     expected to set it through env or politdeck.yaml; we never default
 *     credentials to anything other than what the user supplied.
 */

import { EdgeClawMemoryService } from "edgeclaw-memory-core";
import { EdgeClawMemoryProvider } from "./EdgeClawMemoryProvider.js";
import type { PolitMemoryConfig } from "../../polit/config/types.js";

export type CreateEdgeClawMemoryProviderOptions = {
  config: PolitMemoryConfig | undefined;
  projectRoot: string;
  /** Optional logger forwarded to the underlying service. */
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  /** Optional `now` for deterministic tests. */
  now?: () => Date;
};

export function createEdgeClawMemoryProviderFromConfig(
  options: CreateEdgeClawMemoryProviderOptions,
): { provider: EdgeClawMemoryProvider; service: EdgeClawMemoryService } | undefined {
  const cfg = options.config;
  if (!cfg || cfg.enabled !== true) return undefined;
  if (cfg.provider !== "edgeclaw") return undefined;

  const workspaceDir = options.projectRoot;
  const rootDir = cfg.rootDir;

  const service = new EdgeClawMemoryService({
    workspaceDir,
    rootDir,
    captureStrategy: cfg.captureStrategy,
    includeAssistant: cfg.includeAssistant,
    maxMessageChars: cfg.maxMessageChars,
    source: "politdeck",
    logger: options.logger,
    llm: cfg.llm
      ? {
          provider: cfg.llm.provider,
          model: cfg.llm.model,
          baseUrl: cfg.llm.baseUrl,
          apiKey: cfg.llm.apiKey,
          apiType: cfg.llm.apiType,
        }
      : undefined,
  });

  const provider = new EdgeClawMemoryProvider({
    service,
    source: "politdeck",
    now: options.now,
  });

  return { provider, service };
}
