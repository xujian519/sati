import test from "node:test";
import assert from "node:assert/strict";
import { createAgentTool } from "../../../src/tool/builtin/agent.js";
import type { SatiSubagentForkApi, SatiToolModelClient, SatiToolRuntimeContext } from "../../../src/tool/index.js";

function baseContext(
  fork: SatiSubagentForkApi,
  overrides: Partial<SatiToolRuntimeContext> = {},
): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    subagent: fork,
    ...overrides,
  };
}

function createFork(calls: string[]): SatiSubagentForkApi {
  return {
    depth: 0,
    maxSubagentDepth: 1,
    listDefinitions: () => [
      { id: "general-purpose", description: "general" },
      { id: "explore", description: "explore" },
      { id: "plan", description: "plan" },
      { id: "verify", description: "verify" },
    ],
    isAllowedDefinition: id => ["general-purpose", "explore", "plan", "verify"].includes(id),
    fork: async ({ definitionId }) => {
      calls.push(definitionId);
      return {
        markdown: "Scope: test\nResult: ok\nKey files: none\nFiles changed: none\nIssues: none",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        turns: 1,
        durationMs: 1,
        parsed: undefined,
      };
    },
  };
}

const READ_ONLY_ROLES = new Set([
  "patent-novelty-checker",
  "patent-creativity-checker",
  "patent-infringement-checker",
  "patent-invalidity-checker",
  "patent-quality-checker",
  "patent-reviewer",
  "adversarial-reviewer",
]);

/** 注册了 patent-* 角色的 fork（cap01 手册别名测试用）。 */
function createPatentRoleFork(calls: string[]): SatiSubagentForkApi {
  const ids = [
    "general-purpose",
    "explore",
    "plan",
    "verify",
    "patent-analyzer",
    "patent-novelty-checker",
    "patent-creativity-checker",
    "patent-infringement-checker",
    "patent-invalidity-checker",
    "patent-retriever",
    "patent-quality-checker",
    "patent-reviewer",
    "adversarial-reviewer",
  ];
  return {
    depth: 0,
    maxSubagentDepth: 1,
    listDefinitions: () => ids.map(id => ({ id, description: id, readOnly: READ_ONLY_ROLES.has(id) })),
    isAllowedDefinition: id => ids.includes(id),
    fork: async ({ definitionId }) => {
      calls.push(definitionId);
      return {
        markdown: "Scope: test\nResult: ok\nKey files: none\nFiles changed: none\nIssues: none",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        turns: 1,
        durationMs: 1,
        parsed: undefined,
      };
    },
  };
}

test("agent tool accepts explorer as an alias for explore", async () => {
  const calls: string[] = [];
  const tool = createAgentTool();
  const result = await tool.execute(
    { description: "inspect code", prompt: "inspect", subagent_type: "explorer" },
    baseContext(createFork(calls)),
  );

  assert.equal(result.data?.subagentType, "explore");
  assert.deepEqual(calls, ["explore"]);
});

test("agent tool maps cap01 manual names to registered patent roles", async () => {
  // cap01-orchestrator.md §3.5 的下划线命名 → skills 注册的 kebab 角色名。
  const cases: Array<[string, string]> = [
    ["technical_analyzer", "patent-analyzer"],
    ["novelty_checker", "patent-novelty-checker"],
    ["creativity_checker", "patent-creativity-checker"],
    ["infringement_checker", "patent-infringement-checker"],
    ["invalidity_checker", "patent-invalidity-checker"],
    ["retriever", "patent-retriever"],
    ["quality_checker", "patent-quality-checker"],
    ["reviewer", "patent-reviewer"],
  ];
  for (const [manual, registered] of cases) {
    const calls: string[] = [];
    const tool = createAgentTool();
    const result = await tool.execute(
      { description: "patent task", prompt: "analyze", subagent_type: manual },
      baseContext(createPatentRoleFork(calls)),
    );
    assert.equal(result.data?.subagentType, registered, `"${manual}" 应映射为 ${registered}`);
    assert.deepEqual(calls, [registered], `fork 应以注册名 ${registered} 调度`);
  }
});

test("agent tool rejects unknown subagent_type with available list", async () => {
  const tool = createAgentTool();
  await assert.rejects(
    () =>
      tool.execute(
        { description: "bad", prompt: "x", subagent_type: "no_such_type" },
        baseContext(createPatentRoleFork([])),
      ),
    /Unknown subagent_type "no_such_type"/,
  );
});

test("agent tool defaults general-purpose to explore in ask mode", async () => {
  const calls: string[] = [];
  const tool = createAgentTool();
  const result = await tool.execute(
    { description: "inspect code", prompt: "inspect" },
    baseContext(createFork(calls), { runMode: "ask" }),
  );

  assert.equal(result.data?.subagentType, "explore");
  assert.deepEqual(calls, ["explore"]);
});

