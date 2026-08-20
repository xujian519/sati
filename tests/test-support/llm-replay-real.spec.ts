/**
 * 真实模型 fixture 无 key 重放测试（阶段四 T1 收尾）。
 *
 * fixture（tests/fixtures/llm-replay/deepseek-v4-flash-basic）由真实 DeepSeek
 * v4 flash 会话录制（scripts/record-real-fixture.ts，含一次 glob 工具调用 + 总结）。
 * 本测试以 createReplayModelRuntime 无 key 重放完整 AgentLoop 回路：请求键匹配
 * fixture（未匹配即 NO_REPLAY_RECORD fail-loud）、assertAllConsumed 防少驱动。
 *
 * 录制方式（需 API key）：
 *   SATI_LLM_REPLAY_RECORD_ROOT=<fixture-dir> node --import tsx scripts/record-real-fixture.ts "<task>"
 *   pnpm record:replay <fixture-dir>  # 校验后提交
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { createAgentSession } from "../../src/agent/index.js";
import type { AgentRuntimeConfig } from "../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
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

// 基于 cwd（repo 根）解析：完整套件从 dist/tests 运行（import.meta.url 指向 dist，
// 相对路径会解析到不存在的 dist/tests/fixtures），tsx 快路径与 pnpm test 均在 repo 根执行。
const FIXTURE_DIR = resolve(process.cwd(), "tests/fixtures/llm-replay/deepseek-v4-flash-basic");
/** 与录制会话完全一致的任务文本（请求键依赖消息/工具/schema 一致性）。 */
// 纯问答任务（无工具调用）：工具结果会进入下一轮请求消息，任何环境差异（文件集合/
// 排序/mtime/路径）都会破坏请求键——CI 无 key 重放必须环境无关。工具调用循环的
// 覆盖由确定性 ScriptedModelRuntime fixture（llm-replay.spec）承担。
const TASK = "请用一句话介绍你自己，以及你能为专利工程师提供哪些帮助。";

/**
 * 能力查询桩：重放时 stream 被 replay runtime 拦截（不触网），本桩只回答
 * 能力/模态查询（router 媒体检查、AgentLoop 上下文窗口）。
 */
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

test("真实模型 fixture 无 key 重放完整 AgentLoop 回路（deepseek-v4-flash）", async () => {
  const replay = createReplayModelRuntime(FIXTURE_DIR, new CapabilityOnlyRuntime());
  const now = () => new Date();
  const router = createRouterRuntime({ enabled: false }, { modelRuntime: replay, now });
  // 工具集须与录制时（fixture manifest toolNames）逐字节一致：fixture 录制于
  // ask_user_question / plan_mode 工具加入之前，重放时排除这两个非核心默认工具
  // （请求键 toolSchemaDigest 含工具列表，多注册即 NO_REPLAY_RECORD 失配）。
  const registry = createBuiltinRegistry({ askUserQuestion: false, planMode: false });
  const session = createAgentSession({
    sessionId: "replay-real-" + randomUUID().slice(0, 8),
    config: makeConfig(process.cwd()),
    dependencies: { router, tools: { registry }, now, uuid: () => randomUUID() },
  });

  let assistantText = "";
  let completed = false;
  for await (const event of session.submit({ type: "text", text: TASK }, { canPrompt: false, maxTurns: 3 })) {
    if (event.type === "assistant_message") {
      const text = event.message.content.map(block => (block.type === "text" ? block.text : "")).join("");
      if (text.trim()) assistantText += text;
    }
    if (event.type === "turn_completed") completed = true;
  }

  // 全部录制流都被驱动（无少驱动）；请求键不匹配会在 stream 时 fail-loud。
  assert.doesNotThrow(() => replay.assertAllConsumed());
  assert.equal(completed, true, "重放会话应正常完成（interrupted 之外无异常）");
  assert.ok(assistantText.length > 0, "重放应产出模型文本");
  assert.match(assistantText, /Sati|专利/, "重放输出应保留真实模型的回答内容");
});
