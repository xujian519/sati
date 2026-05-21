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
import { ALWAYS_ON_CHAT_HISTORY_TOOL_NAME } from "../../src/always-on/tool/AlwaysOnChatHistoryTool.js";
import type { ChatDigest } from "../../src/always-on/context/ChatDigestBuilder.js";

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

// ---- chat digest + existing plans in discovery prompt -----------------------

const sampleDigest: ChatDigest = {
  generatedAt: "2026-05-20T12:00:00.000Z",
  sessions: [
    {
      sessionId: "web:s_abc123",
      alias: "chat_1",
      title: "丰富鸣人信息",
      lastModified: "2026-05-20T11:26:00.000Z",
      userPrompts: ["请丰富现有模块的信息", "重新整理布局"],
    },
    {
      sessionId: "web:s_def456",
      alias: "chat_2",
      title: "杀生丸页面",
      lastModified: "2026-05-20T10:00:00.000Z",
      userPrompts: ["我想做一个 HTML 网页"],
    },
  ],
  aliasMap: new Map([
    ["chat_1", "web:s_abc123"],
    ["chat_2", "web:s_def456"],
  ]),
};

test("buildDiscoveryPrompt renders chat digest sessions with aliases", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-3",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
    chatDigest: sampleDigest,
  });
  assert.ok(prompt.includes("## Recent user conversations"));
  assert.ok(prompt.includes(ALWAYS_ON_CHAT_HISTORY_TOOL_NAME));
  assert.ok(prompt.includes("chat_1"));
  assert.ok(prompt.includes("chat_2"));
  assert.ok(!prompt.includes("web:s_abc123"), "raw sessionId should not appear in prompt");
  assert.ok(!prompt.includes("web:s_def456"), "raw sessionId should not appear in prompt");
  assert.ok(prompt.includes("丰富鸣人信息"));
  assert.ok(prompt.includes("请丰富现有模块的信息"));
  assert.ok(prompt.includes("杀生丸页面"));
});

test("buildDiscoveryPrompt renders existing plans section", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-4",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
    existingPlans: [
      { id: "plan_1", title: "Fix wheel leak", dedupeKey: "wheel-fix", status: "completed" },
      { id: "plan_2", title: "Add navigation", dedupeKey: "keyboard-nav", status: "executing" },
    ],
  });
  assert.ok(prompt.includes("## Existing Always-On plans"));
  assert.ok(prompt.includes("do NOT duplicate"));
  assert.ok(prompt.includes("[completed] \"Fix wheel leak\""));
  assert.ok(prompt.includes("dedupeKey: wheel-fix"));
  assert.ok(prompt.includes("[executing] \"Add navigation\""));
});

test("buildDiscoveryPrompt shows fallback when no chat digest", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-5",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
  });
  assert.ok(prompt.includes("No recent user conversations found"));
  assert.ok(!prompt.includes("## Recent user conversations"));
});

test("buildDiscoveryPrompt omits existing plans section when empty", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-6",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
    existingPlans: [],
  });
  assert.ok(!prompt.includes("## Existing Always-On plans"));
});

test("buildDiscoveryPrompt includes neutral Goal wording without code bias", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-7",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
  });
  assert.ok(prompt.includes("worthwhile task"));
  assert.ok(prompt.includes("enriching or adding content"));
  assert.ok(prompt.includes("completing unfinished work"));
  assert.ok(prompt.includes("automatically-checkable verification step"));
  assert.ok(!prompt.includes("bug fixes and code quality"));
  assert.ok(!prompt.includes("code-level"));
});

test("buildDiscoveryPrompt header includes workspace path when workspace exists", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-8",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
    workspace: { cwd: "/worktrees/foo/run-1", strategy: "git-worktree" },
  });
  assert.ok(prompt.includes("working inside isolated workspace: /worktrees/foo/run-1"));
  assert.ok(prompt.includes("/projects/foo"));
});

// ---- zh-CN language tests ---------------------------------------------------

test("buildDiscoveryPrompt zh-CN renders Chinese prompt with correct structure", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-zh-1",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
    language: "zh-CN",
  });
  assert.ok(prompt.includes("自主 Always-On 发现任务"));
  assert.ok(prompt.includes("/projects/foo"));
  assert.ok(prompt.includes("最多提出一个有价值的任务"));
  assert.ok(prompt.includes(ALWAYS_ON_PLAN_TOOL_NAME));
  assert.ok(prompt.includes("bypassPermissions"));
  assert.ok(prompt.includes("run-zh-1"));
  assert.ok(!prompt.includes("You are running"));
});

test("buildDiscoveryPrompt zh-CN with workspace shows Chinese isolation description", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-zh-2",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
    workspace: { cwd: "/worktrees/foo/run-1", strategy: "git-worktree" },
    language: "zh-CN",
  });
  assert.ok(prompt.includes("隔离工作区中"));
  assert.ok(prompt.includes("/worktrees/foo/run-1"));
  assert.ok(prompt.includes("隔离快照"));
  assert.ok(prompt.includes("请勿 cd"));
});

test("buildDiscoveryPrompt zh-CN renders chat digest in Chinese", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-zh-3",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
    chatDigest: sampleDigest,
    language: "zh-CN",
  });
  assert.ok(prompt.includes("## 近期用户对话"));
  assert.ok(prompt.includes(ALWAYS_ON_CHAT_HISTORY_TOOL_NAME));
  assert.ok(prompt.includes("chat_1"));
  assert.ok(prompt.includes("丰富鸣人信息"));
});

