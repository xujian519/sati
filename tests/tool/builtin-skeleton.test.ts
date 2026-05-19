import test from "node:test";
import assert from "node:assert/strict";
import {
  __setWebFetchHookForTesting,
  buildMcpToolWireName,
  clearWebFetchCache,
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
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

test("ask_user_question without elicitation channel returns unsupported_tool", async (t) => {
  // B1 design: askUserQuestion is read-only so default-mode permission lets
  // it through; the elicitation channel is the actual gate. Without one, the
  // tool reports `unsupported_tool` (legacy parity: same code path used when
  // the SDK consumer hasn't wired any prompt UI).
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createAskUserQuestionTool()],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute(
    {
      id: "call-1",
      name: "ask_user_question",
      input: {
        questions: [
          {
            question: "Which?",
            header: "Pick",
            options: [
              { label: "A", description: "first" },
              { label: "B", description: "second" },
            ],
          },
        ],
      },
    },
    context,
  );

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "unsupported_tool");
});

test("web skeleton tools ask for network permission without provider execution", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createWebFetchTool(), createWebSearchTool()],
    cwd: workspace.cwd,
  });

  const fetchResult = await toolRuntime.execute(
    {
      id: "call-1",
      name: "web_fetch",
      input: { url: "https://example.com", prompt: "summarize" },
    },
    context,
  );
  const searchResult = await toolRuntime.execute(
    { id: "call-2", name: "web_search", input: { query: "pilotdeck" } },
    context,
  );

  assert.equal(fetchResult.type, "error");
  assert.equal(searchResult.type, "error");
  if (fetchResult.type === "error") assert.equal(fetchResult.error.code, "permission_required");
  if (searchResult.type === "error") assert.equal(searchResult.error.code, "permission_required");
});

test("web skeleton tools execute in plan mode without permission_required", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  clearWebFetchCache();
  __setWebFetchHookForTesting(async () => ({
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/html" },
    arrayBuffer: async () => new TextEncoder().encode("<h1>Hello</h1><p>world</p>").buffer,
  }));
  t.after(() => {
    clearWebFetchCache();
    __setWebFetchHookForTesting(null);
  });
  const fakeSearchFetch: typeof fetch = (async () =>
    new Response(
      JSON.stringify({
        search_result: [{ title: "Found", link: "https://x.example", content: "yes" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [
      createWebFetchTool(),
      createWebSearchTool({ apiKey: "test-key", fetchImpl: fakeSearchFetch }),
    ],
    cwd: workspace.cwd,
    permissionMode: "plan",
    canPrompt: false,
  });

  const fetchResult = await toolRuntime.execute(
    {
      id: "call-1",
      name: "web_fetch",
      input: { url: "https://example.com", prompt: "summarize" },
    },
    context,
  );
  const searchResult = await toolRuntime.execute(
    { id: "call-2", name: "web_search", input: { query: "pilotdeck" } },
    context,
  );

  assert.equal(fetchResult.type, "success");
  assert.equal(searchResult.type, "success");
});

test("mcp tool uses stable wire names and standard unsupported behavior", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const tool = createMcpTool({ serverId: "my-server", toolName: "read thing" });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
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
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const tool = createMcpTool({
    serverId: "server",
    toolName: "lookup",
    adapter: {
      callTool: async (serverId, toolName, input) => ({ serverId, toolName, input, ok: true }),
    },
  });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
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
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
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
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const adapter = {
    listResources: async (serverId?: string) => ({ serverId, resources: ["resource://x"] }),
    readResource: async (serverId: string, uri: string) => ({ serverId, uri, text: "value" }),
  };
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
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
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createStructuredOutputTool(), createEnterPlanModeTool(), createExitPlanModeTool()],
    cwd: workspace.cwd,
    canPrompt: true,
    elicitation: {
      askUser: async () => ({
        type: "answered",
        answers: { "What should happen next?": "execute_plan" },
      }),
    },
  });
  const planFilePath = `${workspace.cwd}/.pilotdeck/plans/test-session.md`;
  await workspace.write(".pilotdeck/plans/test-session.md", "Do the work.\n");
  context.planDirectory = {
    path: `${workspace.cwd}/.pilotdeck/plans`,
    resolve: (filePath) => filePath === "test-session.md" || filePath === planFilePath ? planFilePath : undefined,
    read: (filePath) => filePath === "test-session.md" || filePath === planFilePath ? "Do the work." : undefined,
  };

  const structured = await toolRuntime.execute(
    { id: "call-1", name: "structured_output", input: { value: { ok: true } } },
    context,
  );
  const enter = await toolRuntime.execute({ id: "call-2", name: "enter_plan_mode", input: {} }, context);
  const exit = await toolRuntime.execute(
    { id: "call-3", name: "exit_plan_mode", input: { plan_file_path: "test-session.md" } },
    context,
  );

  assert.equal(structured.type, "success");
  assert.equal(enter.type, "success");
  assert.equal(exit.type, "success");
  const executeText = exit.type === "success"
    ? exit.content.map((item) => ("text" in item ? item.text : "")).join("\n")
    : "";
  assert.equal(
    exit.type === "success" ? (exit.data as { requestedMode?: string } | undefined)?.requestedMode : undefined,
    "default",
  );
  assert.match(executeText, /User has approved your plan/i);
  assert.match(executeText, /start coding/i);
  assert.match(executeText, /## Approved Plan/i);
  assert.match(enter.type === "success" ? enter.content.map((item) => ("text" in item ? item.text : "")).join("\n") : "", /## Plan Directory/i);
});

test("exit_plan_mode keeps plan mode when user wants more planning", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createExitPlanModeTool()],
    cwd: workspace.cwd,
    canPrompt: true,
    elicitation: {
      askUser: async () => ({
        type: "answered",
        answers: { "What should happen next?": "continue_planning" },
        annotations: {
          "What should happen next?": {
            notes: "Add a test plan section.",
          },
        },
      }),
    },
  });
  const planFilePath = `${workspace.cwd}/.pilotdeck/plans/test-session.md`;
  await workspace.write(".pilotdeck/plans/test-session.md", "Draft plan\n");
  context.planDirectory = {
    path: `${workspace.cwd}/.pilotdeck/plans`,
    resolve: (filePath) => filePath === "test-session.md" || filePath === planFilePath ? planFilePath : undefined,
    read: (filePath) => filePath === "test-session.md" || filePath === planFilePath ? "Draft plan" : undefined,
  };

  const exit = await toolRuntime.execute(
    { id: "call-1", name: "exit_plan_mode", input: { plan_file_path: "test-session.md" } },
    context,
  );

  assert.equal(exit.type, "success");
  const data = exit.type === "success" ? (exit.data as {
    requestedMode?: string;
    action?: string;
    feedback?: string;
  } | undefined) : undefined;
  const continueText = exit.type === "success"
    ? exit.content.map((item) => ("text" in item ? item.text : "")).join("\n")
    : "";
  assert.equal(data?.requestedMode, undefined);
  assert.equal(data?.action, "continue_planning");
  assert.equal(data?.feedback, "Add a test plan section.");
  assert.match(continueText, /continue planning before implementation/i);
  assert.match(continueText, /Stay in plan mode/i);
  assert.match(continueText, /User feedback:\nAdd a test plan section\./i);
});