test("agent tool preserves unknown custom fallback subagent names", async () => {
  const requests: string[] = [];
  const model: SatiToolModelClient = {
    async *stream(request) {
      requests.push(String(request.metadata?.subagent));
      yield { type: "text_delta", text: "custom ok" };
    },
  };
  const tool = createAgentTool({
    model,
    subagents: {
      CustomAgent: {
        type: "general-purpose",
        description: "custom",
        systemPrompt: "custom",
      },
    },
  });

  const result = await tool.execute(
    { description: "custom run", prompt: "run", subagent_type: " CustomAgent " },
    {
      sessionId: "s1",
      turnId: "t1",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      permissionContext: {
        mode: "bypassPermissions",
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: true,
        bypassAvailable: true,
        rules: { allow: [], deny: [], ask: [] },
      },
    },
  );

  assert.equal(result.data?.subagentType, "CustomAgent");
  assert.deepEqual(requests, ["general-purpose"]);
});

test("general-purpose + prompt 委派只读角色 → 拒绝并提示改用 subagent_type", async () => {
  const calls: string[] = [];
  const tool = createAgentTool();
  await assert.rejects(
    () =>
      tool.execute(
        {
          description: "adversarial review",
          prompt: "你是 adversarial-reviewer，请对这份权利要求书做红队评审。",
          subagent_type: "general-purpose",
        },
        baseContext(createPatentRoleFork(calls)),
      ),
    error =>
      error instanceof Error &&
      /read-only role "adversarial-reviewer"/.test(error.message) &&
      /subagent_type/.test(error.message),
  );
  assert.deepEqual(calls, [], "拒绝后不得启动 fork");
});

test("general-purpose + 仅提及角色名（非委派）→ 不误伤", async () => {
  const calls: string[] = [];
  const tool = createAgentTool();
  const result = await tool.execute(
    {
      description: "apply checklist",
      prompt: "参照 patent-reviewer 的审查清单检查格式问题。",
      subagent_type: "general-purpose",
    },
    baseContext(createPatentRoleFork(calls)),
  );

  assert.equal(result.data?.subagentType, "general-purpose");
  assert.deepEqual(calls, ["general-purpose"]);
});

test("正确 subagent_type + 角色化 prompt → 按只读角色调度", async () => {
  const calls: string[] = [];
  const tool = createAgentTool();
  const result = await tool.execute(
    {
      description: "adversarial review",
      prompt: "你是 adversarial-reviewer，请做红队评审。",
      subagent_type: "adversarial-reviewer",
    },
    baseContext(createPatentRoleFork(calls)),
  );

  assert.equal(result.data?.subagentType, "adversarial-reviewer");
  assert.deepEqual(calls, ["adversarial-reviewer"]);
});

function createBudgetFork(captured: Array<Record<string, unknown>>): SatiSubagentForkApi {
  const ids = ["general-purpose", "patent-reviewer"];
  return {
    depth: 0,
    maxSubagentDepth: 1,
    listDefinitions: () => ids.map(id => ({ id, description: id, readOnly: id === "patent-reviewer" })),
    isAllowedDefinition: id => ids.includes(id),
    fork: async args => {
      captured.push({ maxTurns: args.maxTurns, maxToolCalls: args.maxToolCalls, timeoutMs: args.timeoutMs });
      return {
        markdown: "Scope: review\nResult: half done\nKey files: none\nFiles changed: none\nIssues: truncated",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        turns: 3,
        durationMs: 42,
        stopReason: "max_tool_calls",
        partial: true,
        toolCalls: 9,
      };
    },
  };
}

test("复核预算透传给 fork，部分结果显式标注 partial", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const tool = createAgentTool();
  const result = await tool.execute(
    {
      description: "review",
      prompt: "review claims",
      subagent_type: "patent-reviewer",
      max_turns: 8,
      max_tool_calls: 24,
      timeout_ms: 600_000,
    },
    baseContext(createBudgetFork(captured)),
  );

  assert.deepEqual(captured, [{ maxTurns: 8, maxToolCalls: 24, timeoutMs: 600_000 }]);
  assert.equal(result.data?.stopReason, "max_tool_calls");
  assert.equal(result.data?.partial, true);
  assert.equal(result.data?.toolCalls, 9);
  const text = result.content.find(block => block.type === "text");
  assert.ok(text?.type === "text" && text.text.includes("[partial: max_tool_calls; turns=3; toolCalls=9]"));
  assert.equal(result.metadata?.partial, true);
});

test("非法预算值按 invalid_tool_input 拒绝", async () => {
  const tool = createAgentTool();
  await assert.rejects(
    () =>
      tool.execute(
        { description: "review", prompt: "review", subagent_type: "patent-reviewer", max_tool_calls: 0 },
        baseContext(createBudgetFork([])),
      ),
    /max_tool_calls must be a positive integer/,
  );
});
