import type { PilotDeckToolDefinition } from "../protocol/types.js";

export type ExitPlanModeInput = Record<string, never>;

const ENTER_PLAN_MODE_DESCRIPTION =
  "Enter plan mode for complex tasks requiring exploration and design. " +
  "Switches to a read-only phase where you explore the codebase, understand patterns, " +
  "and write a structured plan to a plan file before making any changes. " +
  "Prefer using this tool for non-trivial implementation tasks, especially when: " +
  "multiple valid approaches exist, the task touches many files, " +
  "or requirements need exploration to fully understand.";

const EXIT_PLAN_MODE_DESCRIPTION =
  "Signal that your plan is complete and ready for user review. " +
  "This tool reads the plan from the plan file you wrote during plan mode. " +
  "Do NOT use ask_user_question to ask about plan approval — that is exactly what this tool does.";

function buildEnterPlanModeResult(planFilePath: string | undefined): string {
  const planFileSection = planFilePath
    ? `## Plan File\nYour plan file is at: ${planFilePath}\nThis is the ONLY file you may write to. DO NOT edit any other files.\n`
    : "";

  return [
    "Plan mode activated. You are now in a read-only exploration and planning phase.",
    "",
    planFileSection,
    "## What To Do",
    "1. Explore the codebase using read_file, grep, glob to understand existing patterns and structure",
    "2. Identify the key files, functions, and data flows relevant to the task",
    "3. Design your implementation approach — consider trade-offs between alternatives",
    ...(planFilePath ? ["4. Write your plan incrementally to the plan file above"] : []),
    `${planFilePath ? "5" : "4"}. When your plan is ready, call exit_plan_mode to present it for user approval`,
    "",
    "## Rules",
    `- DO NOT call write_file, edit_file, or bash (non-readonly) on any file${planFilePath ? " except the plan file" : ""}`,
    "- You MAY use ask_user_question to clarify requirements or choose between approaches",
    "- Focus on understanding before proposing — read first, plan second",
  ].join("\n");
}

export function createEnterPlanModeTool(): PilotDeckToolDefinition<Record<string, never>> {
  return {
    name: "enter_plan_mode",
    aliases: ["EnterPlanMode"],
    description: ENTER_PLAN_MODE_DESCRIPTION,
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (_input, context) => ({
      content: [
        {
          type: "text",
          text: buildEnterPlanModeResult(context?.planFile?.path),
        },
      ],
      data: { requestedMode: "plan" },
    }),
  };
}

export function createExitPlanModeTool(): PilotDeckToolDefinition<ExitPlanModeInput> {
  return {
    name: "exit_plan_mode",
    aliases: ["ExitPlanMode"],
    description: EXIT_PLAN_MODE_DESCRIPTION,
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => true,
    execute: async (_input, context) => {
      const plan = context?.planFile?.read() ?? "(no plan file content)";
      return {
        content: [{ type: "text", text: plan }],
        data: { plan, requestedMode: "default" },
      };
    },
  };
}
