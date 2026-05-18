import test from "node:test";
import assert from "node:assert/strict";
import { createAgentTool } from "../../../src/tool/builtin/agent.js";
import {
  PilotDeckToolRuntimeError,
  type PilotDeckSubagentForkApi,
  type PilotDeckToolRuntimeContext,
} from "../../../src/tool/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";

const cwd = "/tmp/proj";

function buildFork(opts: {
  depth: number;
  maxSubagentDepth: number;
  forkImpl?: PilotDeckSubagentForkApi["fork"];
}): PilotDeckSubagentForkApi {
  return {
    depth: opts.depth,
    maxSubagentDepth: opts.maxSubagentDepth,
    listDefinitions: () => [
      { id: "general-purpose", description: "" },
      { id: "explore", description: "" },
      { id: "plan", description: "" },
    ],
    isAllowedDefinition: (id) =>
      ["general-purpose", "explore", "plan"].includes(id),
    fork:
      opts.forkImpl ??
      (async () => ({
        markdown: "ok",
        usage: {},
        turns: 1,
        durationMs: 1,
      })),
  };
}

function makeContext(fork: PilotDeckSubagentForkApi, depth: number): PilotDeckToolRuntimeContext {
  return {
    sessionId: "s",
    turnId: "t",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "default", canPrompt: false }),
    subagent: fork,
    subagentDepth: depth,
  };
}

test("C2.depth fork allowed at depth 0 < max 1", async () => {
  const fork = buildFork({ depth: 0, maxSubagentDepth: 1 });
  const tool = createAgentTool();
  const out = await tool.execute(
    { description: "x", prompt: "go", subagent_type: "general-purpose" },
    makeContext(fork, 0),
  );
  assert.match((out.content[0] as { text: string }).text, /\[general-purpose\] x/);
});

test("C2.depth subagent_depth_exceeded at depth 1 >= max 1", async () => {
  const fork = buildFork({ depth: 1, maxSubagentDepth: 1 });
  const tool = createAgentTool();
  await assert.rejects(
    () =>
      tool.execute(
        { description: "x", prompt: "go", subagent_type: "general-purpose" },
        makeContext(fork, 1),
      ),
    (err: unknown) =>
      err instanceof PilotDeckToolRuntimeError &&
      err.code === "tool_execution_failed" &&
      /subagent_depth_exceeded/.test(err.message),
  );
});

test("C2.depth invalid subagent_type → invalid_tool_input", async () => {
  const fork = buildFork({ depth: 0, maxSubagentDepth: 1 });
  const tool = createAgentTool();
  await assert.rejects(
    () =>
      tool.execute(
        { description: "x", prompt: "go", subagent_type: "nope" },
        makeContext(fork, 0),
      ),
    (err: unknown) =>
      err instanceof PilotDeckToolRuntimeError && err.code === "invalid_tool_input",
  );
});

test("C2.depth fork-mode metadata reports forkMode=full", async () => {
  const fork = buildFork({ depth: 0, maxSubagentDepth: 1 });
  const tool = createAgentTool();
  const out = await tool.execute(
    { description: "x", prompt: "go", subagent_type: "explore" },
    makeContext(fork, 0),
  );
  assert.equal(out.metadata?.forkMode, "full");
});

test("C2.depth full-fork normalizes legacy general_purpose to general-purpose", async () => {
  const fork = buildFork({ depth: 0, maxSubagentDepth: 1 });
  const tool = createAgentTool();
  const out = await tool.execute(
    { description: "x", prompt: "go", subagent_type: "general_purpose" },
    makeContext(fork, 0),
  );
  assert.match((out.content[0] as { text: string }).text, /\[general-purpose\] x/);
  assert.equal(out.metadata?.subagent, "general-purpose");
});
