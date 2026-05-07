import type { CanonicalModelEvent, CanonicalModelRequest } from "../../src/model/index.js";
import {
  createDefaultPermissionContext,
  type PermissionMode,
} from "../../src/permission/index.js";
import {
  ToolRegistry,
  ToolRuntime,
  SequentialToolScheduler,
  type PolitDeckToolAuditRecorder,
  type PolitDeckToolDefinition,
} from "../../src/tool/index.js";
import { PermissionRuntime } from "../../src/permission/index.js";
import { AgentLoop, TurnRunner, InMemoryTranscriptWriter } from "../../src/agent/index.js";
import type { AgentRuntimeConfig, AgentRuntimeDependencies } from "../../src/agent/index.js";

export class ScriptedAgentModel {
  readonly requests: CanonicalModelRequest[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];

  constructor(private readonly scripts: CanonicalModelEvent[][]) {}

  async *stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    this.signals.push(signal);
    const script = this.scripts.shift() ?? [
      { type: "message_start", role: "assistant" },
      { type: "message_end", finishReason: "stop" },
    ];
    for (const event of script) {
      if (signal?.aborted) {
        return;
      }
      yield event;
    }
  }
}

export function createAgentLoopFixture(options: {
  scripts: CanonicalModelEvent[][];
  tools?: PolitDeckToolDefinition[];
  permissionMode?: PermissionMode;
  canPrompt?: boolean;
  auditRecorder?: PolitDeckToolAuditRecorder;
}): {
  model: ScriptedAgentModel;
  registry: ToolRegistry;
  loop: AgentLoop;
  transcript: InMemoryTranscriptWriter;
  turnRunner: TurnRunner;
  config: AgentRuntimeConfig;
  dependencies: AgentRuntimeDependencies;
} {
  const model = new ScriptedAgentModel(options.scripts);
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) {
    registry.register(tool);
  }
  const permissionRuntime = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissionRuntime);
  const scheduler = new SequentialToolScheduler(toolRuntime);
  const permissionMode = options.permissionMode ?? "default";
  const cwd = process.cwd();
  const config: AgentRuntimeConfig = {
    provider: "test-provider",
    model: "test-model",
    cwd,
    permissionMode,
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: permissionMode,
      canPrompt: options.canPrompt ?? false,
    }),
  };
  const dependencies: AgentRuntimeDependencies = {
    model,
    tools: { registry, scheduler },
    auditRecorder: options.auditRecorder,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    uuid: () => "generated-id",
  };
  const loop = new AgentLoop(config, dependencies);
  const transcript = new InMemoryTranscriptWriter();
  const turnRunner = new TurnRunner(loop, transcript, undefined, dependencies.now);
  return { model, registry, loop, transcript, turnRunner, config, dependencies };
}

export async function collectAsyncGenerator<T, R>(generator: AsyncGenerator<T, R, unknown>): Promise<{
  values: T[];
  result: R;
}> {
  const values: T[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { values, result: next.value };
    }
    values.push(next.value);
  }
}
