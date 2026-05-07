import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMcpToolWireName,
  createAskUserQuestionTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createListMcpResourcesTool,
  createMcpTool,
  createReadMcpResourceTool,
  createStructuredOutputTool,
  createWebFetchTool,
  createWebSearchTool,
} from "../../src/tool/index.js";
import { createPolitDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

test("ask_user_question requires a prompt adapter", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createAskUserQuestionTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    {
      id: "call-1",
      name: "ask_user_question",
      input: { questions: [{ id: "q", prompt: "Pick", options: [{ id: "a", label: "A" }] }] },
    },
    context,
  );

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "permission_required");
});

test("web skeleton tools ask for network permission without provider execution", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createWebFetchTool(), createWebSearchTool()],
    cwd: workspace.cwd,
  });

  const fetchResult = await toolRuntime.execute(
    { id: "call-1", name: "web_fetch", input: { url: "https://example.com" } },
    context,
  );
  const searchResult = await toolRuntime.execute(
    { id: "call-2", name: "web_search", input: { query: "politdeck" } },
    context,
  );

  assert.equal(fetchResult.type, "error");
  assert.equal(searchResult.type, "error");
  if (fetchResult.type === "error") assert.equal(fetchResult.error.code, "permission_required");
  if (searchResult.type === "error") assert.equal(searchResult.error.code, "permission_required");
});

test("mcp tool uses stable wire names and standard unsupported behavior", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const tool = createMcpTool({ serverId: "my-server", toolName: "read thing" });
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [tool],
    cwd: workspace.cwd,
  });

  assert.equal(buildMcpToolWireName("my-server", "read thing"), "mcp__my_server__read_thing");

  const result = await toolRuntime.execute(
    { id: "call-1", name: "mcp__my_server__read_thing", input: {} },
    context,
  );

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "unsupported_tool");
});

test("mcp tool delegates to an adapter when configured", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const tool = createMcpTool({
    serverId: "server",
    toolName: "lookup",
    adapter: {
      callTool: async (serverId, toolName, input) => ({ serverId, toolName, input, ok: true }),
    },
  });
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [tool],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    { id: "call-1", name: "mcp__server__lookup", input: { id: "123" } },
    context,
  );

  assert.equal(result.type, "success");
  assert.deepEqual(result.data, { serverId: "server", toolName: "lookup", input: { id: "123" }, ok: true });
  assert.equal(result.metadata?.mcp && typeof result.metadata.mcp === "object", true);
});

test("mcp resource skeleton tools return unsupported without adapter", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createListMcpResourcesTool(), createReadMcpResourceTool()],
    cwd: workspace.cwd,
  });

  const listResult = await toolRuntime.execute(
    { id: "call-1", name: "list_mcp_resources", input: {} },
    context,
  );
  const readResult = await toolRuntime.execute(
    { id: "call-2", name: "read_mcp_resource", input: { serverId: "s", uri: "resource://x" } },
    context,
  );

  assert.equal(listResult.type, "error");
  assert.equal(readResult.type, "error");
  if (listResult.type === "error") assert.equal(listResult.error.code, "unsupported_tool");
  if (readResult.type === "error") assert.equal(readResult.error.code, "unsupported_tool");
});

test("mcp resource tools delegate to adapters when configured", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const adapter = {
    listResources: async (serverId?: string) => ({ serverId, resources: ["resource://x"] }),
    readResource: async (serverId: string, uri: string) => ({ serverId, uri, text: "value" }),
  };
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createListMcpResourcesTool(adapter), createReadMcpResourceTool(adapter)],
    cwd: workspace.cwd,
  });

  const listResult = await toolRuntime.execute(
    { id: "call-1", name: "list_mcp_resources", input: { serverId: "s" } },
    context,
  );
  const readResult = await toolRuntime.execute(
    { id: "call-2", name: "read_mcp_resource", input: { serverId: "s", uri: "resource://x" } },
    context,
  );

  assert.equal(listResult.type, "success");
  assert.equal(readResult.type, "success");
  assert.deepEqual(listResult.type === "success" ? listResult.data : undefined, {
    serverId: "s",
    resources: ["resource://x"],
  });
  assert.deepEqual(readResult.type === "success" ? readResult.data : undefined, {
    serverId: "s",
    uri: "resource://x",
    text: "value",
  });
});

test("structured_output and plan skeleton tools produce stable results", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createStructuredOutputTool(), createEnterPlanModeTool(), createExitPlanModeTool()],
    cwd: workspace.cwd,
    canPrompt: true,
  });

  const structured = await toolRuntime.execute(
    { id: "call-1", name: "structured_output", input: { value: { ok: true } } },
    context,
  );
  const enter = await toolRuntime.execute({ id: "call-2", name: "enter_plan_mode", input: {} }, context);
  const exit = await toolRuntime.execute(
    { id: "call-3", name: "exit_plan_mode", input: { plan: "Do the work." } },
    context,
  );

  assert.equal(structured.type, "success");
  assert.equal(enter.type, "success");
  assert.equal(exit.type, "success");
});
