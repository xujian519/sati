import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import { loadPilotConfig } from "../../../src/pilot/config/index.js";
import { PilotConfigError } from "../../../src/pilot/config/types.js";
import { PILOT_CONFIG_FILE_NAME } from "../../../src/pilot/paths.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { SubAgentSession, type SubAgentSessionOptions } from "../../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS, type SubagentDefinition } from "../../../src/agent/sub/builtinSubagentTypes.js";
import { PermissionRuntime, createDefaultPermissionContext } from "../../../src/permission/index.js";
import { createBashTool } from "../../../src/tool/builtin/bash.js";
import type { SatiCommandRunner } from "../../../src/tool/builtin/bash/commandRunner.js";
import { createExecuteCodeTool } from "../../../src/tool/builtin/executeCode.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry, type SatiToolDefinition, type SatiToolRuntimeContext } from "../../../src/tool/index.js";
import type { SatiToolScheduler } from "../../../src/tool/scheduler/ToolScheduler.js";

const FINAL_REPORT = [
  "Scope: inspected inputs",
  "Result: ok",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

type TestableSubAgentSession = {
  buildScopedRegistry(): ToolRegistry;
  buildConfig(): AgentRuntimeConfig;
};

function createNoopTool(name: string, isReadOnly: SatiToolDefinition["isReadOnly"]): SatiToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: true,
      properties: {},
    },
    isReadOnly,
    isConcurrencySafe: () => true,
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
      data: {},
    }),
  };
}

function createRouter(): AgentRouterRuntime {
  return {
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: true,
      orchestrating: false,
      resolvedFrom: "fallback",
      mutations: {},
    }),
    execute: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    stream: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
    },
  } as AgentRouterRuntime;
}

