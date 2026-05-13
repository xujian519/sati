import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLoop, type AgentRuntimeConfig, type AgentRuntimeDependencies } from "../../src/agent/index.js";
import { createModelRuntime } from "../../src/model/index.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import { loadPilotConfig } from "../../src/pilot/index.js";
import { createRouterRuntime } from "../../src/router/index.js";
import { ToolRuntime, SequentialToolScheduler, createBuiltinRegistry } from "../../src/tool/index.js";
import { collectAsyncGenerator } from "../helpers/agent.js";

const RUN = process.env.PILOTDECK_RUN_FRAMEWORK_E2E === "1";
const PROVIDER = process.env.PILOTDECK_E2E_PROVIDER ?? "edgeclaw";
const MODEL = process.env.PILOTDECK_E2E_MODEL ?? "moonshotai/kimi-k2.6";

test("Real agent reads a file using read_file tool", { timeout: 120_000 }, async (t) => {
  if (!RUN) {
    t.skip("Set PILOTDECK_RUN_FRAMEWORK_E2E=1 to run.");
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotdeck-e2e-"));
  const testFile = path.join(tmpDir, "test.txt");
  fs.writeFileSync(testFile, "Hello from PilotDeck E2E test!");

  try {
    const snapshot = loadPilotConfig();
    const modelRuntime = createModelRuntime(snapshot.config.model);
    const cwd = tmpDir;
    const registry = createBuiltinRegistry({
      webSearch: false,
      webFetch: false,
      agent: false,
    });
    const permissionRuntime = new PermissionRuntime();
    const toolRuntime = new ToolRuntime(registry, permissionRuntime);
    const scheduler = new SequentialToolScheduler(toolRuntime);
    const router = createRouterRuntime(
      { scenarios: { default: { id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL } } },
      { modelRuntime },
    );
    const config: AgentRuntimeConfig = {
      provider: PROVIDER, model: MODEL, cwd,
      systemPrompt: "You are a test agent. Use the read_file tool to read the file, then report its contents.",
      maxOutputTokens: 1024, temperature: 0,
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false }),
    };
    const loop = new AgentLoop(config, { router, tools: { registry, scheduler } });
    const { result } = await collectAsyncGenerator(
      loop.run({
        sessionId: "e2e-read", turnId: "t1", maxTurns: 5,
        messages: [{ role: "user", content: [{ type: "text", text: `Read the file at ${testFile} and tell me what it says.` }] }],
      }),
    );
    assert.equal(result.result.type, "success");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Real agent executes bash command", { timeout: 120_000 }, async (t) => {
  if (!RUN) {
    t.skip("Set PILOTDECK_RUN_FRAMEWORK_E2E=1 to run.");
    return;
  }

  const snapshot = loadPilotConfig();
  const modelRuntime = createModelRuntime(snapshot.config.model);
  const cwd = process.cwd();
  const registry = createBuiltinRegistry({
    webSearch: false,
    webFetch: false,
    agent: false,
  });
  const permissionRuntime = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissionRuntime);
  const scheduler = new SequentialToolScheduler(toolRuntime);
  const router = createRouterRuntime(
    { scenarios: { default: { id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL } } },
    { modelRuntime },
  );
  const config: AgentRuntimeConfig = {
    provider: PROVIDER, model: MODEL, cwd,
    systemPrompt: "You are a test agent. Use the bash tool to run the command, then report the output.",
    maxOutputTokens: 1024, temperature: 0,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "bypassPermissions", canPrompt: false }),
  };
  const loop = new AgentLoop(config, { router, tools: { registry, scheduler } });
  const { result } = await collectAsyncGenerator(
    loop.run({
      sessionId: "e2e-bash", turnId: "t1", maxTurns: 5,
      messages: [{ role: "user", content: [{ type: "text", text: "Run `echo hello_pilotdeck` using bash and tell me the output." }] }],
    }),
  );
  assert.equal(result.result.type, "success");
});

test("Real agent uses glob to find files", { timeout: 120_000 }, async (t) => {
  if (!RUN) {
    t.skip("Set PILOTDECK_RUN_FRAMEWORK_E2E=1 to run.");
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotdeck-e2e-glob-"));
  fs.writeFileSync(path.join(tmpDir, "a.txt"), "aaa");
  fs.writeFileSync(path.join(tmpDir, "b.txt"), "bbb");
  fs.writeFileSync(path.join(tmpDir, "c.json"), "{}");

  try {
    const snapshot = loadPilotConfig();
    const modelRuntime = createModelRuntime(snapshot.config.model);
    const registry = createBuiltinRegistry({
      webSearch: false,
      webFetch: false,
      agent: false,
    });
    const permissionRuntime = new PermissionRuntime();
    const toolRuntime = new ToolRuntime(registry, permissionRuntime);
    const scheduler = new SequentialToolScheduler(toolRuntime);
    const router = createRouterRuntime(
      { scenarios: { default: { id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL } } },
      { modelRuntime },
    );
    const config: AgentRuntimeConfig = {
      provider: PROVIDER, model: MODEL, cwd: tmpDir,
      systemPrompt: "You are a test agent. Use the glob tool to find all .txt files, then report the file names.",
      maxOutputTokens: 1024, temperature: 0,
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({ cwd: tmpDir, mode: "bypassPermissions", canPrompt: false }),
    };
    const loop = new AgentLoop(config, { router, tools: { registry, scheduler } });
    const { result } = await collectAsyncGenerator(
      loop.run({
        sessionId: "e2e-glob", turnId: "t1", maxTurns: 5,
        messages: [{ role: "user", content: [{ type: "text", text: "Find all .txt files in the current directory using glob and list them." }] }],
      }),
    );
    assert.equal(result.result.type, "success");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Real agent writes a file using write_file tool", { timeout: 120_000 }, async (t) => {
  if (!RUN) {
    t.skip("Set PILOTDECK_RUN_FRAMEWORK_E2E=1 to run.");
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotdeck-e2e-write-"));
  const outFile = path.join(tmpDir, "output.txt");

  try {
    const snapshot = loadPilotConfig();
    const modelRuntime = createModelRuntime(snapshot.config.model);
    const registry = createBuiltinRegistry({
      webSearch: false,
      webFetch: false,
      agent: false,
    });
    const permissionRuntime = new PermissionRuntime();
    const toolRuntime = new ToolRuntime(registry, permissionRuntime);
    const scheduler = new SequentialToolScheduler(toolRuntime);
    const router = createRouterRuntime(
      { scenarios: { default: { id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL } } },
      { modelRuntime },
    );
    const config: AgentRuntimeConfig = {
      provider: PROVIDER, model: MODEL, cwd: tmpDir,
      systemPrompt: "You are a test agent. Write the exact text to the file as instructed.",
      maxOutputTokens: 1024, temperature: 0,
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({ cwd: tmpDir, mode: "bypassPermissions", canPrompt: false }),
    };
    const loop = new AgentLoop(config, { router, tools: { registry, scheduler } });
    const { result } = await collectAsyncGenerator(
      loop.run({
        sessionId: "e2e-write", turnId: "t1", maxTurns: 5,
        messages: [{ role: "user", content: [{ type: "text", text: `Write "PilotDeck works!" to ${outFile} using the write_file tool.` }] }],
      }),
    );
    assert.equal(result.result.type, "success");
    if (fs.existsSync(outFile)) {
      const content = fs.readFileSync(outFile, "utf-8");
      assert.ok(content.includes("PilotDeck"), "File should contain 'PilotDeck'");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
