import test from "node:test";
import assert from "node:assert/strict";
import { SubAgentSession } from "../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS } from "../../src/agent/sub/builtinSubagentTypes.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { ToolRegistry } from "../../src/tool/index.js";
import type { AgentRuntimeConfig, AgentRuntimeDependencies } from "../../src/agent/index.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../src/model/index.js";
import type { RouterDecision } from "../../src/router/index.js";

test("forked subagents inherit model token cap dependencies", async () => {
  const requests: CanonicalModelRequest[] = [];
  const parentConfig: AgentRuntimeConfig = {
    provider: "parent-provider",
    model: "parent-model",
    cwd: "/tmp/pilotdeck-test",
    maxOutputTokens: 65_536,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: "/tmp/pilotdeck-test" }),
  };
  const parentDependencies: AgentRuntimeDependencies = {
    router: {
      async decide(): Promise<RouterDecision> {
        return {
          provider: "sub-provider",
          model: "sub-model",
          scenarioType: "subagent",
          isSubagent: true,
          orchestrating: false,
          resolvedFrom: "scenario",
          mutations: {},
        };
      },
      async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        yield { type: "message_start", role: "assistant" };
        yield {
          type: "text_delta",
          text: "Scope: tested caps\nResult: ok\nKey files: none\nFiles changed: none\nIssues: none",
        };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream(): AsyncIterable<CanonicalModelEvent> {
        throw new Error("not used");
      },
    },
    tools: {
      registry: new ToolRegistry(),
      scheduler: { executeAll: async () => [] },
    },
    getModelTokenLimits: (provider: string, model: string) => {
      if (provider === "sub-provider" && model === "sub-model") {
        return { maxContextTokens: 32_768, maxOutputTokens: 8_192 };
      }
      return { maxContextTokens: 1_000_000, maxOutputTokens: 65_536 };
    },
  } as unknown as AgentRuntimeDependencies;

  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS["general-purpose"],
    directive: "test cap inheritance",
    parentConfig,
    parentDependencies,
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "sub-session",
    subagentId: "sub-1",
  });
  const report = await session.run();

  assert.equal(report.markdown.includes("Result: ok"), true);
  assert.equal(requests[0]?.provider, "sub-provider");
  assert.equal(requests[0]?.model, "sub-model");
  assert.equal(requests[0]?.maxOutputTokens, 8_192);
});
