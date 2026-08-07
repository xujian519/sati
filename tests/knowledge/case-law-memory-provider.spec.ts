import assert from "node:assert/strict";
import test from "node:test";
import { CaseLawMemoryProvider } from "../../src/knowledge/case-law/case-law-memory-provider.js";
import { fuseCaseLawHits } from "../../src/knowledge/case-law/rrf.js";
import type { CaseLawHit } from "../../src/knowledge/case-law/types.js";
import type { MemoryRetrieveInput } from "../../src/context/memory/MemoryResolver.js";

/**
 * CaseLawMemoryProvider 单元测试（判例自动注入 <memory-context>）。
 *
 * 触发门控：query 命中专利实务语义（创造性/无效/答复/区别特征…）才检索；
 * 普通对话不注入，避免上下文膨胀。engine 以 mock 注入（provider 仅依赖
 * search/searchSemantic/semanticAvailable/setSemantic 四个方法）。
 */

function makeHit(overrides: Partial<CaseLawHit> = {}): CaseLawHit {
  return {
    documentId: "d1",
    docType: "case",
    title: "专利无效复审决定 008073341",
    decisionNumber: "566693",
    charCount: 300,
    chunkIndex: 0,
    snippet: "合议组认为区别特征产生了预料不到的技术效果。",
    via: "fts",
    ...overrides,
  };
}

function makeEngine(overrides: Partial<Record<"search" | "searchSemantic", unknown>> = {}) {
  return {
    setSemantic: () => {},
    search: overrides.search ?? (() => [makeHit()]),
    searchSemantic: overrides.searchSemantic ?? (async () => []),
    get semanticAvailable() {
      return false;
    },
  } as never;
}

function input(overrides: Partial<MemoryRetrieveInput> = {}): MemoryRetrieveInput {
  return {
    query: "帮我分析这份无效宣告请求的创造性问题",
    sessionId: "s1",
    projectRoot: "/tmp/proj",
    recentMessages: [],
    ...overrides,
  };
}

test("触发：专利实务 query 注入 <case-law> 块", async () => {
  const provider = new CaseLawMemoryProvider({ engine: makeEngine() });
  const result = await provider.retrieve(input());
  assert.ok(result.systemContext?.startsWith("<case-law>"), "应以 <case-law> 块注入");
  assert.ok(result.systemContext?.includes("决定号 566693"));
  assert.ok(result.systemContext?.includes('<case doc_type="case"'));
  assert.ok(result.systemContext?.endsWith("</case-law>"));
  const diag = result.diagnostics.find(d => d.code === "memory_case_law_injected");
  assert.ok(diag, "应输出 memory_case_law_injected 诊断");
});

test("触发门控：普通对话不注入（无 systemContext）", async () => {
  let called = false;
  const provider = new CaseLawMemoryProvider({
    engine: makeEngine({ search: () => ((called = true), [makeHit()]) }),
  });
  const result = await provider.retrieve(input({ query: "你好，帮我写一个 python 脚本" }));
  assert.equal(result.systemContext, undefined, "普通 query 不应注入判例");
  assert.equal(called, false, "不应触发引擎检索");
});

test("触发门控：空 query 不检索", async () => {
  let called = false;
  const provider = new CaseLawMemoryProvider({
    engine: makeEngine({ search: () => ((called = true), []) }),
  });
  const result = await provider.retrieve(input({ query: "  " }));
  assert.equal(result.systemContext, undefined);
  assert.equal(called, false);
});

test("限额：caseLimit=2 时最多注入 2 条", async () => {
  const hits = Array.from({ length: 5 }, (_, i) => makeHit({ documentId: `d${i + 1}` }));
  const provider = new CaseLawMemoryProvider({ engine: makeEngine({ search: () => hits }), caseLimit: 2 });
  const result = await provider.retrieve(input());
  const caseBlocks = result.systemContext?.match(/<case doc_type=/g) ?? [];
  assert.equal(caseBlocks.length, 2, "应只注入 2 条判例");
});

