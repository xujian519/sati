import assert from "node:assert/strict";
import test from "node:test";
import { makeToolContext } from "../context-fixture.js";
import {
  createPatentCaseSearchTool,
  type CaseLawEngineRef,
  type PatentCaseSearchOutput,
} from "../../../src/tool/builtin/patentCaseSearch.js";
import type { CaseLawSearchEngine } from "../../../src/knowledge/case-law/case-law-search.js";

/** 构造判例检索 mock（不触碰真实 knowledge.db，CI 可跑）。 */
function makeRef(): CaseLawEngineRef {
  const engine = {
    search: (_query: string, _options: { docType?: string; court?: string; limit?: number }) => [
      {
        documentId: "d1",
        docType: "case",
        title: "专利无效复审决定 008073341",
        decisionNumber: "566693",
        caseNumber: "008073341",
        court: undefined,
        source: "raw",
        charCount: 45232,
        chunkIndex: 0,
        snippet: "本案涉及创造性三步法判断，审查员认为技术方案显而易见。",
        ftsRank: -8.3,
        via: "fts",
      },
      {
        documentId: "d2",
        docType: "judgment",
        title: "某专利侵权判决",
        decisionNumber: undefined,
        caseNumber: undefined,
        court: "最高人民法院",
        source: "raw",
        charCount: 10929,
        chunkIndex: 0,
        snippet: "判决书正文：创造性判断应采用三步法框架进行认定。",
        ftsRank: -9.1,
        via: "fts",
      },
    ],
    ftsAvailable: true,
    close: () => {},
  } as unknown as CaseLawSearchEngine;

  return { engine, dbPath: "/mock/knowledge.db" };
}

function asJson(
  result: Awaited<ReturnType<ReturnType<typeof createPatentCaseSearchTool>["execute"]>>,
): PatentCaseSearchOutput {
  const first = result.content[0];
  assert.equal(first?.type, "json");
  if (first?.type !== "json") assert.fail("expected json content");
  return first.value as PatentCaseSearchOutput;
}

test("patent_case_search: 工具元数据正确", () => {
  const tool = createPatentCaseSearchTool(() => makeRef());
  assert.equal(tool.name, "patent_case_search");
  assert.equal(tool.domain, "patent");
  assert.equal(tool.isReadOnly({ query: "创造性" }), true);
  assert.equal(tool.isConcurrencySafe({ query: "创造性" }), true);
});

test("patent_case_search: 命中输出 JSON 结构（含决定号/片段/命中方式）", async () => {
  const tool = createPatentCaseSearchTool(() => makeRef());
  const result = await tool.execute({ query: "创造性" }, makeToolContext());
  const output = asJson(result);
  assert.equal(output.total, 2);
  assert.equal(output.dbPath, "/mock/knowledge.db");
  const d1 = output.results.find(r => r.documentId === "d1");
  assert.equal(d1?.decisionNumber, "566693");
  assert.equal(d1?.via, "fts");
  assert.ok(d1?.snippet, "默认应附命中片段");
  assert.ok(output.results.every(r => r.via === "fts"));
});

test("patent_case_search: include_content=false 时不附片段", async () => {
  const tool = createPatentCaseSearchTool(() => makeRef());
  const result = await tool.execute({ query: "创造性", include_content: false }, makeToolContext());
  const output = asJson(result);
  assert.equal(output.results[0]?.snippet, undefined);
});

test("patent_case_search: limit 透传给引擎", async () => {
  let capturedLimit: number | undefined;
  const engine = {
    search: (_q: string, options: { limit?: number }) => {
      capturedLimit = options.limit;
      return [];
    },
    ftsAvailable: true,
    close: () => {},
  } as unknown as CaseLawSearchEngine;
  const tool = createPatentCaseSearchTool(() => ({ engine, dbPath: "/mock/knowledge.db" }));
  await tool.execute({ query: "创造性", limit: 3 }, makeToolContext());
  assert.equal(capturedLimit, 3);
});

test("patent_case_search: doc_type/court 过滤透传给引擎且默认排除 wiki", async () => {
  let captured: { docType?: string; court?: string; excludeSource?: string } | undefined;
  const engine = {
    search: (_q: string, options: { docType?: string; court?: string; excludeSource?: string }) => {
      captured = options;
      return [];
    },
    ftsAvailable: true,
    close: () => {},
  } as unknown as CaseLawSearchEngine;
  const tool = createPatentCaseSearchTool(() => ({ engine, dbPath: "/mock/knowledge.db" }));
  await tool.execute({ query: "创造性", doc_type: "judgment", court: "最高" }, makeToolContext());
  assert.equal(captured?.docType, "judgment");
  assert.equal(captured?.court, "最高");
  assert.equal(captured?.excludeSource, "wiki", "判例检索应默认排除 wiki 审查标准卡片");
});

test("patent_case_search: 数据库缺失时 checkAvailability=setup_required 且 execute 提示 SATI_CASE_DB", async () => {
  const tool = createPatentCaseSearchTool(() => null);
  const availability = await tool.checkAvailability?.(makeToolContext());
  assert.equal(availability?.ok, false);
  assert.equal(availability?.code, "setup_required");

  const result = await tool.execute({ query: "创造性" }, makeToolContext());
  const first = result.content[0];
  assert.equal(first?.type, "text");
  if (first?.type !== "text") assert.fail("expected text content");
  assert.ok(first.text.includes("SATI_CASE_DB"), "错误文案应提示配置 SATI_CASE_DB");
  assert.equal(result.metadata?.error, "case_db_not_found");
});
