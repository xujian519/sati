// file-memory 子模块行为基线测试（file-text/markdown/manifest/constants 拆自 file-memory.ts，逐字搬移）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeDescription,
  parseBoolean,
  parseInteger,
  parseStringArray,
  previewContent,
  slugify,
  trimContentLines,
  uniqueStrings,
} from "../src/core/file-text.js";
import {
  buildFeedbackBody,
  buildFrontmatter,
  buildProjectBody,
  buildRecordBody,
  buildUserBody,
  candidateDescription,
  parseFactSection,
  parseFrontmatterBlock,
  parseMarkdownSections,
  renderFrontmatter,
} from "../src/core/file-markdown.js";
import { CURRENT_PROJECT_ID, DEFAULT_PROJECT_STATUS, TMP_PROJECT_ID } from "../src/core/file-constants.js";
import { mergeCandidates, normalizeProjectStatus, sameOrigin, sortEntries } from "../src/core/file-manifest.js";

describe("file-text 文本工具", () => {
  it("slugify 归一（小写/连字符/中文保留）", () => {
    assert.equal(slugify("  Hello World! "), "hello-world");
    assert.equal(slugify("专利 检索"), "专利-检索");
    assert.equal(slugify("!!!"), "memory-item");
  });
  it("parseStringArray 支持 JSON 数组与 | 分隔", () => {
    assert.deepEqual(parseStringArray('["a", "b"]'), ["a", "b"]);
    assert.deepEqual(parseStringArray("a|b|a"), ["a", "b"]);
    assert.deepEqual(parseStringArray(""), []);
  });
  it("parseBoolean/parseInteger 边界", () => {
    assert.equal(parseBoolean("true"), true);
    assert.equal(parseBoolean("maybe"), undefined);
    assert.equal(parseInteger("42"), 42);
    assert.equal(parseInteger("abc"), undefined);
  });
  it("trimContentLines 截断加省略号", () => {
    assert.equal(trimContentLines("a\nb\nc", 2), "a\nb\n...");
  });
  it("previewContent 去标题折叠", () => {
    assert.equal(previewContent("## T\nbody  text", 20), "T body text");
  });
  it("uniqueStrings 去重 + 上限", () => {
    assert.deepEqual(uniqueStrings(["a", "b", "a", "  c  "], 10), ["a", "b", "c"]);
    assert.deepEqual(uniqueStrings(["a", "b"], 1), ["a"]);
  });
  it("normalizeDescription 兜底 fallback", () => {
    assert.equal(normalizeDescription("  x  "), "x");
    assert.equal(normalizeDescription(undefined, "fb"), "fb");
  });
});

describe("parseFrontmatterBlock / renderFrontmatter", () => {
  const raw =
    "---\nname: Alpha\ndescription: desc\ntype: project\nscope: project\nproject_id: p1\nupdated_at: 2026-01-01\n---\n\n# Body\n";
  it("解析 frontmatter 与 body", () => {
    const parsed = parseFrontmatterBlock(raw);
    assert.equal(parsed?.frontmatter.name, "Alpha");
    assert.equal(parsed?.frontmatter.type, "project");
    assert.equal(parsed?.frontmatter.projectId, "p1");
    assert.ok(parsed?.body.startsWith("# Body"));
  });
  it("无 frontmatter 或类型非法返回 undefined", () => {
    assert.equal(parseFrontmatterBlock("# no frontmatter"), undefined);
    assert.equal(parseFrontmatterBlock("---\ntype: bogus\nscope: project\n---\n"), undefined);
  });
  it("render 往返保留关键字段", () => {
    const rendered = renderFrontmatter({
      name: "N",
      description: "D",
      type: "feedback",
      scope: "project",
      updatedAt: "2026-01-01",
    });
    assert.ok(rendered.includes("type: feedback"));
    assert.ok(rendered.includes("scope: project"));
  });
});

describe("markdown 段解析", () => {
  it("parseMarkdownSections 按 ## 分段（小写 key）", () => {
    const sections = parseMarkdownSections("## Decisions\n- a\n## Notes\nb");
    assert.deepEqual(sections.get("decisions"), ["- a"]);
    assert.deepEqual(sections.get("notes"), ["b"]);
  });
  it("parseFactSection：列表项整条保留、非列表项内联切分", () => {
    // 列表项（- 开头）整条保留；纯文本行才按标点/换行切分。
    assert.deepEqual(parseFactSection(["- 事实一", "- 事实二，子句", "独立事实，补充"]), [
      "事实一",
      "事实二，子句",
      "独立事实",
      "补充",
    ]);
  });
});

