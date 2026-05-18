import test from "node:test";
import assert from "node:assert/strict";
import { classifyAndRoute } from "../../src/router/tokenSaver/classifyAndRoute.js";
import { generateJudgePrompt } from "../../src/router/tokenSaver/generateJudgePrompt.js";
import type { RouterTokenSaverConfig } from "../../src/router/config/schema.js";
import type { CanonicalModelResponse, ModelRuntime } from "../../src/model/index.js";

type BenchmarkEntry = { instruction: string; expectedTier: string; category: string };

const BENCHMARK: BenchmarkEntry[] = [
  { instruction: "这个函数是做什么的？", expectedTier: "SIMPLE", category: "simple-qa" },
  { instruction: "解释一下这个报错信息", expectedTier: "SIMPLE", category: "simple-qa" },
  { instruction: "帮我把这个变量名从 foo 改成 bar", expectedTier: "SIMPLE", category: "simple-edit" },
  { instruction: "读一下 README.md 的内容", expectedTier: "SIMPLE", category: "simple-edit" },
  { instruction: "写一个 hello world 程序", expectedTier: "SIMPLE", category: "simple-gen" },
  { instruction: "给这个函数加上错误处理", expectedTier: "SIMPLE", category: "medium-code" },
  { instruction: "写一个单元测试覆盖这个类", expectedTier: "SIMPLE", category: "medium-code" },
  { instruction: "重构整个认证模块，从 session 改成 JWT", expectedTier: "COMPLEX", category: "complex-refactor" },
  { instruction: "把这个 monorepo 拆分成三个独立的包", expectedTier: "COMPLEX", category: "complex-refactor" },
  { instruction: "帮我搭建一个完整的 CI/CD 流水线", expectedTier: "COMPLEX", category: "multi-step" },
  { instruction: "设计并实现一个完整的用户注册登录系统", expectedTier: "COMPLEX", category: "multi-step" },
  { instruction: "分析这个代码库的架构，给出改进建议", expectedTier: "COMPLEX", category: "architecture" },
  { instruction: "性能很差，帮我找出瓶颈并优化", expectedTier: "COMPLEX", category: "debug" },
  { instruction: "这个 bug 反复出现，做一次根因分析", expectedTier: "COMPLEX", category: "debug" },
  { instruction: "处理这5个CSV文件，生成分析报告", expectedTier: "COMPLEX", category: "data" },
  { instruction: "帮我弄一下", expectedTier: "SIMPLE", category: "vague" },
  { instruction: "修一下这个 bug: `if (x = 1)` 应该是 `==`", expectedTier: "SIMPLE", category: "simple-fix" },
  { instruction: "（此处省略2000字需求文档）请按照以上需求实现完整系统", expectedTier: "COMPLEX", category: "long-text" },
  { instruction: "先读代码，然后重构成微服务架构", expectedTier: "COMPLEX", category: "mixed" },
  { instruction: "ok", expectedTier: "SIMPLE", category: "boundary" },
];

const CONFIG: RouterTokenSaverConfig = {
  enabled: true,
  judge: { id: "p/j", provider: "p", model: "j" },
  defaultTier: "SIMPLE",
  tiers: {
    SIMPLE: {
      model: { id: "p/cheap", provider: "p", model: "cheap" },
      description: "Simple questions, small edits, single-file changes, quick lookups",
    },
    COMPLEX: {
      model: { id: "p/expensive", provider: "p", model: "expensive" },
      description: "Multi-step tasks, architecture design, large refactors, debugging, data processing pipelines",
    },
  },
  rules: [
    "If the task involves multiple files or multi-step planning, classify as COMPLEX",
    "If the user message is very short or vague, classify as SIMPLE (default)",
    "If the task involves debugging, optimization, or root cause analysis, classify as COMPLEX",
  ],
  judgeTimeoutMs: 5000,
};