test("exit_plan_mode rejects invalid or empty submitted plan files", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createExitPlanModeTool()],
    cwd: workspace.cwd,
    canPrompt: true,
    elicitation: {
      askUser: async () => ({
        type: "answered",
        answers: { "What should happen next?": "execute_plan" },
      }),
    },
  });
  await workspace.write(".pilotdeck/plans/empty.md", "\n");
  context.planDirectory = {
    path: `${workspace.cwd}/.pilotdeck/plans`,
    resolve: (filePath) => {
      if (filePath === "empty.md") return `${workspace.cwd}/.pilotdeck/plans/empty.md`;
      if (filePath === "missing.md") return `${workspace.cwd}/.pilotdeck/plans/missing.md`;
      return undefined;
    },
    read: () => undefined,
  };

  const outside = await toolRuntime.execute(
    { id: "call-1", name: "exit_plan_mode", input: { plan_file_path: "../README.md" } },
    context,
  );
  const empty = await toolRuntime.execute(
    { id: "call-2", name: "exit_plan_mode", input: { plan_file_path: "empty.md" } },
    context,
  );
  const missing = await toolRuntime.execute(
    { id: "call-3", name: "exit_plan_mode", input: { plan_file_path: "missing.md" } },
    context,
  );

  assert.equal(outside.type, "error");
  assert.equal(empty.type, "error");
  assert.equal(missing.type, "error");
  if (outside.type === "error") {
    assert.equal(outside.error.code, "invalid_tool_input");
    assert.match(outside.content[0]?.type === "text" ? outside.content[0].text : "", /must point to a markdown file/i);
  }
  if (empty.type === "error") {
    assert.equal(empty.error.code, "invalid_tool_input");
    assert.match(empty.content[0]?.type === "text" ? empty.content[0].text : "", /Plan file is empty/i);
  }
  if (missing.type === "error") {
    assert.equal(missing.error.code, "invalid_tool_input");
    assert.match(
      missing.content[0]?.type === "text" ? missing.content[0].text : "",
      /does not exist or could not be read/i,
    );
  }
});

test("enter_plan_mode returns an error when already in plan mode", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createEnterPlanModeTool()],
    cwd: workspace.cwd,
    permissionMode: "plan",
  });
  context.planDirectory = {
    path: `${workspace.cwd}/.pilotdeck/plans`,
    resolve: () => undefined,
    read: () => undefined,
  };

  const result = await toolRuntime.execute(
    { id: "call-1", name: "enter_plan_mode", input: {} },
    context,
  );

  assert.equal(result.type, "error");
  assert.equal(result.error.code, "tool_execution_failed");
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Plan mode is already active/i);
});
