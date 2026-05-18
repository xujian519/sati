import { canonicalMessagesToMemoryMessages, type MemoryCaptureTurnInput, type MemoryResolver, type MemoryRetrieveInput, type MemoryRetrieveResult, type ContextMemoryMessage } from "./MemoryResolver.js";

export type EdgeClawRetrieveContextResult = {
  systemContext?: string;
  context?: string;
  trace?: unknown;
  debug?: unknown;
};

export type EdgeClawCaptureTurnResult = {
  captured: boolean;
  normalizedMessages: ContextMemoryMessage[];
  sessionKey: string;
};

export type EdgeClawMemoryServiceLike = {
  retrieveContext(
    query: string,
    options?: {
      recentMessages?: ContextMemoryMessage[];
      workspaceHint?: string;
      retrievalMode?: "auto" | "explicit";
      signal?: AbortSignal;
    },
  ): Promise<EdgeClawRetrieveContextResult>;
  captureTurn(
    rawMessages: readonly unknown[],
    input: {
      sessionKey: string;
      timestamp?: string;
      source?: string;
    },
  ): EdgeClawCaptureTurnResult;
};

export type EdgeClawMemoryProviderOptions = {
  service: EdgeClawMemoryServiceLike;
  retrievalMode?: "auto" | "explicit";
  source?: string;
  now?: () => Date;
};

export class EdgeClawMemoryProvider implements MemoryResolver {
  private readonly now: () => Date;

  constructor(private readonly options: EdgeClawMemoryProviderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult> {
    try {
      const recentMessages = canonicalMessagesToMemoryMessages(input.recentMessages);
      const result = await this.options.service.retrieveContext(input.query, {
        recentMessages,
        workspaceHint: input.projectRoot,
        retrievalMode: this.options.retrievalMode ?? "auto",
        signal: input.signal,
      });
      const systemContext = (result.systemContext ?? result.context ?? "").trim();
      if (!systemContext) {
        return {
          diagnostics: [
            {
              code: "memory_context_empty",
              severity: "info",
              message: "EdgeClaw memory returned no relevant context.",
            },
          ],
          metadata: { trace: result.trace, debug: result.debug },
        };
      }

      return {
        systemContext,
        diagnostics: [],
        metadata: { trace: result.trace, debug: result.debug },
      };
    } catch (error) {
      return {
        diagnostics: [
          {
            code: "memory_provider_error",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }

  async captureTurn(input: MemoryCaptureTurnInput): Promise<void> {
    try {
      this.options.service.captureTurn(canonicalMessagesToMemoryMessages(input.messages), {
        sessionKey: input.sessionId,
        timestamp: this.now().toISOString(),
        source: this.options.source ?? "pilotdeck",
      });
    } catch {
      // Memory capture should not break the agent turn.
    }
  }
}
