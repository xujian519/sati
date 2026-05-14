import test from "node:test";
import assert from "node:assert/strict";
import { generateJudgePrompt } from "../../src/router/tokenSaver/generateJudgePrompt.js";
import type { RouterTokenSaverConfig } from "../../src/router/config/schema.js";

function makeConfig(overrides?: Partial<RouterTokenSaverConfig>): RouterTokenSaverConfig {
  return {
    enabled: true,
    judge: { id: "p/j", provider: "p", model: "j" },
    defaultTier: "SIMPLE",
    tiers: {
      SIMPLE: {
        model: { id: "p/cheap", provider: "p", model: "cheap" },
        description: "Simple questions and small edits",
      },
      COMPLEX: {
        model: { id: "p/expensive", provider: "p", model: "expensive" },
        description: "Multi-step tasks, architecture, debugging",
      },
    },
    judgeTimeoutMs: 5000,
    ...overrides,
  };
}

test("generateJudgePrompt includes all tier names and descriptions", () => {
  const prompt = generateJudgePrompt({
    userMessage: "hello",
    config: makeConfig(),
  });
  assert.match(prompt, /- SIMPLE: Simple questions and small edits/);
  assert.match(prompt, /- COMPLEX: Multi-step tasks, architecture, debugging/);
});

test("generateJudgePrompt includes routing rules when present", () => {
  const prompt = generateJudgePrompt({
    userMessage: "hello",
    config: makeConfig({ rules: ["If code generation, use COMPLEX", "If reading, use SIMPLE"] }),
  });
  assert.match(prompt, /Routing rules:/);
  assert.match(prompt, /If code generation, use COMPLEX/);
  assert.match(prompt, /If reading, use SIMPLE/);
});

test("generateJudgePrompt omits routing rules section when no rules", () => {
  const prompt = generateJudgePrompt({
    userMessage: "hello",
    config: makeConfig({ rules: undefined }),
  });
  assert.ok(!prompt.includes("Routing rules:"));
});

test("generateJudgePrompt includes defaultTier name", () => {
  const prompt = generateJudgePrompt({
    userMessage: "hello",
    config: makeConfig({ defaultTier: "SIMPLE" }),
  });
  assert.match(prompt, /Default tier when uncertain: SIMPLE/);
});

test("generateJudgePrompt embeds user message in triple-quoted block", () => {
  const msg = "Please refactor the authentication module";
  const prompt = generateJudgePrompt({
    userMessage: msg,
    config: makeConfig(),
  });
  assert.ok(prompt.includes(`"""\n${msg}\n"""`));
});

test("generateJudgePrompt includes previousTier context when provided", () => {
  const prompt = generateJudgePrompt({
    userMessage: "继续",
    config: makeConfig(),
    previousTier: "COMPLEX",
  });
  assert.match(prompt, /Previous turn was classified as: COMPLEX/);
  assert.match(prompt, /prefer keeping the previous tier/);
});

test("generateJudgePrompt omits previousTier section when not provided", () => {
  const prompt = generateJudgePrompt({
    userMessage: "hello",
    config: makeConfig(),
  });
  assert.ok(!prompt.includes("Previous turn"));
});

test("generateJudgePrompt omits previousTier section when undefined", () => {
  const prompt = generateJudgePrompt({
    userMessage: "hello",
    config: makeConfig(),
    previousTier: undefined,
  });
  assert.ok(!prompt.includes("Previous turn"));
});
