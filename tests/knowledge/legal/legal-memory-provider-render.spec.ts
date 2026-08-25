import assert from "node:assert/strict";
import test from "node:test";
import { LegalMemoryProvider } from "../../../src/knowledge/legal/legal-memory-provider.js";
import type { LawCategory, LawRecord, LawSearchResult, LegalSearchSource } from "../../../src/knowledge/legal/types.js";
import type { MemoryRetrieveInput } from "../../../src/context/memory/MemoryResolver.js";

/**
 * LegalMemoryProvider 渲染标注单测（F3）：systemContext 对失效法/地方性法规
 * 给出显式标注（已失效 + 取代版本 / 需人工复核），无标注记录不产生噪音后缀。
 *
 * FakeEngine 固定 search 返回，隔离 DB 层；cacheTtlMs: 0 关闭缓存避免跨用例干扰。
 */

function rec(overrides: Partial<LawRecord> = {}): LawRecord {
  return {
    id: "law-1",
    level: "法律",
    name: "中华人民共和国专利法",
    expired: 0,
    categoryId: 1,
    content: "专利法全文内容",
    categoryName: "民法商法",
    ...overrides,
  };
}

class FakeEngine implements LegalSearchSource {
  readonly ftsAvailable = true;
  constructor(private readonly hits: LawRecord[]) {}

  search(): LawSearchResult[] {
    return this.hits.map(r => ({ ...r, score: 0 }));
  }

  findByName(): LawRecord[] {
    return [];
  }

  getById(): LawRecord | undefined {
    return undefined;
  }

  getByIds(): LawRecord[] {
    return [];
  }

  getCategories(): LawCategory[] {
    return [];
  }

  count(): number {
    return this.hits.length;
  }

  close(): void {}
}

function makeInput(query: string): MemoryRetrieveInput {
  return { query, sessionId: "s1", projectRoot: "/tmp", recentMessages: [] };
}

async function render(hits: LawRecord[], query = "专利法"): Promise<string | undefined> {
  const provider = new LegalMemoryProvider(new FakeEngine(hits), { limit: 3, cacheTtlMs: 0 });
  const result = await provider.retrieve(makeInput(query));
  return result.systemContext;
}

test("legal-memory: 已废止法渲染「已失效（已废止）」", async () => {
  const ctx = await render([rec({ status: "已废止" })]);
  assert.ok(ctx);
  assert.ok(ctx.includes("已失效（已废止）"));
});

test("legal-memory: 已被修订法渲染「已失效（已被修订，由 X 取代）」", async () => {
  const ctx = await render([rec({ status: "已被修订", supersededBy: "中华人民共和国专利法（2023-12-11 版）" })]);
  assert.ok(ctx);
  assert.ok(ctx.includes("已失效（已被修订，由 中华人民共和国专利法（2023-12-11 版）取代）"));
});

test("legal-memory: expired=1 无 status 时派生已废止标注", async () => {
  const ctx = await render([rec({ expired: 1 })]);
  assert.ok(ctx);
  assert.ok(ctx.includes("已失效（已废止）"));
});

test("legal-memory: 地方性法规渲染「需人工复核」标注", async () => {
  const ctx = await render([rec({ level: "地方性法规", localRegulation: true, name: "北京市专利保护办法" })]);
  assert.ok(ctx);
  assert.ok(ctx.includes("地方性法规，需人工复核"));
});

test("legal-memory: 现行有效且非地方法规不产生标注后缀", async () => {
  const ctx = await render([rec({ status: "现行有效" })]);
  assert.ok(ctx);
  assert.ok(!ctx.includes("【"), "无标注时不渲染【】后缀");
});
