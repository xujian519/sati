import test from "node:test";
import assert from "node:assert/strict";
import {
  createBashTool,
  type PolitDeckCommandOptions,
  type PolitDeckCommandResult,
  type PolitDeckCommandRunner,
} from "../../src/tool/index.js";
import { createPolitDeckTempWorkspace } from "../helpers/filesystem.js";
import { createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

class FakeRunner implements PolitDeckCommandRunner {
  constructor(private readonly result: PolitDeckCommandResult) {}

  async run(_command: string, _options: PolitDeckCommandOptions): Promise<PolitDeckCommandResult> {
    return this.result;
  }
}

test("bash runs safe commands and converts non-zero exit to tool error", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const runner = new FakeRunner({ exitCode: 2, stdout: "", stderr: "failed", timedOut: false, durationMs: 5 });
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createBashTool({ runner })],
    cwd: workspace.cwd,
  });

  const result = await toolRuntime.execute({ id: "call-1", name: "bash", input: { command: "sh -c 'exit 2'" } }, context);

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "tool_execution_failed");
});

test("bash denies dangerous commands even in bypassPermissions", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
    tools: [createBashTool({ runner: new FakeRunner({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 }) })],
    cwd: workspace.cwd,
    permissionMode: "bypassPermissions",
  });

  const result = await toolRuntime.execute({ id: "call-1", name: "bash", input: { command: "sudo whoami" } }, context);

  assert.equal(result.type, "error");
  if (result.type === "error") assert.equal(result.error.code, "permission_denied");
});

test("bash converts runner timeout to tool_timeout", async (t) => {
  const workspace = await createPolitDeckTempWorkspace({});
  t.after(() => workspace.cleanup());
  const { toolRuntime, context } = createPolitDeckToolRuntimeFixture({
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
