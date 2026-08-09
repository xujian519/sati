import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFallbackReport,
  parseReportMarkdown,
  rebuildReport,
  REPORT_METADATA_FIRST_LINE,
  REPORT_REQUIRED_SECTIONS,
  type ReportMetadata,
} from "../../../src/always-on/contracts/ReportContract.js";

function makeMetadata(overrides: Partial<ReportMetadata> = {}): ReportMetadata {
  return {
    runId: "run-1",
    planId: "plan-1",
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: "2026-08-03T00:30:00.000Z",
    outcome: "executed",
    workspaceStrategy: "git-worktree",
    workspaceHandle: "/tmp/demo",
    ...overrides,
  };
}

function validReport(): string {
  return [
    "# Fix slow startup",
    "",
    "> Always-On Discovery Run Report",
    "> runId: run-1",
    "> planId: plan-1",
    "> startedAt: 2026-08-03T00:00:00.000Z",
    "> finishedAt: 2026-08-03T00:30:00.000Z",
    "> outcome: executed",
    "> workspaceStrategy: git-worktree",
    "> workspaceHandle: /tmp/demo",
    "",
    "## Plan Reference",
    "- ref plan-1",
    "",
    "## Steps Performed",
    "1. step one",
    "",
    "## Files Changed",
    "- src/a.ts",
    "",
    "## Command Output",
    "no output",
    "",
    "## Verification Results",
    "- [x] tests pass",
    "",
    "## Follow-ups",
    "- none",
    "",
    "## Notes",
    "- original note",
    "",
  ].join("\n");
}