test("片段截断：超过 snippetMaxChars 时截断", async () => {
  const long = "创".repeat(500);
  const provider = new CaseLawMemoryProvider({
    engine: makeEngine({ search: () => [makeHit({ snippet: long })] }),
    snippetMaxChars: 100,
  });
  const result = await provider.retrieve(input());
  assert.ok(result.systemContext?.includes("…（截断）"));
  const snippet = result.systemContext?.split("片段: ")[1] ?? "";
  assert.ok(snippet.length <= 140, `片段应被截断（实际 ${snippet.length} 字符）`);
});

test("降级：engine 缺失时 memory_disabled 且不抛错", async () => {
  const provider = new CaseLawMemoryProvider({});
  const result = await provider.retrieve(input());
  assert.equal(result.systemContext, undefined);
  const diag = result.diagnostics.find(d => d.code === "memory_disabled");
  assert.ok(diag, "应输出 memory_disabled 诊断");
  assert.ok(diag.message.includes("判例库不可用"));
});

test("降级：搜索抛异常时不抛错，输出 memory_provider_error", async () => {
  const provider = new CaseLawMemoryProvider({
    engine: makeEngine({
      search: () => {
        throw new Error("db locked");
      },
    }),
  });
  const result = await provider.retrieve(input());
  assert.equal(result.systemContext, undefined);
  const diag = result.diagnostics.find(d => d.code === "memory_provider_error");
  assert.ok(diag, "应输出 memory_provider_error 诊断");
  assert.ok(diag.message.includes("db locked"));
});

test("降级：无命中时 memory_context_empty 且无 systemContext", async () => {
  const provider = new CaseLawMemoryProvider({ engine: makeEngine({ search: () => [] }) });
  const result = await provider.retrieve(input());
  assert.equal(result.systemContext, undefined);
  const diag = result.diagnostics.find(d => d.code === "memory_context_empty");
  assert.ok(diag, "应输出 memory_context_empty 诊断");
});

test("captureTurn 为空操作（知识库只读）", async () => {
  const provider = new CaseLawMemoryProvider({ engine: makeEngine() });
  await provider.captureTurn({
    sessionId: "s1",
    projectRoot: "/tmp/proj",
    messages: [],
    errored: false,
  });
  // 不抛错即通过（空操作不写任何库）。
});

test("禁用：enableCaseLaw=false 时不检索", async () => {
  let called = false;
  const provider = new CaseLawMemoryProvider({
    engine: makeEngine({ search: () => ((called = true), []) }),
    enableCaseLaw: false,
  });
  const result = await provider.retrieve(input());
  assert.equal(result.systemContext, undefined);
  assert.equal(called, false);
});

test("fuseCaseLawHits：FTS 优先保留，语义填充未覆盖文档", () => {
  const fts = [makeHit({ documentId: "a", via: "fts" }), makeHit({ documentId: "b", via: "fts" })];
  const semantic = [makeHit({ documentId: "b", via: "semantic" }), makeHit({ documentId: "c", via: "semantic" })];
  const fused = fuseCaseLawHits(fts, semantic, 3);
  // RRF 排序：b 双路命中得分最高排第一；a（仅 FTS 第 1）次之；c（仅语义第 2）最后。
  assert.deepEqual(
    fused.map(h => h.documentId),
    ["b", "a", "c"],
  );
  // b 保留 FTS 命中（via 不丢）
  assert.equal(fused.find(h => h.documentId === "b")?.via, "fts");
  // c 由语义填充
  assert.equal(fused.find(h => h.documentId === "c")?.via, "semantic");
});

test("fuseCaseLawHits：语义为空时直接透传 FTS", () => {
  const fts = [makeHit({ documentId: "a" }), makeHit({ documentId: "b" })];
  const fused = fuseCaseLawHits(fts, [], 5);
  assert.equal(fused.length, 2);
});
