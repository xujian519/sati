import test from "node:test";
import assert from "node:assert/strict";
import { createBashTool } from "../../src/tool/builtin/bash.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { PermissionRuntime, createDefaultPermissionContext } from "../../src/permission/index.js";
import type {
  PilotDeckCommandRunner,
  PilotDeckCommandResult,
  PilotDeckCommandOptions,
} from "../../src/tool/builtin/bash/commandRunner.js";
import type {
  PilotDeckToolProgressEvent,
  PilotDeckToolRuntimeContext,
} from "../../src/tool/index.js";

class StreamingFakeRunner implements PilotDeckCommandRunner {
  constructor(
    private readonly stdoutChunks: string[],
    private readonly stderrChunks: string[] = [],
    private readonly exitCode: number = 0,
  ) {}

  async run(_command: string, options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult> {
    for (const chunk of this.stdoutChunks) {
      options.onStdout?.(chunk);
    }
    for (const chunk of this.stderrChunks) {
      options.onStderr?.(chunk);
    }
    return {
      exitCode: this.exitCode,
      stdout: this.stdoutChunks.join(""),
      stderr: this.stderrChunks.join(""),
      timedOut: false,
      durationMs: 1,
    };
  }
}

const cwd = "/tmp/proj";

function makeContext(progress?: (event: PilotDeckToolProgressEvent) => void): PilotDeckToolRuntimeContext {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "default", canPrompt: true }),
    progress,
  };
}

test("bash forwards each stdout/stderr chunk through progress sink as it arrives", async () => {
  const runner = new StreamingFakeRunner(["hello\n", "world\n"], ["warn\n"]);
  const events: PilotDeckToolProgressEvent[] = [];
  const tool = createBashTool({ runner });
  const result = await tool.execute({ command: "echo hi" }, makeContext((event) => events.push(event)));

  assert.equal(events.length, 3);
  assert.equal(events[0]?.metadata?.stream, "stdout");
  assert.equal(events[0]?.metadata?.chunk, "hello\n");
  assert.equal(events[1]?.metadata?.stream, "stdout");
  assert.equal(events[1]?.metadata?.chunk, "world\n");
  assert.equal(events[2]?.metadata?.stream, "stderr");
  assert.equal(events[2]?.metadata?.chunk, "warn\n");
  for (const event of events) {
    assert.equal(event.sessionId, "session-1");
    assert.equal(event.turnId, "turn-1");
    assert.equal(event.toolName, "bash");
  }
  assert.equal((result.data as { stdout: string }).stdout, "hello\nworld\n");
});

test("bash skips progress when no sink is provided", async () => {
  const runner = new StreamingFakeRunner(["x\n"]);
  const tool = createBashTool({ runner });
  const result = await tool.execute({ command: "echo x" }, makeContext(undefined));
  assert.equal((result.data as { stdout: string }).stdout, "x\n");
});

test("ToolRuntime injects toolCallId / toolName into progress events", async () => {
  const runner = new StreamingFakeRunner(["chunk\n"]);
  const registry = new ToolRegistry();
  registry.register(createBashTool({ runner }));
  const permissionRuntime = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissionRuntime);

  const events: PilotDeckToolProgressEvent[] = [];
  const result = await toolRuntime.execute(
    { id: "call-42", name: "bash", input: { command: "echo chunk" } },
    {
      ...makeContext((event) => events.push(event)),
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({
        cwd,
        mode: "bypassPermissions",
        canPrompt: false,
        bypassAvailable: true,
      }),
    },
  );

  assert.equal(result.type, "success");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.toolCallId, "call-42");
  assert.equal(events[0]?.toolName, "bash");
});

test("bash progress sink errors are swallowed and do not break execution", async () => {
  const runner = new StreamingFakeRunner(["a\n", "b\n"]);
  const tool = createBashTool({ runner });
  let callCount = 0;
  const result = await tool.execute(
    { command: "echo ab" },
    makeContext(() => {
      callCount += 1;
      throw new Error("sink crashed");
    }),
  );
  assert.equal((result.data as { stdout: string }).stdout, "a\nb\n");
  // Sink was invoked twice despite throwing each time.
  assert.equal(callCount, 2);
});
