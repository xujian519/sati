import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiscoveryPrompt,
  buildExecutionPrompt,
  buildWorkspacePrompt,
  buildReportPrompt,
} from "../../src/always-on/runtime/discoveryPrompts.js";
import { ALWAYS_ON_PLAN_TOOL_NAME } from "../../src/always-on/tool/AlwaysOnDiscoveryPlanTool.js";
import { ALWAYS_ON_REPORT_TOOL_NAME } from "../../src/always-on/tool/AlwaysOnReportTool.js";
import { ALWAYS_ON_WORKSPACE_TOOL_NAME } from "../../src/always-on/tool/AlwaysOnWorkspaceTool.js";

test("buildDiscoveryPrompt includes project root and plan tool name, excludes workspace fields", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-1",
    createdAt: "2026-05-10T12:00:00Z",
    chatDir: "/chats/foo",
  });
  assert.ok(prompt.includes("/projects/foo"));
  assert.ok(prompt.includes(ALWAYS_ON_PLAN_TOOL_NAME));
  assert.ok(prompt.includes("bypassPermissions"));
  assert.ok(prompt.includes("run-1"));
  assert.ok(!prompt.includes("Isolated workspace cwd:"));
  assert.ok(!prompt.includes("Workspace strategy:"));
});

test("buildWorkspacePrompt includes project root and workspace tool name", () => {
  const prompt = buildWorkspacePrompt({
    projectRoot: "/projects/foo",
    runId: "run-1",
  });
  assert.ok(prompt.includes("/projects/foo"));
  assert.ok(prompt.includes(ALWAYS_ON_WORKSPACE_TOOL_NAME));
  assert.ok(prompt.includes("git-worktree"));
  assert.ok(prompt.includes("snapshot-copy"));
  assert.ok(!prompt.includes("previous run"));
});

test("buildWorkspacePrompt includes existing workspace info when provided", () => {
  const prompt = buildWorkspacePrompt({
    projectRoot: "/projects/foo",
    runId: "run-2",
    currentWorkspace: {
      runId: "run-1",
      strategy: "git-worktree",
      cwd: "/worktrees/foo/run-1",
      metadata: {},
    },
  });
  assert.ok(prompt.includes("/worktrees/foo/run-1"));
  assert.ok(prompt.includes("previous run"));
  assert.ok(prompt.includes("git-worktree"));
});

test("buildExecutionPrompt includes plan and workspace, excludes report tool instructions", () => {
  const prompt = buildExecutionPrompt({
    plan: {
      id: "plan_run-1",
      title: "Test Plan",
      createdAt: "2026-05-10T12:00:00Z",
      status: "executing",
      summary: "A test plan",
      rationale: "Because",
      dedupeKey: "test",
      sourceRunId: "run-1",
      planFilePath: "/plans/plan.md",
    },
    planMarkdown: "# Test Plan\n\n## Summary\nA test plan",
    workspaceCwd: "/worktrees/foo/run-1",
    workspaceStrategy: "git-worktree",
  });
  assert.ok(prompt.includes("/worktrees/foo/run-1"));
  assert.ok(prompt.includes("git-worktree"));
  assert.ok(prompt.includes("Test Plan"));
  assert.ok(!prompt.includes(ALWAYS_ON_REPORT_TOOL_NAME));
});

test("buildReportPrompt includes plan, workspace, and report tool name", () => {
  const prompt = buildReportPrompt({
    plan: {
      id: "plan_run-1",
      title: "Test Plan",
      createdAt: "2026-05-10T12:00:00Z",
      status: "completed",
      summary: "A test plan",
      rationale: "Because",
      dedupeKey: "test",
      sourceRunId: "run-1",
      planFilePath: "/plans/plan.md",
    },
    planMarkdown: "# Test Plan\n\n## Summary\nA test plan",
    workspaceCwd: "/worktrees/foo/run-1",
    workspaceStrategy: "git-worktree",
  });
  assert.ok(prompt.includes("/worktrees/foo/run-1"));
  assert.ok(prompt.includes(ALWAYS_ON_REPORT_TOOL_NAME));
  assert.ok(prompt.includes("Test Plan"));
  assert.ok(prompt.includes("git diff --stat"));
});
