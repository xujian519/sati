import test from "node:test";
import assert from "node:assert/strict";
import {
  createBashTool,
  type PilotDeckCommandOptions,
  type PilotDeckCommandResult,
  type PilotDeckCommandRunner,
} from "../../src/tool/index.js";
import { createPilotDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPilotDeckToolRuntimeFixture } from "../helpers/tool.js";

class FakeRunner implements PilotDeckCommandRunner {
  constructor(private readonly result: PilotDeckCommandResult) {}

  async run(_command: string, _options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult> {
    return this.result;
  }
}

test("bash runs safe commands and converts non-zero exit to tool error", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const runner = new FakeRunner({ exitCode: 2, stdout: "", stderr: "failed", timedOut: false, durationMs: 5 });
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createBashTool({ runner })],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute({ id: "call-1", name: "bash", input: { command: "sh -c 'exit 2'" } }, context);

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "tool_execution_failed");
});

test("bash denies dangerous commands even in bypassPermissions", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [createBashTool({ runner: new FakeRunner({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }) })],
    cwd: workspace.cwd,
    permissionMode: "bypassPermissions",
  });

  const result = await toolRuntime.execute({ id: "call-1", name: "bash", input: { command: "sudo whoami" } }, context);

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "permission_denied");
});

test("bash converts runner timeout to tool_timeout", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPilotDeckToolRuntimeFixture({
    tools: [
      createBashTool({
        runner: new FakeRunner({ exitCode: null, stdout: "", stderr: "", timedOut: true, durationMs: 10 }),
      }),
    ],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute({ id: "call-1", name: "bash", input: { command: "pwd" } }, context);

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "tool_timeout");
});
