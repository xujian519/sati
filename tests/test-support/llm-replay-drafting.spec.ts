import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createAgentSession } from "../../src/agent/index.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
  ModelRuntimeOptions,
  MultimodalConstraints,
} from "../../src/model/index.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import { createRouterRuntime } from "../../src/router/index.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";
import { createReplayModelRuntime } from "../../src/test-support/llm-replay/index.js";

/**
 * T12 端到端验收（llm-replay，docs/patent-drafting-sop-plan.md 迭代四）：
 * patent_drafting_v1 全链路真实会话录制 → CI 无 key 重放。
 *
 * 录制流程（需真实模型 key + 交互式批准 5 个审批门）：
 *   1. 设置 SATI_LLM_REPLAY_RECORD_ROOT=tests/fixtures/llm-replay/patent-drafting
 *   2. 启动产品，对"撰写专利"任务执行 patent_workflow_run(manifestId=patent_drafting_v1)，
 *      在每个 HITL 检查点批准（approveStageIds 或交互确认）直至完成
 *   3. 提交 fixture 目录（records.jsonl + manifest.json）
 *
 * fixture 缺失时本测试跳过（录制后自动生效）。fixture 请求键 = 内容哈希
 * （含工具 inputSchema digest）——任何工具 schema 改动后需重录。
 */

const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/llm-replay/patent-drafting");
const TASK =
  "请根据以下技术交底书撰写专利申请文件：一种双层真空保温容器，通过双层真空结构解决保温时间短的问题。" +
  "请使用 patent_workflow_run 执行 patent_drafting_v1 工作流，并在每个 HITL 检查点确认通过。" +
  "完成后总结权利要求与说明书的关键内容。";

/** 能力查询桩（重放不触网，仅回答能力/模态查询）。 */
class CapabilityOnlyRuntime implements ModelRuntime {
  stream(_request: CanonicalModelRequest, _options?: ModelRuntimeOptions): AsyncIterable<CanonicalModelEvent> {
    throw new Error("unreachable: replay runtime intercepts stream");
  }
  complete(_request: CanonicalModelRequest, _options?: ModelRuntimeOptions): Promise<CanonicalModelResponse> {
    throw new Error("unreachable: replay runtime intercepts stream");
  }
  getCapabilities() {
    return {
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: true,
      supportsThinking: false,
      supportsJsonSchema: false,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxContextTokens: 64000,
      maxOutputTokens: 8192,
    };
  }
  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }
  getProviderProtocol() {
    return "openai" as const;
  }
  getProviderBaseUrl() {
    return undefined;
  }
}

function makeConfig(cwd: string): AgentRuntimeConfig {
  return {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
      additionalWorkingDirectories: [],
      rules: { allow: [], deny: [], ask: [] },
    }),
    maxContextMessages: 60,
    env: process.env,
  };
}

test("patent_drafting_v1 全链路 fixture 无 key 重放（录制后自动生效）", async () => {
  if (!existsSync(resolve(FIXTURE_DIR, "records.jsonl"))) {
    // 未录制：跳过（录制流程见文件头注释）。CI 无 key 且无 fixture 时不应失败。
    return;
  }
  const replay = createReplayModelRuntime(FIXTURE_DIR, new CapabilityOnlyRuntime());
  const now = () => new Date();
  const router = createRouterRuntime({ enabled: false }, { modelRuntime: replay, now });
  const registry = createBuiltinRegistry();
  const session = createAgentSession({
    sessionId: "replay-drafting-" + randomUUID().slice(0, 8),
    config: makeConfig(process.cwd()),
    dependencies: { router, tools: { registry }, now, uuid: () => randomUUID() },
  });

  let assistantText = "";
  let completed = false;
  for await (const event of session.submit({ type: "text", text: TASK }, { canPrompt: false, maxTurns: 40 })) {
    if (event.type === "assistant_message") {
      const text = event.message.content.map(block => (block.type === "text" ? block.text : "")).join("");
      if (text.trim()) assistantText += text;
    }
    if (event.type === "turn_completed") completed = true;
  }

  // 全部录制流都被驱动（无少驱动）；请求键不匹配会在 stream 时 fail-loud。
  assert.doesNotThrow(() => replay.assertAllConsumed());
  assert.equal(completed, true, "重放会话应正常完成");
  assert.ok(assistantText.length > 0, "重放应产出模型文本");
});
