// llm-json 行为基线测试（拆解自 llm-extraction.ts G4 聚类，函数体逐字搬移）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeLooseJsonString,
  extractFirstJsonObject,
  extractLooseJsonBooleanProperty,
  extractLooseJsonEnvelope,
  extractLooseJsonStringProperty,
  tryParseLooseMemoryCreatePayload,
} from "../../src/core/skills/llm-json.js";

describe("extractFirstJsonObject", () => {
  it("纯 JSON 直接返回", () => {
    assert.equal(extractFirstJsonObject('{"a":1}'), '{"a":1}');
  });

  it("前导文本 + markdown 围栏中提取首个对象", () => {
    assert.equal(extractFirstJsonObject('```json\n{"a":{"b":2}}\n```'), '{"a":{"b":2}}');
  });

  it("字符串内的大括号与转义引号不计入深度", () => {
    const raw = '前置 {"key":"a}{b\\"c","nested":{"x":1}} 后置';
    assert.equal(extractFirstJsonObject(raw), '{"key":"a}{b\\"c","nested":{"x":1}}');
  });

  it("空输入抛 Empty extraction response", () => {
    assert.throws(() => extractFirstJsonObject("   "), /Empty extraction response/);
  });

  it("无 { 抛 No JSON object found", () => {
    assert.throws(() => extractFirstJsonObject("no json here"), /No JSON object found/);
  });

  it("残缺 JSON 抛 Incomplete JSON object", () => {
    assert.throws(() => extractFirstJsonObject('{"a":1'), /Incomplete JSON object/);
  });
});

describe("extractLooseJsonEnvelope", () => {
  it("截取首 { 至尾 }", () => {
    assert.equal(extractLooseJsonEnvelope('prefix {"a":1} suffix'), '{"a":1}');
  });

  it("无 { 或 { 在 } 之后抛 No JSON envelope found", () => {
    assert.throws(() => extractLooseJsonEnvelope("no braces"), /No JSON envelope found/);
    assert.throws(() => extractLooseJsonEnvelope("} {"), /No JSON envelope found/);
  });
});

describe("decodeLooseJsonString 替换链顺序", () => {
  it('\\r\\n → 换行、\\n → 换行、\\t → 制表、\\" → 引号、\\\\ → 反斜杠', () => {
    assert.equal(decodeLooseJsonString('a\\r\\nb\\n\\tc\\"d\\\\e'), 'a\nb\n\tc"d\\e');
  });
});

describe("extractLooseJsonBooleanProperty", () => {
  it("命中 true/false（大小写不敏感）", () => {
    assert.equal(extractLooseJsonBooleanProperty('{"skip": true}', "skip"), true);
    assert.equal(extractLooseJsonBooleanProperty('{"skip": FALSE}', "skip"), false);
  });

  it("缺失返回 undefined", () => {
    assert.equal(extractLooseJsonBooleanProperty('{"other": 1}', "skip"), undefined);
  });
});

describe("extractLooseJsonStringProperty", () => {
  it("带 nextKeys 锚定：取 key 值直到下一键", () => {
    assert.equal(
      extractLooseJsonStringProperty('{"name":"Alpha","description":"desc"}', "name", ["description"]),
      "Alpha",
    );
  });

  it("末键（无 nextKeys）：取到对象结尾", () => {
    assert.equal(extractLooseJsonStringProperty('{"name":"Alpha","markdown":"body"}', "markdown", []), "body");
  });

  it("解码转义内容", () => {
    assert.equal(extractLooseJsonStringProperty('{"name":"a\\nb"}', "name", []), "a\nb");
  });
});

describe("tryParseLooseMemoryCreatePayload", () => {
  it("完整负载解析成功", () => {
    const payload = tryParseLooseMemoryCreatePayload(
      '{"skip":false,"reason":"r","name":"n","description":"d","markdown":"m"}',
    );
    assert.deepEqual(payload, { skip: false, reason: "r", name: "n", description: "d", markdown: "m" });
  });

  it("缺必填字段（name/description/markdown）返回 null", () => {
    assert.equal(tryParseLooseMemoryCreatePayload('{"skip":true}'), null);
  });

  it("多行 markdown 内容（跨行字符串）仍可解析", () => {
    const payload = tryParseLooseMemoryCreatePayload('{"name":"n","description":"d","markdown":"line1\\nline2"}');
    assert.equal(payload?.markdown, "line1\nline2");
  });

  it("键序打乱解析失败（宽松解析依赖 nextKeys 锚定键序，这是既有语义而非缺陷）", () => {
    // name→markdown→description 顺序下，description 的锚（markdown）在它后面，
    // nextKeys 正则无法定位 → 返回 null。此为实测锁定行为，勿"修复"。
    assert.equal(tryParseLooseMemoryCreatePayload('{"name":"n","markdown":"m","description":"d"}'), null);
  });
});
