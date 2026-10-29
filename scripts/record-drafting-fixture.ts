#!/usr/bin/env tsx
/**
 * patent_drafting_v1 全链路 LLM-replay fixture 录制工具
 * （tests/test-support/llm-replay-drafting.spec.ts 的真实模型侧）。
 *
 * 装配与 spec 逐项对齐（provider/model、createBuiltinRegistry() 无选项、
 * router disabled、bypassPermissions、maxContextMessages=60、TASK 原文），
 * 保证录制键与重放键一致；唯一差异是模型侧为真实 runtime + 录制包装。
 *
 * 用法：
 *   node --import tsx scripts/record-drafting-fixture.ts
 *   # 产物：tests/fixtures/llm-replay/patent-drafting/{records.jsonl,manifest.json}
 *   pnpm record:replay tests/fixtures/llm-replay/patent-drafting   # 校验
 *
 * 凭据：读 ~/.sati/sati.yaml 的 model.providers（当前用 deepseek/deepseek-flash，
 * 与 spec 的 makeConfig 一致；spec 原写的 deepseek-v4-flash 不存在于配置与
 * DeepSeek API，已对齐为本模型）。
 */
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadPilotConfig } from "../src/pilot/index.js";
import { createModelRuntime } from "../src/model/index.js";
import { applyReplayEnvHooks, REPLAY_RECORD_ROOT_ENV } from "../src/test-support/llm-replay/index.js";
import { createRouterRuntime } from "../src/router/index.js";
import { createBuiltinRegistry } from "../src/tool/registry/createBuiltinRegistry.js";
import { createAgentSession } from "../src/agent/index.js";
import { createDefaultPermissionContext } from "../src/permission/index.js";
import type { AgentRuntimeConfig } from "../src/agent/runtime/AgentRuntimeConfig.js";

const outDir =
  process.env[REPLAY_RECORD_ROOT_ENV] ?? resolve(process.cwd(), "tests/fixtures/llm-replay/patent-drafting");
await mkdir(outDir, { recursive: true });
const projectRoot = process.cwd();
const env = { ...process.env, [REPLAY_RECORD_ROOT_ENV]: outDir };
const snapshot = loadPilotConfig({ projectRoot, env });
const baseModel = createModelRuntime(snapshot.config.model);
const model = applyReplayEnvHooks(baseModel, env);
const now = () => new Date();
const router = createRouterRuntime({ enabled: false }, { modelRuntime: model, now });
// 与 spec 一致：无选项（含 ask_user_question / plan_mode），保证 toolSchemaDigest 相同。
const registry = createBuiltinRegistry();
const permissionContext = createDefaultPermissionContext({
  cwd: projectRoot,
  mode: "bypassPermissions",
  canPrompt: false,
  bypassAvailable: true,
  additionalWorkingDirectories: [],
  rules: { allow: [], deny: [], ask: [] },
});
const config: AgentRuntimeConfig = {
  provider: "deepseek",
  model: "deepseek-flash",
  cwd: projectRoot,
  permissionMode: "bypassPermissions",
  permissionContext,
  maxContextMessages: 60,
  env,
};

// 与 llm-replay-drafting.spec.ts 的 TASK 逐字一致（改任务文本 = 改请求键 = 重录）。
const TASK =
  "请根据以下技术交底书撰写专利申请文件：一种双层真空保温容器，通过双层真空结构解决保温时间短的问题。" +
  "请使用 patent_workflow_run 执行 patent_drafting_v1 工作流，并在每个 HITL 检查点确认通过。" +
  "完成后总结权利要求与说明书的关键内容。";

const session = createAgentSession({
  sessionId: "record-drafting-" + randomUUID().slice(0, 8),
  config,
  dependencies: { router, tools: { registry }, now, uuid: () => randomUUID() },
});

console.log("task:", TASK);
console.log("recording to:", outDir);
let completed = false;
for await (const event of session.submit({ type: "text", text: TASK }, { canPrompt: false, maxTurns: 40 })) {
  switch (event.type) {
    case "model_request_started":
      console.log("  [request]", event.model);
      break;
    case "tool_calls_detected":
      console.log("  [tools]", event.calls.map((c: { name: string }) => c.name).join(", "));
      break;
    case "assistant_message": {
      const text = event.message.content.map(b => (b.type === "text" ? b.text : "")).join("");
      if (text.trim()) console.log("  [assistant]", text.slice(0, 120));
      break;
    }
    case "tool_result":
      console.log("  [tool_result]", event.result.toolName, event.result.type);
      break;
    case "turn_completed":
      completed = true;
      console.log("  [turn_completed]", event.result.stopReason);
      break;
    case "turn_failed":
      console.log("  [turn_failed]", event.error?.message);
      break;
  }
}
console.log(completed ? "done (completed)" : "done (NOT completed — fixture 可能不完整)");
console.log("validate with: pnpm record:replay " + outDir);
