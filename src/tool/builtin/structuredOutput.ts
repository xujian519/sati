import type { PolitDeckToolDefinition } from "../protocol/types.js";

export type StructuredOutputInput = {
  value: unknown;
};

export function createStructuredOutputTool(): PolitDeckToolDefinition<StructuredOutputInput> {
  return {
    name: "structured_output",
    aliases: ["StructuredOutput"],
    description: "Return a final structured output payload for non-interactive hosts.",
    kind: "structured_output",
    inputSchema: {
      type: "object",
      required: ["value"],
      additionalProperties: false,
      properties: {
        value: {},
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input) => ({
      content: [{ type: "json", value: input.value }],
      data: input.value,
      metadata: { structuredOutput: true },
    }),
  };
}
