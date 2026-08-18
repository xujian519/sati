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
  ];
  return {
    depth: 0,
    maxSubagentDepth: 1,
    listDefinitions: () => ids.map(id => ({ id, description: id })),
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
