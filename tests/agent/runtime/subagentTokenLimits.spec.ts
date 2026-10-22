import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubagentTokenLimits } from "../../../src/agent/runtime/modelContextWindow.js";

test("协议默认窗口 + 同 provider 父级已知 1M → 继承父级窗口", () => {
  const resolved = resolveSubagentTokenLimits({
    parentProvider: "deepseek",
    parentMaxContextTokens: 1_000_000,
    parentMaxOutputTokens: 65_536,
    subagentProvider: "deepseek",
    subagentMaxContextTokens: 128_000,
    subagentMaxOutputTokens: 16_384,
    subagentContextSource: "protocol-default",
    subagentOutputSource: "protocol-default",
  });

  assert.equal(resolved.maxContextTokens, 1_000_000);
  assert.equal(resolved.maxOutputTokens, 65_536);
  assert.equal(resolved.inheritedContextWindow, true);
  assert.equal(resolved.inheritedOutputLimit, true);
});

test("catalog 事实窗口不被父级更大窗口覆盖", () => {
  const resolved = resolveSubagentTokenLimits({
    parentProvider: "deepseek",
    parentMaxContextTokens: 1_000_000,
    subagentProvider: "deepseek",
    subagentMaxContextTokens: 128_000,
    subagentContextSource: "catalog",
  });

  assert.equal(resolved.maxContextTokens, 128_000);
  assert.equal(resolved.inheritedContextWindow, false);
});

test("config/window 显式声明的窗口不被父级覆盖", () => {
  for (const source of ["config", "window"] as const) {
    const resolved = resolveSubagentTokenLimits({
      parentProvider: "deepseek",
      parentMaxContextTokens: 1_000_000,
      subagentProvider: "deepseek",
      subagentMaxContextTokens: 262_144,
      subagentContextSource: source,
    });

    assert.equal(resolved.maxContextTokens, 262_144, `${source} 声明的窗口应保留`);
    assert.equal(resolved.inheritedContextWindow, false);
  }
});

test("跨 provider 不继承父级窗口", () => {
  const resolved = resolveSubagentTokenLimits({
    parentProvider: "deepseek",
    parentMaxContextTokens: 1_000_000,
    subagentProvider: "openai",
    subagentMaxContextTokens: 128_000,
    subagentContextSource: "protocol-default",
  });

  assert.equal(resolved.maxContextTokens, 128_000);
  assert.equal(resolved.inheritedContextWindow, false);
});

test("父级窗口不大于子代理假设窗口时不继承", () => {
  const resolved = resolveSubagentTokenLimits({
    parentProvider: "deepseek",
    parentMaxContextTokens: 64_000,
    subagentProvider: "deepseek",
    subagentMaxContextTokens: 128_000,
    subagentContextSource: "protocol-default",
  });

  assert.equal(resolved.maxContextTokens, 128_000);
  assert.equal(resolved.inheritedContextWindow, false);
});

test("缺少来源标记时视为事实、不继承（兼容旧调用面）", () => {
  const resolved = resolveSubagentTokenLimits({
    parentProvider: "deepseek",
    parentMaxContextTokens: 1_000_000,
    subagentProvider: "deepseek",
    subagentMaxContextTokens: 128_000,
  });

  assert.equal(resolved.maxContextTokens, 128_000);
  assert.equal(resolved.inheritedContextWindow, false);
});

test("父级输出上限缺失时保留子代理默认", () => {
  const resolved = resolveSubagentTokenLimits({
    parentProvider: "deepseek",
    parentMaxContextTokens: 1_000_000,
    subagentProvider: "deepseek",
    subagentMaxContextTokens: 128_000,
    subagentMaxOutputTokens: 16_384,
    subagentContextSource: "protocol-default",
    subagentOutputSource: "protocol-default",
  });

  assert.equal(resolved.maxOutputTokens, 16_384);
  assert.equal(resolved.inheritedOutputLimit, false);
});
