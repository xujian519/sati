import type { PilotDeckElicitationAnswer, PilotDeckElicitationRequest } from "../elicitation/PilotDeckElicitationChannel.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolDefinition } from "../protocol/types.js";

export type ExitPlanModeInput = Record<string, never>;
export type ExitPlanModeOutput = {
  plan: string;
  requestedMode?: "default";
  action?: "continue_planning" | "execute_plan" | "cancelled";
  feedback?: string;
};

const EXIT_PLAN_MODE_QUESTION = "What should happen next?";
const EXIT_PLAN_MODE_CONTINUE = "continue_planning";
const EXIT_PLAN_MODE_EXECUTE = "execute_plan";

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

function buildAlreadyInPlanModeResult(planFilePath: string | undefined): string {
  return [
    "Plan mode is already active.",
    "",
    ...(planFilePath
      ? [
          `Your plan file is at: ${planFilePath}`,
          "Continue refining that file. It remains the only file you may write while plan mode is active.",
          "",
        ]
      : []),
    "Stay in read-only exploration/planning until you are ready to call exit_plan_mode.",
  ].join("\n");
}

function buildApprovedPlanResult(plan: string, planFilePath: string | undefined): string {
  const locationSection = planFilePath
    ? [
        `Your plan file is at: ${planFilePath}`,
        "You can refer back to it during implementation if needed.",
        "",
      ]
    : [];
  return [
    "User has approved your plan. You can now start coding.",
    "Start with updating your todo list if applicable.",
    "",
    ...locationSection,
    "## Approved Plan",
    plan,
  ].join("\n");
}

function buildContinuePlanningResult(feedback: string | undefined): string {
  const feedbackSection = feedback
    ? `\n\nUser feedback:\n${feedback}`
    : "\n\nNo additional feedback was provided.";
  return [
    "The user wants to continue planning before implementation.",
    "Stay in plan mode, refine the plan file, and call exit_plan_mode again when the updated plan is ready.",
  ].join(" ") + feedbackSection;
}

function getExitPlanFeedback(answer: PilotDeckElicitationAnswer): string | undefined {
  if (answer.type !== "answered" || !answer.annotations) {
    return undefined;
  }
  for (const annotation of Object.values(answer.annotations)) {
    if (annotation?.notes?.trim()) {
      return annotation.notes.trim();
    }
  }
  return undefined;
}

function getExitPlanAction(answer: PilotDeckElicitationAnswer): "continue_planning" | "execute_plan" | undefined {
  if (answer.type !== "answered") {
    return undefined;
  }
  for (const value of Object.values(answer.answers)) {
    if (Array.isArray(value)) {
      const action = value.find((entry) => entry === EXIT_PLAN_MODE_CONTINUE || entry === EXIT_PLAN_MODE_EXECUTE);
      if (action) return action;
      continue;
    }
    if (value === EXIT_PLAN_MODE_CONTINUE || value === EXIT_PLAN_MODE_EXECUTE) {
      return value;
    }
  }
  return undefined;
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
    execute: async (_input, context) => {
      const text =
        context?.permissionMode === "plan"
          ? buildAlreadyInPlanModeResult(context?.planFile?.path)
          : buildEnterPlanModeResult(context?.planFile?.path);
      return {
        content: [{ type: "text", text }],
        ...(context?.permissionMode === "plan" ? {} : { data: { requestedMode: "plan" } }),
      };
    },
  };
}

export function createExitPlanModeTool(): PilotDeckToolDefinition<ExitPlanModeInput, ExitPlanModeOutput> {
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
      const channel = context?.elicitation;
      if (!channel) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "exit_plan_mode requires a connected user interaction channel.",
        );
      }
      const plan = context?.planFile?.read() ?? "(no plan file content)";
      const request: PilotDeckElicitationRequest = {
        toolCallId: context.turnId,
        toolName: "exit_plan_mode",
        previewFormat: "markdown",
        questions: [
          {
            question: EXIT_PLAN_MODE_QUESTION,
            header: "Plan",
            options: [
              {
                label: EXIT_PLAN_MODE_CONTINUE,
                description: "Keep planning and update the plan before any implementation starts.",
              },
              {
                label: EXIT_PLAN_MODE_EXECUTE,
                description: "Leave plan mode and let the agent execute this plan.",
              },
            ],
          },
        ],
        metadata: {
          source: "exit_plan_mode",
          plan,
          planFilePath: context.planFile?.path,
        },
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      };
      const answer = await channel.askUser(request);
      const action = getExitPlanAction(answer);
      const feedback = getExitPlanFeedback(answer);

      if (answer.type === "cancelled" || !action) {
        return {
          content: [{
            type: "text",
            text: "Exit plan mode was cancelled. Stay in plan mode and continue refining the plan file.",
          }],
          data: { plan, action: "cancelled" },
        };
      }

      if (action === EXIT_PLAN_MODE_EXECUTE) {
        return {
          content: [{
            type: "text",
            text: buildApprovedPlanResult(plan, context.planFile?.path),
          }],
          data: { plan, action, requestedMode: "default" },
        };
      }

      return {
        content: [{
          type: "text",
          text: buildContinuePlanningResult(feedback),
        }],
        data: { plan, action, ...(feedback ? { feedback } : {}) },
      };
    },
  };
}