test("benchmark: all 20 prompts generate valid judge prompts containing instruction text", () => {
  for (const entry of BENCHMARK) {
    const prompt = generateJudgePrompt({ userMessage: entry.instruction, config: CONFIG });
    assert.ok(
      prompt.includes(entry.instruction),
      `Prompt for "${entry.instruction.slice(0, 30)}..." must contain the instruction`,
    );
    assert.ok(prompt.includes("SIMPLE"), "Prompt must contain SIMPLE tier");
    assert.ok(prompt.includes("COMPLEX"), "Prompt must contain COMPLEX tier");
    assert.ok(prompt.includes("multi-step"), "Prompt must contain tier description keywords");
  }
});

test("benchmark: mock judge returning expected tier yields correct model selection", async () => {
  let callCount = 0;
  for (const entry of BENCHMARK) {
    const mockJudge: ModelRuntime = {
      stream: async function* () { throw new Error("not used"); },
      complete: async (): Promise<CanonicalModelResponse> => {
        callCount++;
        return {
          role: "assistant",
          content: [{ type: "text", text: `<tier>${entry.expectedTier}</tier>` }],
          finishReason: "stop",
        };
      },
      getCapabilities: () => ({
        supportsToolUse: false, supportsStreaming: false, supportsParallelToolCalls: false,
        supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: false,
        supportsPromptCache: false, maxContextTokens: 4096, maxOutputTokens: 256,
      }),
      getMultimodal: () => ({ input: ["text" as const] }),
    };
    const result = await classifyAndRoute({
      config: CONFIG,
      messages: [{ role: "user", content: [{ type: "text", text: entry.instruction }] }],
      judgeRuntime: mockJudge,
    });
    assert.ok(result, `classifyAndRoute must return a result for "${entry.instruction.slice(0, 30)}..."`);
    assert.equal(result.tier, entry.expectedTier, `tier should be ${entry.expectedTier} for "${entry.instruction.slice(0, 30)}..."`);
    assert.equal(result.resolvedFrom, "judge", `resolvedFrom should be judge for "${entry.instruction.slice(0, 30)}..."`);
  }
  assert.equal(callCount, 20);
});

test("benchmark: mock judge returning wrong tier still produces valid pipeline output", async () => {
  const wrongTier = (expected: string) => expected === "SIMPLE" ? "COMPLEX" : "SIMPLE";
  for (const entry of BENCHMARK) {
    const mockJudge: ModelRuntime = {
      stream: async function* () { throw new Error("not used"); },
      complete: async (): Promise<CanonicalModelResponse> => ({
        role: "assistant",
        content: [{ type: "text", text: `<tier>${wrongTier(entry.expectedTier)}</tier>` }],
        finishReason: "stop",
      }),
      getCapabilities: () => ({
        supportsToolUse: false, supportsStreaming: false, supportsParallelToolCalls: false,
        supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: false,
        supportsPromptCache: false, maxContextTokens: 4096, maxOutputTokens: 256,
      }),
      getMultimodal: () => ({ input: ["text" as const] }),
    };
    const result = await classifyAndRoute({
      config: CONFIG,
      messages: [{ role: "user", content: [{ type: "text", text: entry.instruction }] }],
      judgeRuntime: mockJudge,
    });
    assert.ok(result);
    assert.equal(result.resolvedFrom, "judge", `resolvedFrom should be judge for "${entry.instruction.slice(0, 30)}..."`);
    assert.notEqual(result.tier, entry.expectedTier, `tier should differ from expected for "${entry.instruction.slice(0, 30)}..."`);
  }
});

test("benchmark: tier descriptions and rules are included in all generated prompts", () => {
  for (const entry of BENCHMARK) {
    const prompt = generateJudgePrompt({ userMessage: entry.instruction, config: CONFIG });
    assert.ok(prompt.includes("Simple questions, small edits"));
    assert.ok(prompt.includes("Multi-step tasks, architecture design"));
    assert.ok(prompt.includes("Routing rules:"));
    assert.ok(prompt.includes("multiple files or multi-step planning"));
  }
});