describe("parseReportMarkdown", () => {
  it("解析合法 report：title / sections / fallbacks 全部正确", () => {
    const metadata = makeMetadata();
    const result = parseReportMarkdown(validReport(), metadata);

    assert.equal(result.title, "Fix slow startup");
    assert.equal(result.metadata, metadata);
    assert.deepEqual(result.fallbacks, []);
    assert.equal(result.sections["Plan Reference"], "- ref plan-1");
    assert.equal(result.sections["Steps Performed"], "1. step one");
    assert.equal(result.sections["Files Changed"], "- src/a.ts");
    assert.equal(result.sections["Command Output"], "no output");
    assert.equal(result.sections["Verification Results"], "- [x] tests pass");
    assert.equal(result.sections["Follow-ups"], "- none");
    assert.equal(result.sections.Notes, "- original note");
    assert.deepEqual(
      Object.keys(result.sections).filter(section => !REPORT_REQUIRED_SECTIONS.includes(section)),
      [],
    );
  });

  it("缺少一级标题 → title-missing，标题回落为默认值", () => {
    const content = validReport().replace("# Fix slow startup", "Fix slow startup");
    const result = parseReportMarkdown(content, makeMetadata());

    assert.equal(result.title, "Always-On Discovery Run");
    assert.deepEqual(result.fallbacks, ["title-missing"]);
    // 回落注释写入 Notes
    assert.ok(result.sections.Notes.includes("- fallback: title-missing"));
  });

  it("一级标题恰为必填章节名 → 视为章节而非标题（h1-downgraded + title-missing）", () => {
    const content = [
      "# Notes",
      "",
      "> Always-On Discovery Run Report",
      "> runId: run-1",
      "",
      "## Plan Reference",
      "- ref",
      "",
      "## Steps Performed",
      "steps",
      "",
      "## Files Changed",
      "files",
      "",
      "## Command Output",
      "output",
      "",
      "## Verification Results",
      "ok",
      "",
      "## Follow-ups",
      "- none",
      "",
    ].join("\n");
    const result = parseReportMarkdown(content, makeMetadata());

    assert.equal(result.title, "Always-On Discovery Run");
    assert.ok(result.fallbacks.includes("title-missing"));
    assert.ok(result.fallbacks.includes("h1-downgraded(Notes)"));
    // "# Notes" 的内容进入 Notes 章节
    assert.ok(result.sections.Notes.includes("- fallback: title-missing"));
  });

  it("正文中出现一级必填章节名 → 降级为章节并记录 h1-downgraded", () => {
    const content = validReport().replace("## Files Changed", "# Files Changed");
    const result = parseReportMarkdown(content, makeMetadata());

    assert.equal(result.title, "Fix slow startup");
    assert.deepEqual(result.fallbacks, ["h1-downgraded(Files Changed)"]);
    assert.equal(result.sections["Files Changed"], "- src/a.ts");
  });

  it("缺少章节 → 填充占位符并记录 section-missing", () => {
    const content = validReport()
      .replace("## Follow-ups\n- none\n\n", "")
      .replace("## Command Output\nno output\n\n", "");
    const result = parseReportMarkdown(content, makeMetadata());

    assert.equal(result.sections["Follow-ups"], "(empty)");
    assert.equal(result.sections["Command Output"], "(empty)");
    assert.ok(result.fallbacks.includes("section-missing(Follow-ups)"));
    assert.ok(result.fallbacks.includes("section-missing(Command Output)"));
    // 缺失的 Notes 使用专用占位文案
    const noNotes = validReport().replace("## Notes\n- original note\n", "");
    const notesResult = parseReportMarkdown(noNotes, makeMetadata());
    assert.equal(notesResult.sections.Notes, "- fallback: section-missing(Notes)");
  });

  it("fallback 条目写入 Notes 且去重（已有同名条目不重复追加）", () => {
    // 同时删除 Follow-ups 章节以触发 section-missing，并在 Notes 中预置同名条目
    const content = validReport()
      .replace("## Follow-ups\n- none\n\n", "")
      .replace("## Notes\n- original note\n", "## Notes\n- original note\n- fallback: section-missing(Follow-ups)\n");
    const result = parseReportMarkdown(content, makeMetadata());

    assert.ok(result.fallbacks.includes("section-missing(Follow-ups)"));
    const notesLines = result.sections.Notes.split("\n");
    assert.equal(
      notesLines.filter(line => line === "- fallback: section-missing(Follow-ups)").length,
      1,
      "Notes 中同一条 fallback 只出现一次",
    );
  });

  it("空内容 → 全部 fallback：title-missing + 7 个 section-missing", () => {
    const result = parseReportMarkdown("", makeMetadata());

    assert.equal(result.title, "Always-On Discovery Run");
    assert.deepEqual(result.fallbacks, [
      "title-missing",
      ...REPORT_REQUIRED_SECTIONS.map(section => `section-missing(${section})`),
    ]);
    const notesLines = result.sections.Notes.split("\n");
    assert.equal(notesLines.length, REPORT_REQUIRED_SECTIONS.length + 1);
    assert.ok(notesLines.includes("- fallback: section-missing(Notes)"));
    assert.ok(notesLines.includes("- fallback: title-missing"));
  });

  it("章节顺序无关（与 PlanContract 的严格顺序相对，本契约宽容）", () => {
    const content = [
      "# Fix slow startup",
      "",
      "> Always-On Discovery Run Report",
      "> runId: run-1",
      "",
      "## Notes",
      "- note first",
      "",
      "## Plan Reference",
      "- ref",
      "",
      "## Verification Results",
      "ok",
      "",
      "## Steps Performed",
      "steps",
      "",
      "## Files Changed",
      "files",
      "",
      "## Command Output",
      "output",
      "",
      "## Follow-ups",
      "- none",
      "",
    ].join("\n");
    const result = parseReportMarkdown(content, makeMetadata());

    assert.deepEqual(result.fallbacks, []);
    assert.equal(result.sections.Notes, "- note first");
    assert.equal(result.sections["Plan Reference"], "- ref");
  });

  it("非必填章节保留在 sections 与 rawContent 末尾", () => {
    const content = validReport().replace(
      "## Notes\n- original note\n",
      "## Notes\n- original note\n\n## Extra\n- extra info\n",
    );
    const result = parseReportMarkdown(content, makeMetadata());

    assert.equal(result.sections.Extra, "- extra info");
    const extraIndex = result.rawContent.indexOf("## Extra");
    const notesIndex = result.rawContent.indexOf("## Notes");
    assert.ok(extraIndex > notesIndex, "非必填章节追加在必填章节之后");
  });

  it("章节内容尾部空白被裁剪", () => {
    const content = validReport().replace("- original note\n", "- original note\n\n\n");
    const result = parseReportMarkdown(content, makeMetadata());
    assert.equal(result.sections.Notes, "- original note");
  });

  it("CRLF 换行被归一化，rawContent 不残留 \\r", () => {
    const content = validReport().replace(/\n/g, "\r\n");
    const result = parseReportMarkdown(content, makeMetadata());

    assert.equal(result.title, "Fix slow startup");
    assert.deepEqual(result.fallbacks, []);
    assert.ok(!result.rawContent.includes("\r"));
  });

  it("rawContent 与 rebuildReport 输出一致，且可被再次解析（round-trip）", () => {
    const metadata = makeMetadata();
    const result = parseReportMarkdown(validReport(), metadata);

    assert.equal(result.rawContent, rebuildReport(result.title, metadata, result.sections));

    const again = parseReportMarkdown(result.rawContent, metadata);
    assert.equal(again.title, result.title);
    assert.deepEqual(again.fallbacks, []);
    assert.deepEqual(again.sections, result.sections);
  });
});

