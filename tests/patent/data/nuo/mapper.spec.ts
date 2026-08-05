/**
 * 测试: nuo-patent 数据引擎映射层（mapper.ts）
 * PatentData 的 JSON 字符串字段 → 结构化类型。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PatentData } from "nuo-patent";
import { mapPatentData, parseJsonArray } from "../../../../src/patent/data/nuo/mapper.js";

/** 构造一个带 JSON 字符串字段的 nuo-patent PatentData fixture。 */
function makePatentData(): PatentData {
  return {
    title: "Thermal management system",
    application_number: "US17/123,456",
    inventor_name: JSON.stringify([{ inventor_name: "Alice Zhang" }, { inventor_name: "Bob Li" }]),
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
    pdf_url: "https://patentimages.storage.googleapis.com/.../US11452699B2.pdf",
    classifications: JSON.stringify(["G06F1/20", "H05K7/20"]),
    forward_cite_no_family: JSON.stringify([
      { patent_number: "US11563056B2", priority_date: "2020-01-01", pub_date: "2023-01-24" },
    ]),
    forward_cite_yes_family: "[]",
    backward_cite_no_family: JSON.stringify([
      { patent_number: "US10123456B2", priority_date: "2010-05-05", pub_date: "2012-01-01" },
    ]),
    backward_cite_yes_family: "[]",
    abstract_text: "A thermal management system for electronic devices.",
  };
}

describe("parseJsonArray", () => {
  it("解析合法 JSON 数组", () => {
    assert.deepEqual(parseJsonArray<string>('["a","b"]'), ["a", "b"]);
  });

  it("空字符串返回空数组", () => {
    assert.deepEqual(parseJsonArray<string>(""), []);
  });

  it("非法 JSON 返回空数组不抛异常", () => {
    assert.deepEqual(parseJsonArray<string>("{not json"), []);
  });

  it("非数组 JSON 返回空数组", () => {
    assert.deepEqual(parseJsonArray<string>('{"a":1}'), []);
  });
});

describe("mapPatentData", () => {
  it("完整映射 JSON 字符串字段为结构化数组", () => {
    const mapped = mapPatentData(makePatentData(), "US11452699B2", "https://patents.google.com/patent/US11452699B2");

    assert.equal(mapped.patent, "US11452699B2");
    assert.equal(mapped.title, "Thermal management system");
    assert.deepEqual(mapped.inventors, ["Alice Zhang", "Bob Li"]);
    assert.deepEqual(mapped.assigneesCurrent, ["Apple Inc."]);
    assert.deepEqual(mapped.assigneesOriginal, ["Apple Inc."]);
    assert.deepEqual(mapped.classifications, ["G06F1/20", "H05K7/20"]);
    assert.equal(mapped.legalStatus, "Active");
    assert.equal(mapped.estimatedExpiration, "2032-04-08");
  });

  it("前后向引证合并 family 与非 family", () => {
    const mapped = mapPatentData(makePatentData(), "US11452699B2", "url");
    assert.equal(mapped.forwardCites.length, 1);
    assert.equal(mapped.forwardCites[0].patent_number, "US11563056B2");
    assert.equal(mapped.backwardCites.length, 1);
    assert.equal(mapped.backwardCites[0].patent_number, "US10123456B2");
  });

  it("空 JSON 字段映射为空数组不抛异常", () => {
    const data = makePatentData();
    data.inventor_name = "";
    data.classifications = "not json";
    data.backward_cite_no_family = "[]";
    const mapped = mapPatentData(data, "US11452699B2", "url");
    assert.deepEqual(mapped.inventors, []);
    assert.deepEqual(mapped.classifications, []);
    assert.deepEqual(mapped.backwardCites, []);
  });

  it("真实抓取响应形态：url/patent 回填字段不覆盖显式参数，额外字段不破坏解析", () => {
    // getScrapedData 会在 PatentData 上附带 url/patent 字段；mapPatentData 应以显式参数为准
    const data = makePatentData();
    (data as { url?: string; patent?: string }).url = "https://patents.google.com/patent/US11452699B2/en";
    (data as { url?: string; patent?: string }).patent = "US11452699B2";
    // 真实页面可能出现的额外键/宽松格式（分类号含空格分隔、引证含 extra 字段）
    data.classifications = JSON.stringify(["G06F 1/20", "H05K 7/20"]);
    data.backward_cite_no_family = JSON.stringify([
      { patent_number: "US10123456B2", priority_date: "2010-05-05", pub_date: "2012-01-01", extra: "ignored" },
    ]);
    const mapped = mapPatentData(data, "US11452699B2", "https://patents.google.com/patent/US11452699B2");
    assert.equal(mapped.patent, "US11452699B2");
    assert.equal(mapped.url, "https://patents.google.com/patent/US11452699B2");
    assert.deepEqual(mapped.classifications, ["G06F 1/20", "H05K 7/20"]);
    assert.equal(mapped.backwardCites[0]!.patent_number, "US10123456B2");
    // 额外字段被 JSON.parse 保留（运行时行为），不影响核心字段解析
    assert.equal(
      (mapped.backwardCites[0] as unknown as Record<string, unknown>).extra,
      "ignored",
      "额外字段保留是 parseJsonArray 的运行时行为，不裁剪",
    );
  });
});
