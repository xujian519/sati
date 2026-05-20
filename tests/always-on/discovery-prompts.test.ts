import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiscoveryPrompt,
  buildExecutionPrompt,
  buildWorkspacePrompt,
  buildReportPrompt,
  buildApplyPrompt,
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

test("buildDiscoveryPrompt uses workspace cwd when workspace is provided", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-2",
    createdAt: "2026-05-10T12:00:00Z",
    chatDir: "/chats/foo",
    workspace: { cwd: "/worktrees/foo/run-1", strategy: "git-worktree" },
  });
  assert.ok(prompt.includes("/worktrees/foo/run-1"));
  assert.ok(prompt.includes("git-worktree"));
  assert.ok(prompt.includes("isolated snapshot"));
  assert.ok(prompt.includes("Do NOT cd outside"));
  assert.ok(!prompt.includes("Read the project root at"));
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

// ---- buildApplyPrompt -------------------------------------------------------

test("buildApplyPrompt uses git apply --3way strategy for git-worktree", () => {
  const prompt = buildApplyPrompt({
    plan: { id: "plan-1", title: "Test", workspace: { cwd: "/ws/foo", strategy: "git-worktree" } },
    projectName: "foo",
    projectRoot: "/projects/foo",
    diff: { diff: "diff --git a/f.txt b/f.txt\n", fileCount: 1, truncated: false },
  });
  assert.ok(prompt.includes("git worktree"));
  assert.ok(prompt.includes("git apply --3way"));
  assert.ok(prompt.includes("git -C <workspace> add -A"));
  assert.ok(!prompt.includes("snapshot copy"));
});

test("buildApplyPrompt uses Edit/Write strategy for snapshot-copy", () => {
  const prompt = buildApplyPrompt({
    plan: { id: "plan-1", title: "Test", workspace: { cwd: "/ws/foo", strategy: "snapshot-copy" } },
    projectName: "foo",
    projectRoot: "/projects/foo",
    diff: { diff: "diff -ruN a/f.txt b/f.txt\n", fileCount: 1, truncated: false },
  });
  assert.ok(prompt.includes("snapshot copy"));
  assert.ok(prompt.includes("Edit or Write tools"));
  assert.ok(!prompt.includes("git apply"));
});

test("buildApplyPrompt handles empty diff", () => {
  const prompt = buildApplyPrompt({
    plan: { id: "plan-1", title: "Test", workspace: { cwd: "/ws/foo", strategy: "git-worktree" } },
    projectName: "foo",
    projectRoot: "/projects/foo",
    diff: { diff: "", fileCount: 0, truncated: false },
  });
  assert.ok(prompt.includes("Nothing to apply"));
});

test("buildApplyPrompt includes fallback to manual apply when git fails", () => {
  const prompt = buildApplyPrompt({
    plan: { id: "plan-1", title: "Test", workspace: { cwd: "/ws/foo", strategy: "git-worktree" } },
    projectName: "foo",
    projectRoot: "/projects/foo",
    diff: { diff: "some diff content\n", fileCount: 1, truncated: false },
  });
  assert.ok(prompt.includes("fall back"));
  assert.ok(prompt.includes("Edit or Write tools"));
});
