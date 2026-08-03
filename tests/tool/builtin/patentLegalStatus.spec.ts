/**
 * 测试: patent_legal_status 内置工具
 * 通过 creator 注入 mock checker，避免网络请求。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LegalStatusChecker, LegalStatusResult } from "nuo-patent";
import { createPatentLegalStatusTool } from "../../../src/tool/builtin/patentLegalStatus.js";

const context = { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as never;

function makeResult(patentNumber: string, overrides: Partial<LegalStatusResult> = {}): LegalStatusResult {
  return {
    patent_number: patentNumber,
    title: "Thermal management system",
    status: "Active",
    ifi_status: "Active, expires 2032-04-08",
    estimated_expiration: "2032-04-08",
    filing_date: "2019-12-31",
    grant_date: "2022-09-27",
    applicant: "",
    inventor: "",
    events_summary: [{ type: "legal-status", date: "2022-09-27", title: "Active" }],
    url: `https://patents.google.com/patent/${patentNumber}`,
    ...overrides,
  };
}

/** 注入一个仅提供 checkBatch 的假 checker。 */
function mockChecker(impl: (patents: string[]) => Promise<Record<string, LegalStatusResult>>): LegalStatusChecker {
  return { checkBatch: impl } as unknown as LegalStatusChecker;
}

describe("patent_legal_status 工具", () => {
  it("批量查询返回结构化 items", async () => {
    const tool = createPatentLegalStatusTool({
      checker: mockChecker(async patents => Object.fromEntries(patents.map(pn => [pn, makeResult(pn)]))),
    });
    const res = await tool.execute({ patents: ["US11452699B2", "US2668287A"] }, context);

    const items = (
      res.data as { results: Array<{ patentNumber: string; status: string; estimatedExpiration: string }> }
    ).results;
    assert.equal(items.length, 2);
    assert.equal(items[0].patentNumber, "US11452699B2");
    assert.equal(items[0].status, "Active");
    assert.equal(items[0].estimatedExpiration, "2032-04-08");
    assert.equal(res.metadata?.count, 2);
  });

  it("单专利失败（error 字段）不中断整体", async () => {
    const tool = createPatentLegalStatusTool({
      checker: mockChecker(async patents =>
        Object.fromEntries(
          patents.map(pn => [pn, pn === "US2668287A" ? makeResult(pn, { error: "404" }) : makeResult(pn)]),
        ),
      ),
    });
    const res = await tool.execute({ patents: ["US11452699B2", "US2668287A"] }, context);

    const items = (res.data as { results: Array<{ patentNumber: string; error?: string }> }).results;
    assert.equal(items.length, 2);
    assert.equal(items[1].error, "404");
    assert.equal(res.metadata?.withError, 1);
  });

  it("最多处理 20 个专利号", async () => {
    const seen: string[] = [];
    const tool = createPatentLegalStatusTool({
      checker: mockChecker(async patents => {
        seen.push(...patents);
        return Object.fromEntries(patents.map(pn => [pn, makeResult(pn)]));
      }),
    });
    const patents = Array.from({ length: 25 }, (_, i) => `US${1000000 + i}B2`);
    const res = await tool.execute({ patents }, context);

    assert.equal(seen.length, 20);
    assert.equal((res.data as { results: unknown[] }).results.length, 20);
  });

  it("空列表返回空 results 不抛异常", async () => {
    const tool = createPatentLegalStatusTool({ checker: mockChecker(async () => ({})) });
    const res = await tool.execute({ patents: [] }, context);
    assert.deepEqual((res.data as { results: unknown[] }).results, []);
  });
});
