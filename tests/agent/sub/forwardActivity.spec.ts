import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { SUBAGENT_DEFINITIONS } from "../../../src/agent/sub/builtinSubagentTypes.js";
import { SubAgentSession, type SubAgentSessionOptions } from "../../../src/agent/sub/SubAgentSession.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry, type SatiToolDefinition } from "../../../src/tool/index.js";
import type { SatiToolScheduler } from "../../../src/tool/scheduler/ToolScheduler.js";

/**
 * 子代理活动镜像（`SubAgentSession.forwardActivity`）行为基线。
 *
 * 该投影此前零覆盖：子代理 AgentLoop 自身没有 eventEmitter，父级界面能看到
 * 子代理在做什么，全靠这里把子循环事件改写成 `subagent_*` 父级事件。
 */

const FINAL_REPORT = [
  "Scope: ran the probe tool",
  "Result: ok",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

function createProbeTool(): SatiToolDefinition {
  return {
    name: "probe_tool",
    description: "probe tool for mirroring tests",
    kind: "custom",
    inputSchema: { type: "object", additionalProperties: true, properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({
      content: [{ type: "text", text: "probe ok" }],
      data: { ok: true },
    }),
  };
}

/** 第一轮发工具调用，第二轮给最终报告——两轮才能同时覆盖镜像的三类事件。 */
function createRouter(): AgentRouterRuntime {
  let requests = 0;
  return {
    decide: async ({ request }: { request: { provider: string; model: string } }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: true,
      orchestrating: false,
      resolvedFrom: "fallback",
      mutations: {},
    }),
    execute: async function* () {
      requests += 1;
      yield { type: "message_start", role: "assistant" };
      if (requests === 1) {
        yield { type: "tool_call_end", toolCall: { id: "call_0", name: "probe_tool", input: {} } };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: FINAL_REPORT };
      yield { type: "message_end", finishReason: "stop" };
    },
    stream: async function* () {},
  } as unknown as AgentRouterRuntime;
}

function parentConfig(): AgentRuntimeConfig {
  return {
    provider: "test",
    model: "test-model",
    cwd: process.cwd(),
    runMode: "agent",
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: process.cwd(),
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
}

async function runChild(
  options: { emit?: boolean; registry?: ToolRegistry } = {},
): Promise<{ mirrored: AgentEvent[]; markdown: string }> {
  const registry = options.registry ?? new ToolRegistry();
  const mirrored: AgentEvent[] = [];
  const sessionOptions: SubAgentSessionOptions = {
    definition: SUBAGENT_DEFINITIONS["general-purpose"],
    directive: "Run the probe tool, then report.",
    parentConfig: parentConfig(),
    parentDependencies: {
      router: createRouter(),
      tools: { registry, scheduler: {} as unknown as SatiToolScheduler },
      ...(options.emit === false ? {} : { eventEmitter: event => mirrored.push(event) }),
    } as AgentRuntimeDependencies,
    parentSessionId: "parent-session",
    parentTurnId: "parent-turn",
    subagentSessionId: `${process.cwd()}::sub::child-agent`,
    subagentId: "child-agent",
  };
  const report = await new SubAgentSession(sessionOptions).run();
  return { mirrored, markdown: report.markdown };
}

function createRegistryWithProbe(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createProbeTool());
  return registry;
}

test("forwardActivity：子循环事件改写成父级 subagent_* 事件并带上 fork 身份", async () => {
  const { mirrored } = await runChild({ registry: createRegistryWithProbe() });

  const projected = mirrored.filter(event => event.type.startsWith("subagent_"));
  assert.ok(projected.length > 0, "父级 emitter 必须收到镜像事件");
  assert.deepEqual(
    [...new Set(projected.map(event => event.type))].sort(),
    ["subagent_model_event", "subagent_tool_calls_detected", "subagent_tool_result"],
    "只镜像这三类；durable 事件（assistant_message / tool_results_projected）走 sidechain，不进事件流",
  );
  for (const event of projected) {
    assert.equal(event.sessionId, "parent-session", `事件 ${event.type} 必须以父会话归属`);
    assert.ok("turnId" in event, `事件 ${event.type} 必须带父 turn 归属`);
    assert.equal(event.turnId, "parent-turn", `事件 ${event.type} 必须以父 turn 归属`);
    if (
      event.type !== "subagent_model_event" &&
      event.type !== "subagent_tool_calls_detected" &&
      event.type !== "subagent_tool_result"
    ) {
      assert.fail(`未预期的事件类型：${event.type}`);
    }
    assert.equal(event.subagentId, "child-agent");
    assert.equal(event.subagentType, "general-purpose");
  }

  // 旁路：子 ToolRuntime 拿的是父 emitter，自己直发 pre/post_tool_execute（带子
  // sessionId）。`subagentExecutor` 正是靠 `::sub::` 标记把它们合成为父级
  // subagent_status——镜像层不重复发这两类，否则状态机会收到双份。
  const bypass = mirrored.filter(event => !event.type.startsWith("subagent_"));
  assert.ok(bypass.length > 0, "旁路事件是子代理工具状态的唯一来源");
  for (const event of bypass) {
    assert.ok(
      event.type === "pre_tool_execute" || event.type === "post_tool_execute",
      `旁路事件只应是工具执行起止，实际 ${event.type}`,
    );
    assert.match(event.sessionId, /::sub::child-agent$/);
  }
});

test("forwardActivity：工具调用 id 原样透传（UI 靠原始 id 与 sidechain 快照对齐去重）", async () => {
  const { mirrored } = await runChild({ registry: createRegistryWithProbe() });

  const detected = mirrored.find(event => event.type === "subagent_tool_calls_detected");
  assert.ok(detected, "必须镜像 tool_calls_detected");
  assert.deepEqual(
    detected.calls.map(call => ({ id: call.id, name: call.name })),
    [{ id: "call_0", name: "probe_tool" }],
    "子代理工具 id 保持模型给的原值（加前缀会让子代理详情面板与 sidechain 快照对不上，出现重复行）",
  );

  const result = mirrored.find(event => event.type === "subagent_tool_result");
  assert.ok(result, "必须镜像 tool_result");
  assert.equal(result.result.toolCallId, "call_0");
  assert.equal(result.result.toolName, "probe_tool");
  assert.equal(result.result.type, "success");
});

test("forwardActivity：无父级 emitter 时子代理照常跑完", async () => {
  const { mirrored, markdown } = await runChild({ emit: false, registry: createRegistryWithProbe() });

  assert.deepEqual(mirrored, []);
  assert.equal(markdown, FINAL_REPORT);
});
