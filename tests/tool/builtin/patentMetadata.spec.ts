/**
 * 测试: patent_metadata 内置工具（nuo-patent 数据引擎）
 * 通过 creator 注入 mock scrape 函数，避免网络请求。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PatentData, ScrapeResult } from "nuo-patent";
import { createPatentMetadataTool } from "../../../src/tool/builtin/patentMetadata.js";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";

const context = { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as never;

/** 构造 nuo-patent PatentData fixture（JSON 字符串字段）。 */
function makePatentData(): PatentData {
  return {
    title: "Thermal management system",
    application_number: "US17/123,456",
    inventor_name: JSON.stringify([{ inventor_name: "Alice Zhang" }]),
    assignee_name_orig: JSON.stringify([{ assignee_name: "Apple Inc." }]),
    assignee_name_current: JSON.stringify([{ assignee_name: "Apple Inc." }]),
    pub_date: "2022-09-27",
    filing_date: "2019-12-31",
    priority_date: "2019-12-31",
    grant_date: "2022-09-27",
    expiration_date: "2032-04-08",
    legal_status: "Active",
    ifi_status: "Active, expires 2032-04-08",
    estimated_expiration: "2032-04-08",
    pdf_url: "https://patentimages.storage.googleapis.com/x/US11452699B2.pdf",
    classifications: JSON.stringify(["G06F1/20"]),
    forward_cite_no_family: JSON.stringify([
      { patent_number: "US11563056B2", priority_date: "2020-01-01", pub_date: "2023-01-24" },
    ]),
    forward_cite_yes_family: "[]",
    backward_cite_no_family: "[]",
    backward_cite_yes_family: "[]",
    abstract_text: "A thermal management system for electronic devices.",
  };
}

function makeScrapeResult(overrides: Partial<ScrapeResult>): ScrapeResult {
  return {
    success: true,
    patent: "US11452699B2",
    url: "https://patents.google.com/patent/US11452699B2",
    data: makePatentData(),
    errorCode: "",
    errorMessage: "",
    parseWarnings: [],
    ...overrides,
  };
}

describe("patent_metadata 工具", () => {
  it("成功抓取返回结构化数据（JSON 字段已解析）", async () => {
    const tool = createPatentMetadataTool({ scrape: async () => makeScrapeResult({}) });
    const res = await tool.execute({ patent: "US11452699B2" }, context);

    assert.equal(res.metadata?.success, true);
    const data = res.data as {
      data: {
        patent: string;
        inventors: string[];
        forwardCites: unknown[];
        classifications: string[];
        legalStatus: string;
      };
    };
    assert.equal(data.data.patent, "US11452699B2");
    assert.deepEqual(data.data.inventors, ["Alice Zhang"]);
    assert.deepEqual(data.data.classifications, ["G06F1/20"]);
    assert.equal(data.data.forwardCites.length, 1);
    assert.equal(data.data.legalStatus, "Active");
  });

  it("空/非法专利号抛 invalid_tool_input（不调用 scrape）", async () => {
    let called = false;
    const tool = createPatentMetadataTool({
      scrape: async () => {
        called = true;
        return makeScrapeResult({});
      },
    });
    await assert.rejects(
      tool.execute({ patent: "not-a-patent" }, context),
      err => err instanceof SatiToolRuntimeError && err.code === "invalid_tool_input",
    );
    assert.equal(called, false);
  });

  it("scrape 返回 VALIDATION_ERROR → invalid_tool_input", async () => {
    const tool = createPatentMetadataTool({
      scrape: async () =>
        makeScrapeResult({ success: false, data: null, errorCode: "VALIDATION_ERROR", errorMessage: "bad number" }),
    });
    await assert.rejects(
      tool.execute({ patent: "US11452699B2" }, context),
      err => err instanceof SatiToolRuntimeError && err.code === "invalid_tool_input",
    );
  });

  it("NOT_FOUND 作为数据返回（非错误），success=false", async () => {
    const tool = createPatentMetadataTool({
      scrape: async () => makeScrapeResult({ success: false, data: null, errorCode: "NOT_FOUND", errorMessage: "404" }),
    });
    const res = await tool.execute({ patent: "US0000000X" }, context);
    assert.equal(res.metadata?.success, false);
    assert.equal((res.data as { errorCode: string }).errorCode, "NOT_FOUND");
  });

  it("TIMEOUT → tool_timeout", async () => {
    const tool = createPatentMetadataTool({
      scrape: async () =>
        makeScrapeResult({ success: false, data: null, errorCode: "TIMEOUT", errorMessage: "timeout" }),
    });
    await assert.rejects(
      tool.execute({ patent: "US11452699B2" }, context),
      err => err instanceof SatiToolRuntimeError && err.code === "tool_timeout",
    );
  });

  it("NETWORK_ERROR → tool_execution_failed", async () => {
    const tool = createPatentMetadataTool({
      scrape: async () =>
        makeScrapeResult({ success: false, data: null, errorCode: "NETWORK_ERROR", errorMessage: "ECONNRESET" }),
    });
    await assert.rejects(
      tool.execute({ patent: "US11452699B2" }, context),
      err => err instanceof SatiToolRuntimeError && err.code === "tool_execution_failed",
    );
  });

  it("parseWarnings 透出（页面结构变化降级语义）", async () => {
    const tool = createPatentMetadataTool({
      scrape: async () =>
        makeScrapeResult({ parseWarnings: [{ field: "title", message: "未找到 DC.title meta 标签" }] }),
    });
    const res = await tool.execute({ patent: "US11452699B2" }, context);
    const warnings = (res.data as { parseWarnings: Array<{ field: string }> }).parseWarnings;
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].field, "title");
  });
});
