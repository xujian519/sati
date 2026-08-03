import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlwaysOnError } from "../../../src/always-on/protocol/errors.js";
import { parsePlanMarkdown, PLAN_REQUIRED_SECTIONS } from "../../../src/always-on/contracts/PlanContract.js";

const VALID_METADATA = [
  "> Always-On Discovery Plan",
  "> id: plan-1",
  "> sourceRunId: run-1",
  "> createdAt: 2026-08-03T00:00:00Z",
  "> projectRoot: /tmp/demo",
  "> dedupeKey: dedupe-1",
].join("\n");

function validPlan(): string {
  return [
    "# Fix slow startup",
    "",
    VALID_METADATA,
    "",
    "## Summary",
    "Short summary here.",
    "",
    "## Rationale",
    "Because the agent startup path does redundant work.",
    "",
    "## Context Signals",
    "- user reported slow startup",
    "",
    "## Proposed Change",
    "Cache resolved tools between turns.",
    "",
    "## Execution Steps",
    "1. Add a cache map",
    "2. Wire it in the runtime",
    "",
    "## Verification",
    "- Startup latency drops below threshold",
    "",
  ].join("\n");
}

describe("parsePlanMarkdown", () => {
  it("解析合法 plan 并提取 title / metadata / sections", () => {
    const result = parsePlanMarkdown(validPlan());
    assert.equal(result.title, "Fix slow startup");
    assert.equal(result.metadata.id, "plan-1");
    assert.equal(result.metadata.projectRoot, "/tmp/demo");
    assert.equal(result.sections.Summary.join(""), "Short summary here.");
    assert.equal(result.sections["Execution Steps"].filter(line => line.trim().length > 0).length, 2);
    assert.deepEqual(Object.keys(result.sections), [...PLAN_REQUIRED_SECTIONS]);
  });

  it("空内容抛出 plan_invalid", () => {
    assert.throws(
      () => parsePlanMarkdown(""),
      (error: unknown) => {
        assert.ok(error instanceof AlwaysOnError);
        assert.equal(error.code, "plan_invalid");
        return true;
      },
    );
  });

  it("非字符串内容抛出 plan_invalid", () => {
    assert.throws(() => parsePlanMarkdown(42 as unknown as string), /plan content must be a string/);
  });

  it("缺少一级标题抛出 plan_invalid", () => {
    const content = validPlan().replace("# Fix slow startup", "Fix slow startup");
    assert.throws(() => parsePlanMarkdown(content), /level-1 markdown heading/);
  });

  it("缺少 metadata blockquote 抛出 plan_invalid", () => {
    const content = validPlan().replace(VALID_METADATA, "");
    assert.throws(() => parsePlanMarkdown(content), /metadata blockquote/);
  });

  it("metadata 缺必填 key 抛出 plan_invalid", () => {
    const content = validPlan().replace("> id: plan-1", "> id:");
    assert.throws(() => parsePlanMarkdown(content), /missing required key "id"/);
  });

  it("缺章节或章节顺序错误抛出 plan_invalid", () => {
    const reordered = validPlan().replace("## Verification", "## Extra");
    assert.throws(() => parsePlanMarkdown(reordered), /must be "Verification"/);
  });

  it("Summary 超过长度上限抛出 plan_invalid", () => {
    const content = validPlan().replace("Short summary here.", "x".repeat(201));
    assert.throws(() => parsePlanMarkdown(content), /Summary exceeds 200 characters/);
  });

  it("Context Signals 缺少列表项抛出 plan_invalid", () => {
    const content = validPlan().replace("- user reported slow startup", "plain text, not a list item");
    assert.throws(() => parsePlanMarkdown(content), /Context Signals must contain/);
  });

  it("Proposed Change 含模糊 TODO 措辞抛出 plan_invalid", () => {
    const content = validPlan().replace("Cache resolved tools between turns.", "TODO: cache resolved tools");
    assert.throws(() => parsePlanMarkdown(content), /TODO|fuzzy|Proposed Change/i);
  });

  it("Execution Steps 缺少有序列表项抛出 plan_invalid", () => {
    const content = validPlan().replace("1. Add a cache map\n2. Wire it in the runtime", "- not ordered");
    assert.throws(() => parsePlanMarkdown(content));
  });

  it("自定义 fuzzyTodoPatterns 生效", () => {
    const content = validPlan().replace("Cache resolved tools between turns.", "WIP: cache resolved tools");
    assert.throws(() => parsePlanMarkdown(content, { fuzzyTodoPatterns: [/^\s*WIP\b/i] }), /Proposed Change|WIP/i);
  });

  it("Windows 换行与不换行空格被归一化", () => {
    const content = validPlan().replace(/\n/g, "\r\n").replace(/ /g, "\u00a0");
    const result = parsePlanMarkdown(content);
    // 解析器将 NBSP 归一化为普通空格、CRLF 归一化为 LF。
    assert.equal(result.title, "Fix slow startup");
    assert.equal(result.rawContent.includes("\u00a0"), false);
    assert.equal(result.rawContent.includes("\r"), false);
  });
});
