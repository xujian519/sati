import assert from "node:assert/strict";
import test from "node:test";
import {
  parseReportMarkdown,
  REPORT_REQUIRED_SECTIONS,
  buildFallbackReport,
  type ReportMetadata,
} from "../../src/always-on/contracts/ReportContract.js";

const METADATA: ReportMetadata = {
  runId: "run_001",
  planId: "plan_001",
  startedAt: "2026-05-08T12:00:00Z",
  finishedAt: "2026-05-08T12:30:00Z",
  outcome: "executed",
  workspaceStrategy: "git-worktree",
  workspaceHandle: "/tmp/wt/run_001",
};

test("parseReportMarkdown accepts a fully compliant report without fallbacks", () => {
  const body = [
    "# Improve build cache - Work Report",
    "",
    "> Always-On Discovery Run Report",
    "> runId: run_001",
    "> planId: plan_001",
    "> startedAt: 2026-05-08T12:00:00Z",
    "> finishedAt: 2026-05-08T12:30:00Z",
    "> outcome: executed",
    "> workspaceStrategy: git-worktree",
    "> workspaceHandle: /tmp/wt/run_001",
    "",
    "## Plan Reference",
    "plans/plan_001.md",
    "",
    "## Steps Performed",
    "1. updated workflow",
    "",
    "## Files Changed",
    "- .github/workflows/ci.yml (modified)",
    "",
    "## Command Output",
    "(omitted)",
    "",
    "## Verification Results",
    "- [x] cache restored",
    "",
    "## Follow-ups",
    "- watch CI duration trend",
    "",
    "## Notes",
    "(none)",
    "",
  ].join("\n");

  const parsed = parseReportMarkdown(body, METADATA);
  assert.deepEqual(parsed.fallbacks, []);
  for (const section of REPORT_REQUIRED_SECTIONS) {
    assert.ok(parsed.sections[section], `expected section ${section}`);
  }
});

test("parseReportMarkdown fills missing sections via fallback and records reasons", () => {
  const body = [
    "# Plan - Work Report",
    "",
    "> Always-On Discovery Run Report",
    "",
    "## Plan Reference",
    "plans/plan_001.md",
    "",
    "## Steps Performed",
    "1. did stuff",
    "",
  ].join("\n");

  const parsed = parseReportMarkdown(body, METADATA);
  assert.ok(parsed.fallbacks.length > 0);
  for (const section of REPORT_REQUIRED_SECTIONS) {
    assert.ok(parsed.sections[section] !== undefined, `expected fallback for ${section}`);
  }
  assert.ok(parsed.sections.Notes.includes("fallback:"));
});

test("buildFallbackReport produces a parseable placeholder report", () => {
  const placeholder = buildFallbackReport({
    metadata: { ...METADATA, outcome: "failed" },
    title: "Improve build cache",
    reason: "report_tool_not_invoked",
  });
  const parsed = parseReportMarkdown(placeholder, METADATA);
  assert.deepEqual(parsed.fallbacks, []);
  assert.ok(parsed.sections.Notes.includes("report_tool_not_invoked"));
});