describe("body 构建", () => {
  it("buildUserBody 身份背景（空时占位）", () => {
    const body = buildUserBody({ type: "user", name: "U", description: "" } as never);
    assert.ok(body.includes("## 身份背景"));
    assert.ok(body.includes("暂无稳定用户画像信息"));
  });
  it("buildProjectBody 各 section 渲染", () => {
    const body = buildProjectBody({
      type: "project",
      name: "P",
      description: "D",
      stage: "in_progress",
      decisions: ["d1"],
      summary: "s",
    } as never);
    assert.ok(body.includes("## Current Stage"));
    assert.ok(body.includes("## Decisions"));
    assert.ok(body.includes("- d1"));
    assert.ok(body.includes("## Summary"));
  });
  it("buildFeedbackBody Rule/Why/How/Notes", () => {
    const body = buildFeedbackBody({
      type: "feedback",
      name: "F",
      description: "D",
      rule: "R",
      why: "W",
      howToApply: "H",
      notes: ["n1"],
    } as never);
    assert.ok(body.includes("## Rule"));
    assert.ok(body.includes("## Why"));
    assert.ok(body.includes("## How To Apply"));
    assert.ok(body.includes("- n1"));
  });
  it("buildRecordBody 分派：user/feedback/project/general_project_meta", () => {
    assert.ok(buildRecordBody({ type: "user", name: "U", description: "" } as never).includes("身份背景"));
    assert.ok(
      buildRecordBody({ type: "feedback", name: "F", description: "D", rule: "R" } as never).includes("## Rule"),
    );
    assert.ok(
      buildRecordBody({ type: "project", name: "P", description: "D", summary: "s" } as never).includes("## Summary"),
    );
    const general = buildRecordBody({
      type: "general_project_meta",
      name: "G",
      description: "desc",
    } as never);
    assert.ok(general.includes("## Status"));
    assert.ok(general.includes(DEFAULT_PROJECT_STATUS));
  });
});

describe("buildFrontmatter / candidateDescription", () => {
  it("project 候选默认 CURRENT_PROJECT_ID", () => {
    const fm = buildFrontmatter({ type: "project", name: "P", description: "D" } as never);
    assert.equal(fm.scope, "project");
    assert.equal(fm.projectId, CURRENT_PROJECT_ID);
  });
  it("user 候选 scope=global 无 projectId", () => {
    const fm = buildFrontmatter({ type: "user", name: "U", description: "D" } as never);
    assert.equal(fm.scope, "global");
    assert.equal("projectId" in fm, false);
  });
  it("candidateDescription 兜底链", () => {
    assert.equal(candidateDescription({ type: "project", name: "P" } as never), "P");
    assert.equal(candidateDescription({ type: "feedback", name: "F", rule: "R" } as never), "R");
  });
});

describe("mergeCandidates / sameOrigin / sortEntries", () => {
  it("user 合并：preferences/constraints 并集去重", () => {
    const merged = mergeCandidates(
      { type: "user", name: "U", description: "d1", preferences: ["a"] } as never,
      { type: "user", name: "U", description: "d2", preferences: ["b", "a"] } as never,
    );
    assert.deepEqual(merged.preferences, ["a", "b"]);
  });
  it("不同类型不合并（返回 primary）", () => {
    const primary = { type: "project", name: "P" } as never;
    assert.equal(mergeCandidates(primary, { type: "user", name: "U" } as never), primary);
  });
  it("sameOrigin 按 capturedAt+sourceSessionKey+type 判定", () => {
    const record = { capturedAt: "2026-01-01", sourceSessionKey: "sk", type: "project" } as never;
    const candidate = { capturedAt: "2026-01-01", sourceSessionKey: "sk", type: "project" } as never;
    assert.equal(sameOrigin(record, candidate), true);
    assert.equal(sameOrigin(record, { ...candidate, type: "user" } as never), false);
  });
  it("sortEntries updatedAt 降序 + path 升序", () => {
    const sorted = sortEntries([
      { relativePath: "b.md", updatedAt: "2026-01-02" },
      { relativePath: "a.md", updatedAt: "2026-01-02" },
    ] as never);
    assert.deepEqual(
      sorted.map(e => (e as { relativePath: string }).relativePath),
      ["a.md", "b.md"],
    );
  });
  it("normalizeProjectStatus 默认值", () => {
    assert.equal(normalizeProjectStatus("active"), "active");
    assert.equal(normalizeProjectStatus(undefined), DEFAULT_PROJECT_STATUS);
  });
});

describe("file-constants 公共常量", () => {
  it("TMP/CURRENT_PROJECT_ID 值", () => {
    assert.equal(TMP_PROJECT_ID, "_tmp");
    assert.equal(CURRENT_PROJECT_ID, "current_project");
  });
});
