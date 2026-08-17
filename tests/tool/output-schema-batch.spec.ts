/**
 * outputSchema 分批接入测试（阶段四 T9 后续批）。
 *
 * 首批 3 个专利工具（draft_claims/draft_specification/claim_chart_build）已声明
 * outputSchema；本批 8 个存量工具（通用 + 专利检索域）补上成功契约。本 spec 验证：
 * 1) 本批工具在 createBuiltinRegistry 中均已声明 outputSchema；
 * 2) 每个工具声明的 schema 对典型成功 data 零违约（契约有效，非死 schema）；
 * 3) 本批工具可注册到 requireOutputSchema: true 的注册表（分批接入的验收门）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validateCanonicalOutput } from "../../src/tool/execution/outputSchemaValidation.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";
import { createMemoryOverviewTool } from "../../src/tool/builtin/memoryTools.js";
import { createTaskCreateTool } from "../../src/tool/builtin/taskTools.js";
import { createReadSkillTool } from "../../src/tool/builtin/readSkill.js";

/** 本批工具的典型成功 data（严格符合各工具声明的 outputSchema 契约）。 */
const SAMPLE_DATA: Record<string, unknown> = {
  get_current_time: {
    timezone: "UTC",
    iso: "2026-08-16T00:00:00.000Z",
    local: "2026-08-16 00:00:00",
    date: "2026-08-16",
    weekday: "Sunday",
    unixMs: 0,
  },
  glob: { files: ["src/a.ts"], count: 1, truncated: false },
  grep: { mode: "content", files: ["src/a.ts"], count: 2, truncated: false },
  todo_write: {
    todos: [{ id: "t1", content: "write tests", status: "pending" }],
    mode: "structured",
    merge: false,
  },
  patent_search: {
    query: "phase change material",
    total: 1,
    hits: [
      {
        patent: "US10000001A1",
        title: "Thermal storage",
        assignee: "Acme",
        publicationDate: "2024-01-01",
        priorityDate: "2022-01-01",
        abstract: "A thermal storage device.",
        url: "https://patents.google.com/patent/US10000001A1",
      },
    ],
    warnings: [],
  },
  patent_case_search: {
    total: 1,
    results: [{ documentId: "doc-1", docType: "judgment", title: "无效宣告决定", charCount: 120, via: "fts" }],
  },
  patent_wiki_search: {
    total: 1,
    results: [{ id: "triz", title: "TRIZ", relativePath: "triz.md" }],
  },
  search_patent_figure: {
    query: "热交换器",
    total: 0,
    indexedCount: 0,
    method: "keyword",
    results: [],
  },
};

const BATCH_TOOL_NAMES = Object.keys(SAMPLE_DATA).sort();

test("本批 8 工具均已声明 outputSchema", () => {
  const registry = createBuiltinRegistry();
  for (const name of BATCH_TOOL_NAMES) {
    const tool = registry.get(name);
    assert.ok(tool, `工具 ${name} 应存在于内置注册表`);
    assert.ok(tool.outputSchema !== undefined, `工具 ${name} 应声明 outputSchema`);
  }
});

test("典型成功 data 对各自 schema 零违约（契约有效）", () => {
  const registry = createBuiltinRegistry();
  for (const name of BATCH_TOOL_NAMES) {
    const tool = registry.get(name)!;
    const violations = validateCanonicalOutput(SAMPLE_DATA[name], tool.outputSchema!);
    assert.deepEqual(violations, [], `${name} 典型 data 应通过自身 schema（违约: ${violations.join("; ")}`);
  }
});

test("本批工具可注册到 requireOutputSchema: true 的注册表", () => {
  const registry = createBuiltinRegistry();
  for (const name of BATCH_TOOL_NAMES) {
    const tool = registry.get(name)!;
    const strict = new ToolRegistry({ requireOutputSchema: true });
    assert.doesNotThrow(() => strict.register(tool), `${name} 在强制注册表下应可注册`);
  }
});

test("createBuiltinRegistry 已开启强制：全部内置工具均声明 outputSchema，条件工具亦可注册", () => {
  const registry = createBuiltinRegistry();
  const missing = registry.list().filter(tool => tool.outputSchema === undefined);
  assert.deepEqual(
    missing.map(t => t.name),
    [],
    `内置注册表应无缺 schema 工具（强制开启前全部声明）：${missing.map(t => t.name).join(", ")}`,
  );
  // 条件注册工具（memory/task/read_skill）在强制注册表上同样可注册。
  const strict = new ToolRegistry({ requireOutputSchema: true });
  const conditional = [
    createMemoryOverviewTool({} as unknown as Parameters<typeof createMemoryOverviewTool>[0]),
    createTaskCreateTool(),
    createReadSkillTool({} as unknown as Parameters<typeof createReadSkillTool>[0]),
  ];
  for (const tool of conditional) {
    assert.ok(tool.outputSchema !== undefined, `${tool.name} 应声明 outputSchema`);
    assert.doesNotThrow(() => strict.register(tool), `${tool.name} 在强制注册表下应可注册`);
  }
});
test("schema 反向违约被检出（契约真的生效）", () => {
  const registry = createBuiltinRegistry();
  const globTool = registry.get("glob")!;
  // 类型违约：files 元素非 string。
  const violations = validateCanonicalOutput({ files: [1], count: 1, truncated: false }, globTool.outputSchema!);
  assert.ok(violations.length > 0);
  assert.match(String(violations[0]), /files\[0\]/);
  const getCurrentTimeTool = registry.get("get_current_time")!;
  // 缺失 required 属性。
  const missing = validateCanonicalOutput({ timezone: "UTC" }, getCurrentTimeTool.outputSchema!);
  assert.ok(missing.some(v => String(v).includes("iso: missing required")));
});
