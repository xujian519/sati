/**
 * 测试: nuo-patent 数据引擎映射层（mapper.ts）
 * PatentData 的 JSON 字符串字段 → 结构化类型。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PatentData } from "nuo-patent";
import type { JsonParseDiagnostic } from "../../../../src/patent/data/nuo/mapper.js";
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

  it("纯结构契约：字符串字段原样透传，不做领域计算", () => {
    const mapped = mapPatentData(makePatentData(), "US11452699B2", "url");
    // 法律状态/到期估算等域语义字段原样透传，适配层不做解释或推算
    assert.equal(mapped.legalStatus, "Active");
    assert.equal(mapped.ifiStatus, "Active, expires 2032-04-08");
    assert.equal(mapped.estimatedExpiration, "2032-04-08");
    assert.equal(mapped.expirationDate, "2032-04-08");
    assert.equal(mapped.pubDate, "2022-09-27");
  });

  it("纯结构契约：发明人保持原始顺序且不去重（无领域排序/去重）", () => {
    const data = makePatentData();
    data.inventor_name = JSON.stringify([
      { inventor_name: "Bob" },
      { inventor_name: "Alice" },
      { inventor_name: "Bob" },
    ]);
    const mapped = mapPatentData(data, "US11452699B2", "url");
    assert.deepEqual(mapped.inventors, ["Bob", "Alice", "Bob"], "应保留输入顺序与重复项");
  });

  it("纯结构契约：引证按 non-family → family 合并，不按日期排序", () => {
    const data = makePatentData();
    // backward_cite_yes_family 的日期更早，意在证明合并顺序不按日期重排
    data.backward_cite_no_family = JSON.stringify([
      { patent_number: "USZ", priority_date: "2020-01-01", pub_date: "2021-01-01" },
    ]);
    data.backward_cite_yes_family = JSON.stringify([
      { patent_number: "USA", priority_date: "2010-01-01", pub_date: "2011-01-01" },
    ]);
    const mapped = mapPatentData(data, "US11452699B2", "url");
    assert.deepEqual(
      mapped.backwardCites.map(c => c.patent_number),
      ["USZ", "USA"],
      "应先 non-family 后 family，且不按优先权日重排",
    );
  });
});

describe("parseJsonArray 坏 JSON 告警（TD-PATENT-N06）", () => {
  it("非法 JSON 触发 onError，携带字段名与样本片段", () => {
    const diags: JsonParseDiagnostic[] = [];
    const out = parseJsonArray<string>("{broken", "classifications", d => diags.push(d));
    assert.deepEqual(out, []);
    assert.equal(diags.length, 1);
    assert.equal(diags[0]!.field, "classifications");
    assert.ok(diags[0]!.sample.includes("{broken"));
  });

  it("合法输入与空字符串不触发 onError", () => {
    const diags: JsonParseDiagnostic[] = [];
    parseJsonArray<string>('["a","b"]', "f", d => diags.push(d));
    parseJsonArray<string>("", "f", d => diags.push(d));
    assert.equal(diags.length, 0, "合法数组与空字符串均不触发告警");
  });

  it("超长样本压缩空白并截断到 80 字符", () => {
    const diags: JsonParseDiagnostic[] = [];
    // 未闭合字符串：非法 JSON 触发告警，且含换行与超长内容以验证压缩+截断
    const longBad = `["${"y".repeat(20)}\n${"z".repeat(200)}   `;
    parseJsonArray<string>(longBad, "abstract", d => diags.push(d));
    assert.equal(diags.length, 1);
    const sample = diags[0]!.sample;
    assert.ok(!sample.includes("\n"), "样本已压缩为单行");
    assert.ok(sample.includes("y") && sample.includes("z"), "样本保留首尾片段");
    assert.ok(sample.length <= 81, `样本截断到 80 字符（含省略号），实际 ${sample.length}`);
  });
});