describe("buildFallbackReport", () => {
  const metadata = makeMetadata();

  it("生成完整结构：标题、元数据块、全部必填章节、Notes 含 fallback 原因", () => {
    const report = buildFallbackReport({ metadata, title: "Fix slow startup", reason: "report_tool_not_invoked" });

    assert.ok(report.startsWith("# Fix slow startup - Work Report\n"));
    assert.ok(report.includes(`> ${REPORT_METADATA_FIRST_LINE}`));
    assert.ok(report.includes("> runId: run-1"));
    assert.ok(report.includes("> outcome: executed"));
    for (const section of REPORT_REQUIRED_SECTIONS) {
      assert.ok(report.includes(`## ${section}`), `缺少章节 ${section}`);
    }
    assert.ok(report.includes("- fallback: report_tool_not_invoked"));

    // 产物可被标准解析器解析且无新 fallback
    const parsed = parseReportMarkdown(report, metadata);
    assert.equal(parsed.title, "Fix slow startup - Work Report");
    assert.deepEqual(parsed.fallbacks, []);
  });

  it("提供 partial 时追加 ## Partial Tool Payload（内容 trim）", () => {
    const report = buildFallbackReport({
      metadata,
      title: "T",
      reason: "execution_failed",
      partial: "  partial payload with whitespace  ",
    });
    assert.ok(report.includes("## Partial Tool Payload"));
    assert.ok(report.includes("partial payload with whitespace"));
    assert.ok(!report.includes("## Partial Tool Payload\n  partial"));
  });

  it("partial 为空白或不提供时不追加 Partial 章节", () => {
    const withBlank = buildFallbackReport({ metadata, title: "T", reason: "r", partial: "   " });
    const without = buildFallbackReport({ metadata, title: "T", reason: "r" });
    assert.ok(!withBlank.includes("## Partial Tool Payload"));
    assert.ok(!without.includes("## Partial Tool Payload"));
  });

  it("fallback 报告可被再次解析，所有章节占位齐全", () => {
    const report = buildFallbackReport({ metadata, title: "T", reason: "report_tool_not_invoked" });
    const parsed = parseReportMarkdown(report, metadata);
    for (const section of REPORT_REQUIRED_SECTIONS) {
      assert.ok(parsed.sections[section] !== undefined);
    }
  });
});

describe("rebuildReport", () => {
  it("拼接标题 + 元数据 + 必填章节，缺失章节以 (empty) 补齐", () => {
    const metadata = makeMetadata();
    const report = rebuildReport("My Title", metadata, { "Plan Reference": "ref-here" });

    assert.ok(report.startsWith("# My Title\n"));
    assert.ok(report.includes(`> ${REPORT_METADATA_FIRST_LINE}`));
    assert.ok(report.includes("## Plan Reference\nref-here"));
    assert.ok(report.includes("## Notes\n(empty)"));
    assert.ok(report.includes("## Follow-ups\n(empty)"));
  });

  it("非必填章节追加在必填章节之后", () => {
    const report = rebuildReport("T", makeMetadata(), { Extra: "x", "Plan Reference": "ref" });
    assert.ok(report.indexOf("## Extra") > report.indexOf("## Plan Reference"));
    assert.ok(report.includes("## Extra\nx"));
  });

  it("REPORT_REQUIRED_SECTIONS 固定为 7 个章节且顺序稳定", () => {
    assert.deepEqual(
      [...REPORT_REQUIRED_SECTIONS],
      [
        "Plan Reference",
        "Steps Performed",
        "Files Changed",
        "Command Output",
        "Verification Results",
        "Follow-ups",
        "Notes",
      ],
    );
    assert.equal(REPORT_METADATA_FIRST_LINE, "Always-On Discovery Run Report");
  });
});
