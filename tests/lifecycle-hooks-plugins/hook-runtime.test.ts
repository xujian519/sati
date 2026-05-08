import test from "node:test";
import assert from "node:assert/strict";
import { LifecycleRuntime } from "../../src/lifecycle/index.js";
import {
  AgentHookExecutor,
  AsyncHookRegistry,
  CallbackHookExecutor,
  CommandHookExecutor,
  HookExecutionEventBus,
  HookRuntime,
  HttpHookExecutor,
  PromptHookExecutor,
} from "../../src/extension/index.js";
import type { PolitDeckHooksSettings } from "../../src/extension/index.js";

test("command hook success can produce additional context effects", async () => {
  const settings: PolitDeckHooksSettings = {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: `node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'ctx'}}))"`,
          },
        ],
      },
    ],
  };
  const lifecycle = new LifecycleRuntime(new HookRuntime(settings));

  const result = await lifecycle.dispatch({
    event: "SessionStart",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd() },
    payload: { source: "startup" },
    matchQuery: "SessionStart",
  });

  assert.deepEqual(result.effects, [{ type: "additional_context", content: "ctx", source: "command" }]);
  assert.equal(result.messages.length, 1);
});

test("command hook exit code 2 produces blocking effect", async () => {
  const settings: PolitDeckHooksSettings = {
    PreToolUse: [
      {
        matcher: "bash",
        hooks: [{ type: "command", command: `node -e "console.error('blocked'); process.exit(2)"` }],
      },
    ],
  };
  const lifecycle = new LifecycleRuntime(new HookRuntime(settings));

  const result = await lifecycle.dispatch({
    event: "PreToolUse",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd() },
    payload: { toolName: "bash", toolInput: { command: "rm" }, toolUseId: "toolu_1" },
    matchQuery: "bash",
  });

  assert.equal(result.blockingErrors.length, 1);
  assert.equal(result.effects.some((effect) => effect.type === "block"), true);
});

test("command hook non-2 failure is non-blocking", async () => {
  const settings: PolitDeckHooksSettings = {
    PostToolUse: [
      {
        matcher: "read_file",
        hooks: [{ type: "command", command: `node -e "console.error('warn'); process.exit(1)"` }],
      },
    ],
  };
  const lifecycle = new LifecycleRuntime(new HookRuntime(settings));

  const result = await lifecycle.dispatch({
    event: "PostToolUse",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd() },
    payload: { toolName: "read_file", toolInput: {}, toolUseId: "toolu_1" },
    matchQuery: "read_file",
  });

  assert.equal(result.blockingErrors.length, 0);
  assert.equal(result.nonBlockingErrors.length, 1);
});

test("prompt hook can use an injected evaluator", async () => {
  const settings: PolitDeckHooksSettings = {
    UserPromptSubmit: [
      {
        hooks: [{ type: "prompt", prompt: "check $ARGUMENTS" }],
      },
    ],
  };
  const runtime = new HookRuntime(
    settings,
    new CommandHookExecutor(),
    new HookExecutionEventBus(),
    new AsyncHookRegistry(),
    new PromptHookExecutor(async ({ prompt }) => {
      assert.match(prompt, /UserPromptSubmit/u);
      return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "prompt ctx" } });
    }),
  );
  const lifecycle = new LifecycleRuntime(runtime);

  const result = await lifecycle.dispatch({
    event: "UserPromptSubmit",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd() },
    payload: { prompt: "hello" },
  });

  assert.deepEqual(result.effects, [{ type: "additional_context", content: "prompt ctx", source: "prompt" }]);
});

test("http hook posts hook input and resolves allowed environment headers", async () => {
  const requests: Array<{ url: string; headers: Headers; body: string }> = [];
  const settings: PolitDeckHooksSettings = {
    Notification: [
      {
        hooks: [
          {
            type: "http",
            url: "https://example.test/hook",
            headers: { authorization: "Bearer $TOKEN", ignored: "$SECRET" },
            allowedEnvVars: ["TOKEN"],
          },
        ],
      },
    ],
  };
  const runtime = new HookRuntime(
    settings,
    new CommandHookExecutor(),
    new HookExecutionEventBus(),
    new AsyncHookRegistry(),
    new PromptHookExecutor(),
    new HttpHookExecutor(async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response(JSON.stringify({ hookSpecificOutput: { hookEventName: "Notification", additionalContext: "http ctx" } }));
    }),
  );
  const lifecycle = new LifecycleRuntime(runtime);

  const result = await lifecycle.dispatch({
    event: "Notification",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd() },
    payload: { message: "hi" },
    env: { TOKEN: "token", SECRET: "secret" },
  });

  assert.equal(requests[0]?.url, "https://example.test/hook");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer token");
  assert.equal(requests[0]?.headers.get("ignored"), "");
  assert.match(requests[0]?.body ?? "", /Notification/u);
  assert.deepEqual(result.effects, [{ type: "additional_context", content: "http ctx", source: "http" }]);
});