test("buildDiscoveryPrompt zh-CN renders existing plans in Chinese", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-zh-4",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
    existingPlans: [
      { id: "plan_1", title: "Fix wheel leak", dedupeKey: "wheel-fix", status: "completed" },
    ],
    language: "zh-CN",
  });
  assert.ok(prompt.includes("## 已有 Always-On 计划"));
  assert.ok(prompt.includes("请勿重复"));
  assert.ok(prompt.includes("[completed] \"Fix wheel leak\""));
});

test("buildDiscoveryPrompt zh-CN shows Chinese fallback when no digest", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-zh-5",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
    language: "zh-CN",
  });
  assert.ok(prompt.includes("未找到近期用户对话"));
});

test("buildWorkspacePrompt zh-CN renders Chinese workspace prompt", () => {
  const prompt = buildWorkspacePrompt({
    projectRoot: "/projects/foo",
    runId: "run-zh-1",
    language: "zh-CN",
  });
  assert.ok(prompt.includes("准备一个隔离工作区"));
  assert.ok(prompt.includes("/projects/foo"));
  assert.ok(prompt.includes(ALWAYS_ON_WORKSPACE_TOOL_NAME));
  assert.ok(prompt.includes("git-worktree"));
  assert.ok(prompt.includes("snapshot-copy"));
  assert.ok(!prompt.includes("You are preparing"));
});

test("buildWorkspacePrompt zh-CN includes existing workspace info in Chinese", () => {
  const prompt = buildWorkspacePrompt({
    projectRoot: "/projects/foo",
    runId: "run-zh-2",
    currentWorkspace: {
      runId: "run-1",
      strategy: "git-worktree",
      cwd: "/worktrees/foo/run-1",
      metadata: {},
    },
    language: "zh-CN",
  });
  assert.ok(prompt.includes("上一次运行遗留的工作区"));
  assert.ok(prompt.includes("/worktrees/foo/run-1"));
});

test("buildExecutionPrompt zh-CN renders Chinese execution prompt", () => {
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
    language: "zh-CN",
  });
  assert.ok(prompt.includes("隔离工作区内执行"));
  assert.ok(prompt.includes("/worktrees/foo/run-1"));
  assert.ok(prompt.includes("Test Plan"));
  assert.ok(prompt.includes("按顺序执行"));
  assert.ok(!prompt.includes(ALWAYS_ON_REPORT_TOOL_NAME));
  assert.ok(!prompt.includes("You are executing"));
});

test("buildReportPrompt zh-CN renders Chinese report prompt", () => {
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
    language: "zh-CN",
  });
  assert.ok(prompt.includes("撰写工作报告"));
  assert.ok(prompt.includes(ALWAYS_ON_REPORT_TOOL_NAME));
  assert.ok(prompt.includes("Test Plan"));
  assert.ok(prompt.includes("git diff --stat"));
  assert.ok(!prompt.includes("You are writing"));
});

test("buildApplyPrompt zh-CN uses Chinese git worktree strategy", () => {
  const prompt = buildApplyPrompt({
    plan: { id: "plan-1", title: "Test", workspace: { cwd: "/ws/foo", strategy: "git-worktree" } },
    projectName: "foo",
    projectRoot: "/projects/foo",
    diff: { diff: "diff --git a/f.txt b/f.txt\n", fileCount: 1, truncated: false },
    language: "zh-CN",
  });
  assert.ok(prompt.includes("应用变更到项目"));
  assert.ok(prompt.includes("git worktree"));
  assert.ok(prompt.includes("git apply --3way"));
  assert.ok(!prompt.includes("Your job is to merge"));
});

test("buildApplyPrompt zh-CN uses Chinese snapshot-copy strategy", () => {
  const prompt = buildApplyPrompt({
    plan: { id: "plan-1", title: "Test", workspace: { cwd: "/ws/foo", strategy: "snapshot-copy" } },
    projectName: "foo",
    projectRoot: "/projects/foo",
    diff: { diff: "diff content\n", fileCount: 1, truncated: false },
    language: "zh-CN",
  });
  assert.ok(prompt.includes("snapshot copy"));
  assert.ok(prompt.includes("Edit 或 Write 工具"));
  assert.ok(!prompt.includes("git apply"));
});

test("buildApplyPrompt zh-CN handles empty diff in Chinese", () => {
  const prompt = buildApplyPrompt({
    plan: { id: "plan-1", title: "Test", workspace: { cwd: "/ws/foo", strategy: "git-worktree" } },
    projectName: "foo",
    projectRoot: "/projects/foo",
    diff: { diff: "", fileCount: 0, truncated: false },
    language: "zh-CN",
  });
  assert.ok(prompt.includes("无需应用任何变更"));
});

test("buildDiscoveryPrompt defaults to English when language is undefined", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-default",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
  });
  assert.ok(prompt.includes("You are running"));
  assert.ok(!prompt.includes("自主 Always-On 发现任务"));
});

test("buildDiscoveryPrompt defaults to English when language is 'en'", () => {
  const prompt = buildDiscoveryPrompt({
    projectRoot: "/projects/foo",
    runId: "run-en",
    createdAt: "2026-05-20T12:00:00Z",
    chatDir: "/chats/foo",
    language: "en",
  });
  assert.ok(prompt.includes("You are running"));
  assert.ok(!prompt.includes("自主 Always-On 发现任务"));
});
