import type { DiscoveryPlanRecord } from "../protocol/types.js";
import { ALWAYS_ON_PLAN_TOOL_NAME } from "../tool/AlwaysOnDiscoveryPlanTool.js";
import { ALWAYS_ON_REPORT_TOOL_NAME } from "../tool/AlwaysOnReportTool.js";

export type BuildDiscoveryPromptInput = {
  projectRoot: string;
  runId: string;
  /** ISO timestamp the runtime should embed in the plan metadata. */
  createdAt: string;
  /** Absolute path of the isolated workspace this turn is running in. */
  workspaceCwd: string;
  /** Strategy id of the isolated workspace (git-worktree | snapshot-copy). */
  workspaceStrategy: string;
  /** Absolute path of the project's PolitDeck chat transcript directory. */
  chatDir: string;
};

export function buildDiscoveryPrompt(input: BuildDiscoveryPromptInput): string {
  return [
    `You are running an autonomous Always-On discovery for project: ${input.projectRoot}`,
    "",
    "Goal: identify AT MOST ONE concrete, automatically-verifiable improvement to propose.",
    "If nothing actionable is found, do not call any tool — just respond with a short note explaining why.",
    "",
    `Isolated workspace cwd: ${input.workspaceCwd}`,
    `Workspace strategy: ${input.workspaceStrategy}.`,
    "Treat the workspace contents as the current snapshot of the project — read / glob / bash freely.",
    "The user's project root is untouched; do not cd outside the workspace.",
    "",
    `Project chat history (PolitDeck transcripts) lives at: ${input.chatDir}`,
    "Use read_file / glob / bash on that directory to skim recent user-agent conversations",
    "when looking for valuable, automatically-verifiable improvements.",
    "",
    `If you do find one, call \`${ALWAYS_ON_PLAN_TOOL_NAME}\` exactly once with a strictly-formatted markdown plan.`,
    "Required plan structure (top to bottom):",
    "  - Level-1 heading: # <plan title>",
    "  - Metadata blockquote, first line `Always-On Discovery Plan`, then keyed lines:",
    `    > id: plan_${input.runId}`,
    `    > sourceRunId: ${input.runId}`,
    `    > createdAt: ${input.createdAt}`,
    `    > projectRoot: ${input.projectRoot}`,
    "    > dedupeKey: <stable identifier>",
    "  - Sections in this exact order: ## Summary, ## Rationale, ## Context Signals, ## Proposed Change, ## Execution Steps, ## Verification.",
    "  - Summary ≤ 200 chars, single paragraph.",
    "  - Context Signals: at least one `-` bullet.",
    "  - Execution Steps: ordered list (1., 2., …) only; no bullets.",
    "  - Verification: at least one `-` bullet, each line must be machine-checkable.",
    "",
    "Hard constraints:",
    `  - Calling \`${ALWAYS_ON_PLAN_TOOL_NAME}\` more than once returns plan_quota_exhausted.`,
    "  - Plans missing or reordering required sections, or containing fuzzy 'TODO' wording, will be rejected.",
    "  - Do not include Risks or Rollback sections.",
  ].join("\n");
}

export type BuildExecutionPromptInput = {
  plan: DiscoveryPlanRecord;
  planMarkdown: string;
  workspaceCwd: string;
  workspaceStrategy: string;
};

export function buildExecutionPrompt(input: BuildExecutionPromptInput): string {
  return [
    `You are executing an Always-On discovery plan inside an isolated workspace.`,
    `Workspace strategy: ${input.workspaceStrategy}.`,
    `Workspace cwd: ${input.workspaceCwd}`,
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    "Safety boundary is the workspace itself; do NOT cd outside it, do NOT touch the user's project root.",
    "",
    "## Plan",
    input.planMarkdown.trim(),
    "",
    "## What to do",
    "1. Execute the Execution Steps in order.",
    "2. Run the Verification list and record results.",
    `3. Finish by calling \`${ALWAYS_ON_REPORT_TOOL_NAME}\` exactly once with the work-report markdown.`,
    "",
    "Required report sections in order: Plan Reference, Steps Performed, Files Changed, Command Output, Verification Results, Follow-ups, Notes.",
    "Missing sections will be filled by the runtime fallback.",
  ].join("\n");
}