test("agent hook can use an injected runner", async () => {
  const settings: PolitDeckHooksSettings = {
    PostToolUse: [
      {
        matcher: "read_file",
        hooks: [{ type: "agent", prompt: "verify $ARGUMENTS" }],
      },
    ],
  };
  const runtime = new HookRuntime(
    settings,
    new CommandHookExecutor(),
    new HookExecutionEventBus(),
    new AsyncHookRegistry(),
    new PromptHookExecutor(),
    new HttpHookExecutor(),
    new AgentHookExecutor(async ({ prompt }) => {
      assert.match(prompt, /read_file/u);
      return JSON.stringify({ continue: false, stopReason: "agent block" });
    }),
  );
  const lifecycle = new LifecycleRuntime(runtime);

  const result = await lifecycle.dispatch({
    event: "PostToolUse",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd() },
    payload: { toolName: "read_file", toolInput: {}, toolUseId: "toolu_1" },
    matchQuery: "read_file",
  });

  assert.deepEqual(result.effects, [{ type: "block", reason: "agent block", stopReason: "agent block" }]);
});

test("async hook registry collects later sync responses", () => {
  const registry = new AsyncHookRegistry();
  registry.register({
    id: "hook-1",
    hookName: "command",
    hookEvent: "SessionStart",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "late" } }),
    stderr: "",
    responseDelivered: false,
  });

  const responses = registry.collectResponses();

  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.output.type, "sync");
  assert.equal(registry.list()[0]?.responseDelivered, true);
  registry.removeDelivered();
  assert.deepEqual(registry.list(), []);
});

test("callback hook runs registered runtime callback", async () => {
  const callbackExecutor = new CallbackHookExecutor();
  callbackExecutor.register("session-callback", ({ hookInput }) => {
    assert.equal(hookInput.hookEventName, "SessionStart");
    return { type: "sync", specific: { hookEventName: "SessionStart", additionalContext: "callback ctx" } };
  });
  const runtime = new HookRuntime(
    {
      SessionStart: [{ hooks: [{ type: "callback", name: "session-callback" }] }],
    },
    new CommandHookExecutor(),
    new HookExecutionEventBus(),
    new AsyncHookRegistry(),
    new PromptHookExecutor(),
    new HttpHookExecutor(),
    new AgentHookExecutor(),
    callbackExecutor,
  );
  const lifecycle = new LifecycleRuntime(runtime);

  const result = await lifecycle.dispatch({
    event: "SessionStart",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd() },
    payload: { source: "startup" },
  });

  assert.deepEqual(result.effects, [{ type: "additional_context", content: "callback ctx", source: "callback" }]);
});

test("WorktreeCreate hook can return worktree path effect", async () => {
  const lifecycle = new LifecycleRuntime(new HookRuntime({
    WorktreeCreate: [
      {
        hooks: [
          {
            type: "command",
            command: `node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'WorktreeCreate',worktreePath:'/tmp/worktree'}}))"`,
          },
        ],
      },
    ],
  }));

  const result = await lifecycle.dispatch({
    event: "WorktreeCreate",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd() },
    payload: { name: "feature" },
    matchQuery: "WorktreeCreate",
  });

  assert.deepEqual(result.effects, [{ type: "worktree_path", path: "/tmp/worktree" }]);
});

test("SubagentStop hook dispatches through lifecycle runtime", async () => {
  const lifecycle = new LifecycleRuntime(new HookRuntime({
    SubagentStop: [
      {
        hooks: [
          {
            type: "command",
            command: `node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SubagentStop',additionalContext:'subagent done'}}))"`,
          },
        ],
      },
    ],
  }));

  const result = await lifecycle.dispatch({
    event: "SubagentStop",
    baseInput: { sessionId: "s", transcriptPath: "", cwd: process.cwd(), agentId: "agent-1" },
    payload: { stopHookActive: false, agentTranscriptPath: "/tmp/agent.jsonl" },
    matchQuery: "SubagentStop",
  });

  assert.deepEqual(result.effects, [{ type: "additional_context", content: "subagent done", source: "command" }]);
});

test("asyncRewake response is marked when later output blocks", () => {
  const registry = new AsyncHookRegistry();
  registry.register({
    id: "hook-1",
    hookName: "command",
    hookEvent: "Stop",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    stdout: JSON.stringify({ continue: false, stopReason: "wake" }),
    stderr: "",
    responseDelivered: false,
    asyncRewake: true,
  });

  assert.equal(registry.collectResponses()[0]?.rewake, true);
});
