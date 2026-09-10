import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTier } from "../../../src/router/tokenSaver/parseTier.js";

describe("parseTier", () => {
  it("解析 <tier> 标签并归一化到已知 tier（大小写不敏感）", () => {
    assert.equal(parseTier("judge: ... <tier>Simple</tier> ...", ["simple", "complex"]), "simple");
    assert.equal(parseTier("<tier>COMPLEX</tier>", ["simple", "complex"]), "complex");
  });

  it("剥离 markdown 代码围栏后仍能解析标签", () => {
    assert.equal(parseTier("```\n<tier>medium</tier>\n```", ["low", "medium", "high"]), "medium");
  });

  it("无标签时按关键词模糊匹配已知 tier", () => {
    assert.equal(parseTier("该请求涉及复杂多步骤推理，应路由到 complex 档", ["simple", "complex"]), "complex");
  });

  it("关键词匹配不区分大小写", () => {
    assert.equal(parseTier("Use SIMPLE tier for this", ["simple"]), "simple");
  });

  it("标签内为未知 tier 时回退到关键词匹配", () => {
    // <tier>unknown</tier> 不在 knownTiers 中；后续关键词 "complex" 命中。
    assert.equal(parseTier("<tier>unknown</tier> and complex", ["simple", "complex"]), "complex");
  });

  it("整段输出恰好等于某个 tier 时精确命中，不被更短 tier 的词边界抢先", () => {
    // `-` 是词边界，`\ba\b` 会在 "a-a" 内部命中。
    assert.equal(parseTier("a-a", ["a", "a-a"]), "a-a");
  });

  it("带连字符的长 tier 不被其词前缀截胡", () => {
    // 声明顺序把 "fast" 放在前面，旧实现会先命中 "fast"。
    assert.equal(parseTier("route this to fast-pro please", ["fast", "fast-pro"]), "fast-pro");
  });

  it("精确匹配不区分大小写", () => {
    assert.equal(parseTier("Fast-Pro", ["fast", "fast-pro"]), "fast-pro");
  });

  it("模糊匹配按 tier 长度降序，取最长的命中项", () => {
    assert.equal(parseTier("both a-a and a appear here", ["a", "a-a"]), "a-a");
  });

  it("无任何匹配返回 undefined", () => {
    assert.equal(parseTier("no tier mentioned at all", ["simple", "complex"]), undefined);
  });

  it("空输出返回 undefined", () => {
    assert.equal(parseTier("", ["simple"]), undefined);
  });
});
