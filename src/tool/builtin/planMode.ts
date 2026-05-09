import type { PilotDeckToolDefinition } from "../protocol/types.js";

export type ExitPlanModeInput = {
  plan: string;
};

export function createEnterPlanModeTool(): PilotDeckToolDefinition<Record<string, never>> {
  return {
    name: "enter_plan_mode",
    aliases: ["EnterPlanMode"],
    description: "Request entry into PilotDeck plan mode.",
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({
      content: [{ type: "text", text: "Plan mode entry requested." }],
      data: { requestedMode: "plan" },
    }),
  };
}

export function createExitPlanModeTool(): PilotDeckToolDefinition<ExitPlanModeInput> {
  return {
    name: "exit_plan_mode",
    aliases: ["ExitPlanMode"],
    description: "Submit a plan and request exit from PilotDeck plan mode.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["plan"],
      additionalProperties: false,
      properties: {
        plan: { type: "string" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => true,
    execute: async (input) => ({
      content: [{ type: "text", text: input.plan }],
      data: { plan: input.plan, requestedMode: "default" },
    }),
  };
}
