import type { AlwaysOnCurrentWorkspaceRef, DiscoveryPlanRecord } from "../protocol/types.js";
import type { WorkspaceDiff } from "../workspace/WorkspaceApply.js";
import { ALWAYS_ON_PLAN_TOOL_NAME } from "../tool/AlwaysOnDiscoveryPlanTool.js";
import { ALWAYS_ON_REPORT_TOOL_NAME } from "../tool/AlwaysOnReportTool.js";
import { ALWAYS_ON_WORKSPACE_TOOL_NAME } from "../tool/AlwaysOnWorkspaceTool.js";

export type BuildDiscoveryPromptInput = {
  projectRoot: string;
  runId: string;
  /** ISO timestamp the runtime should embed in the plan metadata. */
  createdAt: string;
  /** Absolute path of the project's PilotDeck chat transcript directory. */
  chatDir: string;
  /** When an isolated workspace from a previous run still exists on disk, discovery runs inside it. */
  workspace?: { cwd: string; strategy: string };
};

export function buildDiscoveryPrompt(input: BuildDiscoveryPromptInput): string {
  const codeAccessLines: string[] = input.workspace
    ? [
        `Isolated workspace cwd: ${input.workspace.cwd}`,
        `Workspace strategy: ${input.workspace.strategy}.`,
        "This workspace is an isolated snapshot of the project — read / glob / bash freely inside it.",
        `Do NOT cd outside the workspace to the project root (${input.projectRoot}).`,
      ]
    : [
        `Read the project root at ${input.projectRoot} using read_file / glob / bash freely.`,
      ];

  return [
    `You are running an autonomous Always-On discovery for project: ${input.projectRoot}`,
    "",
    "Goal: identify AT MOST ONE concrete, automatically-verifiable improvement to propose.",
    "If nothing actionable is found, do not call any tool — just respond with a short note explaining why.",
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    ...codeAccessLines,
    "",
    `Project chat history (PilotDeck transcripts) lives at: ${input.chatDir}`,
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

export type BuildWorkspacePromptInput = {
  projectRoot: string;
  runId: string;
  currentWorkspace?: AlwaysOnCurrentWorkspaceRef;
};

export function buildWorkspacePrompt(input: BuildWorkspacePromptInput): string {
  const lines: string[] = [
    "You are preparing an isolated workspace for an Always-On plan execution.",
    "",
    `Project root: ${input.projectRoot}`,
    "",
    "Available workspace strategies:",
    "  - `git-worktree`: Creates a detached git worktree. Fast and space-efficient (hard-links).",
    "    Requires a git repo with at least one commit and a clean working tree (no uncommitted changes).",
    "  - `snapshot-copy`: Copies the project directory (CoW on APFS/btrfs). Works for any directory",
    "    but uses more disk space. Ignores .git, node_modules, dist by default.",
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
  ];

  if (input.currentWorkspace) {
    lines.push(
      "",
      `A workspace from a previous run already exists at: ${input.currentWorkspace.cwd}`,
      `Strategy: ${input.currentWorkspace.strategy}`,
      "If the directory still exists on disk, you may skip workspace creation entirely",
      "by responding without calling the workspace tool.",
    );
  }

  lines.push(
    "",
    "## What to do",
    "1. Check the project root state (e.g. `git status --porcelain` if it looks like a git repo, or `ls` otherwise).",
    `2. Call \`${ALWAYS_ON_WORKSPACE_TOOL_NAME}\` with the chosen strategy, or \`auto\` to let the runtime decide.`,
    "3. If reusing an existing workspace, just respond with a short note and do not call the tool.",
  );

  return lines.join("\n");
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
    "3. Respond with a summary of what was done and the verification outcomes.",
  ].join("\n");
}

export type BuildReportPromptInput = {
  plan: DiscoveryPlanRecord;
  planMarkdown: string;
  workspaceCwd: string;
  workspaceStrategy: string;
};

export function buildReportPrompt(input: BuildReportPromptInput): string {
  return [
    "You are writing a work report for a completed Always-On plan execution.",
    `Workspace strategy: ${input.workspaceStrategy}.`,
    `Workspace cwd: ${input.workspaceCwd}`,
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    "",
    "## Plan that was executed",
    input.planMarkdown.trim(),
    "",
    "## What to do",
    "1. Review the workspace to see what changed (e.g. `git diff --stat`, `ls`, read relevant files).",
    "2. Summarize the execution: what steps were performed, which files were changed, command outputs, and verification results.",
    `3. Call \`${ALWAYS_ON_REPORT_TOOL_NAME}\` exactly once with the full work-report markdown.`,
    "",
    "Required report sections in order: Plan Reference, Steps Performed, Files Changed, Command Output, Verification Results, Follow-ups, Notes.",
    "Missing sections will be filled by the runtime fallback.",
  ].join("\n");
}

export type BuildApplyPromptInput = {
  plan: { title: string; id: string; workspace?: { cwd: string; strategy: string } };
  projectName: string;
  projectRoot: string;
  diff: WorkspaceDiff;
};

export function buildApplyPrompt(input: BuildApplyPromptInput): string {
  const { plan, projectName, projectRoot, diff } = input;
  const header = [
    `Always-On apply for project "${projectName}".`,
    "",
    "Your job is to merge changes from the isolated workspace into the project root.",
    "Apply each change carefully using Edit or Write tools.",
    "If a file in the project root has been modified since the plan was executed,",
    "merge both sets of changes intelligently — do not blindly overwrite.",
    "If you cannot resolve a conflict, leave standard conflict markers (<<<< / ==== / >>>>).",
    "",
    "Do not enter Plan Mode.",
    "Do not create a new plan — apply the existing changes directly.",
    "",
    `Plan: "${plan.title}" (${plan.id})`,
    `Project root: ${projectRoot}`,
  ];

  if (plan.workspace?.cwd) {
    header.push(`Isolated workspace: ${plan.workspace.cwd} (${plan.workspace.strategy})`);
  }

  header.push("");

  if (!diff.diff.trim()) {
    header.push("No differences detected in the workspace. Nothing to apply.");
    return header.join("\n");
  }

  if (diff.truncated) {
    header.push(
      `The diff is large (${diff.fileCount} files) and has been truncated.`,
      "Read the relevant files from the workspace directory to compare and apply.",
      "",
      "Truncated diff (first portion):",
      "",
      diff.diff,
    );
  } else {
    header.push(
      `Changes (${diff.fileCount} file${diff.fileCount === 1 ? "" : "s"}):`,
      "",
      diff.diff,
    );
  }

  return header.join("\n");
}
