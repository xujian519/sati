import type { CanonicalMessage } from "../../model/index.js";

export type ContextMemoryMessage = {
  msgId?: string;
  role: string;
  content: string;
};

export type MemoryRetrieveInput = {
  query: string;
  sessionId: string;
  projectRoot: string;
  recentMessages: CanonicalMessage[];
  signal?: AbortSignal;
};

export type MemoryRetrieveResult = {
  systemContext?: string;
  diagnostics: MemoryDiagnostic[];
  metadata?: Record<string, unknown>;
};

export type MemoryCaptureTurnInput = {
  sessionId: string;
  projectRoot: string;
  messages: CanonicalMessage[];
};

export type MemoryDiagnostic = {
  code: "memory_disabled" | "memory_provider_error" | "memory_context_empty";
  message: string;
  severity: "info" | "warning" | "error";
};

export type MemoryResolver = {
  retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult>;
  captureTurn(input: MemoryCaptureTurnInput): Promise<void>;
};

export function canonicalMessagesToMemoryMessages(messages: CanonicalMessage[]): ContextMemoryMessage[] {
  return messages.flatMap((message, index) => {
    const content = message.content
      .flatMap((block) => {
        if (block.type === "text") return [block.text];
        if (block.type === "tool_result") return block.content.map((item) => item.text);
        return [];
      })
      .join("\n")
      .trim();

    if (!content) {
      return [];
    }

    return [
      {
        msgId: `message-${index}`,
        role: message.role,
        content,
      },
    ];
  });
}
