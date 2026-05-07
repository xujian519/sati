import type { AgentContextRuntime, AgentContextPrepareInput, AgentPreparedContext } from "./ContextRuntime.js";

export class NullContextRuntime implements AgentContextRuntime {
  constructor(private readonly options: { maxMessages?: number } = {}) {}

  async prepareForModel(input: AgentContextPrepareInput): Promise<AgentPreparedContext> {
    const maxMessages = input.maxMessages ?? this.options.maxMessages;
    if (maxMessages !== undefined && input.messages.length > maxMessages) {
      return {
        messages: input.messages.slice(-maxMessages),
        tools: input.tools,
        boundaries: [{ type: "compact", retainedMessages: maxMessages }],
        diagnostics: [
          {
            code: "context_truncated",
            message: `Context was truncated to the last ${maxMessages} messages.`,
          },
        ],
      };
    }

    return {
      messages: input.messages,
      tools: input.tools,
      boundaries: [],
      diagnostics: [
        {
          code: "context_budget_not_enforced",
          message: "Token-level context budget is not enforced in the null context runtime.",
        },
      ],
    };
  }
}