function parentConfig(): AgentRuntimeConfig {
  return {
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
    runMode: "agent",
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function sessionFor(definition: SubagentDefinition, registry: ToolRegistry): TestableSubAgentSession {
  const options: SubAgentSessionOptions = {
    definition,
    directive: "Inspect the workspace.",
    parentConfig: parentConfig(),
    parentDependencies: {
      router: {} as AgentRuntimeDependencies["router"],
      tools: {
        registry,
        scheduler: {} as AgentRuntimeDependencies["tools"]["scheduler"],
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "child-session",
    subagentId: "child-agent",
  };
  return new SubAgentSession(options) as unknown as TestableSubAgentSession;
}

function runtimeContext(config: AgentRuntimeConfig): SatiToolRuntimeContext {
  return {
    sessionId: "child-session",
    turnId: "child-turn",
    cwd: config.cwd,
    runMode: config.runMode,
    permissionMode: config.permissionMode,
    permissionContext: config.permissionContext,
    now: () => new Date("2026-07-17T00:00:00.000Z"),
  };
}

test("explore subagent does not probe tool safety before execution", async () => {
  const readOnlyChecks: string[] = [];
  const registry = new ToolRegistry();
  registry.register(
    createNoopTool("execute_code", input => {
      readOnlyChecks.push("execute_code");
      return (input as { code: string }).code.length === 0;
    }),
  );
  registry.register(
    createNoopTool("read_file", () => {
      readOnlyChecks.push("read_file");
      return true;
    }),
  );

  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Inspect the provided files.",
    parentConfig: {
      provider: "test",
      model: "test-model",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({
        cwd: process.cwd(),
        mode: "bypassPermissions",
        canPrompt: true,
        bypassAvailable: true,
      }),
    },
    parentDependencies: {
      router: createRouter(),
      tools: {
        registry,
        scheduler: {} as unknown as SatiToolScheduler,
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-1",
  });

  const report = await session.run();

  assert.equal(report.definitionId, "explore");
  assert.equal(report.markdown, FINAL_REPORT);
  assert.deepEqual(readOnlyChecks, []);
});

test("explore registry ignores an unallowed dynamic execute_code tool without probing it", () => {
  const registry = new ToolRegistry();
  registry.register(createExecuteCodeTool());
  registry.register(
    createBashTool({
      runner: {
        async run() {
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
        },
      },
    }),
  );

  const session = sessionFor(SUBAGENT_DEFINITIONS.explore, registry);
  const scoped = session.buildScopedRegistry();

  assert.deepEqual(
    scoped.list().map(tool => tool.name),
    ["bash"],
  );
  assert.equal(session.buildConfig().runMode, "ask");
});

test("read-only subagent evaluates bash safety from the real command", async () => {
  const commands: string[] = [];
  const runner: SatiCommandRunner = {
    async run(command) {
      commands.push(command);
      return {
        exitCode: 0,
        stdout: `${command}\n`,
        stderr: "",
        timedOut: false,
        durationMs: 1,
      };
    },
  };
  const registry = new ToolRegistry();
  registry.register(createBashTool({ runner }));
  const session = sessionFor(SUBAGENT_DEFINITIONS.explore, registry);
  const scoped = session.buildScopedRegistry();
  const config = session.buildConfig();
  const runtime = new ToolRuntime(scoped, new PermissionRuntime());

  const readResult = await runtime.execute(
    { id: "read-command", name: "bash", input: { command: "pwd" } },
    runtimeContext(config),
  );
  assert.equal(readResult.type, "success");
  assert.deepEqual(commands, ["pwd"]);

  const writeResult = await runtime.execute(
    { id: "write-command", name: "bash", input: { command: "touch blocked.txt" } },
    runtimeContext(config),
  );
  assert.equal(writeResult.type, "error");
  assert.equal(writeResult.type === "error" ? writeResult.error.code : "", "ask_mode_violation");
  assert.deepEqual(commands, ["pwd"], "blocked command must not reach the shell runner");
});

// ==== 上游 #510 移植：agent.subagents.default（sati.yaml + SATI_HOME 适配） ====

const tempPilotHomes: string[] = [];

afterEach(() => {
  for (const dir of tempPilotHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writePilotConfig(raw: string): string {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-subagent-config-"));
  tempPilotHomes.push(pilotHome);
  writeFileSync(join(pilotHome, PILOT_CONFIG_FILE_NAME), raw, "utf8");
  return pilotHome;
}

function loadInlinePilotConfig(raw: string) {
  const pilotHome = writePilotConfig(raw);
  return loadPilotConfig({ env: { SATI_HOME: pilotHome } });
}

function pilotConfigWithSubagentDefault(defaultValue: string): string {
  return `
schemaVersion: 1
agent:
  model: main/main-model
  subagents:
    default: ${defaultValue}
model:
  providers:
    main:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        main-model: {}
    child:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        child-model: {}
`;
}

test("agent.subagents.default inherit keeps subagent model unset", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("inherit"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.equal(
    snapshot.diagnostics.some(diagnostic => diagnostic.path === "agent.subagents.default"),
    false,
  );
});

test("agent.subagents.default resolves a configured model", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("child/child-model"));

  assert.deepEqual(snapshot.config.agent.subagents?.default, {
    id: "child/child-model",
    provider: "child",
    model: "child-model",
  });
});

test("agent.subagents.default inherits with a warning when provider is missing", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("missing/child-model"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.deepEqual(
    snapshot.diagnostics.find(diagnostic => diagnostic.path === "agent.subagents.default"),
    {
      code: "CONFIG_AGENT_SUBAGENT_PROVIDER_NOT_FOUND",
      severity: "warning",
      message: "agent.subagents.default references unknown provider missing. Inheriting agent.model instead.",
      path: "agent.subagents.default",
      recoverable: true,
    },
  );
});

test("agent.subagents.default inherits with a warning when model is missing", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("child/missing-model"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.equal(
    snapshot.diagnostics.find(diagnostic => diagnostic.path === "agent.subagents.default")?.code,
    "CONFIG_AGENT_SUBAGENT_MODEL_NOT_FOUND",
  );
});

test("agent.subagents.default inherits with a warning when malformed", () => {
  const snapshot = loadInlinePilotConfig(pilotConfigWithSubagentDefault("missing-format"));

  assert.equal(snapshot.config.agent.subagents?.default, undefined);
  assert.equal(
    snapshot.diagnostics.find(diagnostic => diagnostic.path === "agent.subagents.default")?.code,
    "CONFIG_AGENT_SUBAGENT_MODEL_INVALID",
  );
});

test("agent.model still fails fast when provider is missing", () => {
  assert.throws(
    () =>
      loadInlinePilotConfig(`
schemaVersion: 1
agent:
  model: missing/main-model
  subagents:
    default: child/child-model
model:
  providers:
    child:
      protocol: openai
      url: https://example.invalid/v1
      apiKey: test
      models:
        child-model: {}
`),
    error =>
      error instanceof PilotConfigError &&
      error.diagnostics.some(diagnostic => diagnostic.code === "CONFIG_AGENT_PROVIDER_NOT_FOUND"),
  );
});

test("subagent config uses configured default model without copying caps to top-level overrides", () => {
  const registry = new ToolRegistry();
  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS["general-purpose"],
    directive: "Inspect the provided files.",
    parentConfig: {
      ...parentConfig(),
      provider: "main",
      model: "main-model",
      modelMultimodal: { input: ["text"] },
      maxContextTokens: 100000,
      maxOutputTokens: 20000,
      subagentModel: {
        provider: "child",
        model: "child-model",
        modelMultimodal: { input: ["text", "image"] },
        maxContextTokens: 32000,
        maxOutputTokens: 4096,
      },
    },
    parentDependencies: {
      router: createRouter(),
      tools: {
        registry,
        scheduler: {} as never,
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-1",
  }) as unknown as TestableSubAgentSession;

  const config = session.buildConfig();

  assert.equal(config.provider, "child");
  assert.equal(config.model, "child-model");
  assert.deepEqual(config.modelMultimodal, { input: ["text", "image"] });
  assert.equal(config.maxContextTokens, undefined);
  assert.equal(config.maxOutputTokens, undefined);
  assert.deepEqual(config.subagentModel, {
    provider: "child",
    model: "child-model",
    modelMultimodal: { input: ["text", "image"] },
    maxContextTokens: 32000,
    maxOutputTokens: 4096,
  });
  assert.equal(config.isSubagent, true);
});

test("subagent config inherits parent model when no default is configured", () => {
  const registry = new ToolRegistry();
  const session = sessionFor(SUBAGENT_DEFINITIONS["general-purpose"], registry);

  const config = session.buildConfig();

  assert.equal(config.provider, "test");
  assert.equal(config.model, "test-model");
  assert.equal(config.isSubagent, true);
});

test("configured subagent default remains a router baseline, not a router override", async () => {
  const seen: Array<{ stage: "decide" | "execute"; provider: string; model: string }> = [];
  const router: AgentRouterRuntime = {
    decide: async ({ request }) => {
      seen.push({ stage: "decide", provider: request.provider, model: request.model });
      return {
        provider: "routed",
        model: "tier-model",
        scenarioType: "default",
        isSubagent: true,
        orchestrating: false,
        resolvedFrom: "tokenSaver",
        mutations: {},
      };
    },
    execute: async function* (_decision, request) {
      seen.push({ stage: "execute", provider: request.provider, model: request.model });
      yield { type: "text_delta", text: FINAL_REPORT };
      yield {
        type: "usage",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    stream: async function* () {
      yield { type: "text_delta", text: FINAL_REPORT };
    },
  } as AgentRouterRuntime;
  const registry = new ToolRegistry();
  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS["general-purpose"],
    directive: "Inspect routing.",
    parentConfig: {
      ...parentConfig(),
      provider: "main",
      model: "main-model",
      subagentModel: {
        provider: "child",
        model: "child-model",
      },
    },
    parentDependencies: {
      router,
      tools: {
        registry,
        scheduler: {} as never,
      },
    },
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: "subagent-session",
    subagentId: "subagent-1",
  });

  const report = await session.run();

  assert.deepEqual(seen, [
    { stage: "decide", provider: "child", model: "child-model" },
    { stage: "execute", provider: "routed", model: "tier-model" },
  ]);
  assert.equal(report.markdown, FINAL_REPORT);
});

test("read-only execute_code checks the real code instead of crashing on registry setup", async () => {
  const registry = new ToolRegistry();
  registry.register(createExecuteCodeTool());
  const definition: SubagentDefinition = {
    ...SUBAGENT_DEFINITIONS.explore,
    allowedTools: ["execute_code"],
  };
  const session = sessionFor(definition, registry);
  const scoped = session.buildScopedRegistry();
  const config = session.buildConfig();
  const runtime = new ToolRuntime(scoped, new PermissionRuntime());

  assert.equal(scoped.has("execute_code"), true);
  const result = await runtime.execute(
    {
      id: "write-code",
      name: "execute_code",
      input: {
        code: "from sati_tools import write_file\nwrite_file('blocked.txt', 'no')",
      },
    },
    runtimeContext(config),
  );
  assert.equal(result.type, "error");
  assert.equal(result.type === "error" ? result.error.code : "", "ask_mode_violation");
});
