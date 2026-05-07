import type { PermissionResult } from "../../permission/index.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import type { PolitDeckToolDefinition } from "../protocol/types.js";

export type AskUserQuestionInput = {
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
};

export function createAskUserQuestionTool(): PolitDeckToolDefinition<AskUserQuestionInput> {
  return {
    name: "ask_user_question",
    aliases: ["AskUserQuestion"],
    description: "Ask the user structured multiple-choice questions through a host adapter.",
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["questions"],
      additionalProperties: false,
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "prompt", "options"],
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              prompt: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "label"],
                  additionalProperties: false,
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                  },
                },
              },
              allowMultiple: { type: "boolean" },
            },
          },
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => true,
    checkPermissions: async (_input, context): Promise<PermissionResult> => ({
      type: "ask",
      reason: { type: "tool", toolName: "ask_user_question", message: "User interaction is required." },
      request: {
        toolCallId: "",
        toolName: "ask_user_question",
        inputSummary: "structured questions",
        reason: { type: "tool", toolName: "ask_user_question", message: "User interaction is required." },
        options: context.permissionContext.canPrompt
          ? [{ id: "allow_once", label: "Ask user" }]
          : [{ id: "deny", label: "Cannot prompt" }],
      },
    }),
    execute: async () => {
      throw new PolitDeckToolRuntimeError("unsupported_tool", "ask_user_question requires a host prompt adapter.");
    },
  };
}
