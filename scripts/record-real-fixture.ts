/**
 * 真实模型 LLM-replay fixture 录制工具（阶段四 T1 收尾）。
 *
 * 用法（需 API key 配置在 ~/.sati/sati.yaml 的 model.providers）：
 *   SATI_LLM_REPLAY_RECORD_ROOT=<fixture-dir> \
 *     node --import tsx scripts/record-real-fixture.ts "<任务文本>"
 *   pnpm record:replay <fixture-dir>   # 校验后提交 fixture 目录
 *
 * 装配与 tests/test-support/llm-replay-real.spec.ts 完全一致（真实 ModelRuntime +
 * applyReplayEnvHooks 录制包装 + enabled:false router + 内置注册表 + AgentSession），
 * 保证录制/重放请求键一致。任务文本缺省为 glob 工具调用样例。
 */
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { loadPilotConfig } from "../src/pilot/index.js";
import { createModelRuntime } from "../src/model/index.js";
import { applyReplayEnvHooks, REPLAY_RECORD_ROOT_ENV } from "../src/test-support/llm-replay/index.js";
import { createRouterRuntime } from "../src/router/index.js";
import { createBuiltinRegistry } from "../src/tool/registry/createBuiltinRegistry.js";
import { createAgentSession } from "../src/agent/index.js";
import { createDefaultPermissionContext } from "../src/permission/index.js";
import type { AgentRuntimeConfig } from "../src/agent/runtime/AgentRuntimeConfig.js";

const outDir = process.env[REPLAY_RECORD_ROOT_ENV];
if (!outDir) {
  console.error("set " + REPLAY_RECORD_ROOT_ENV);
  process.exit(1);
}
await mkdir(outDir, { recursive: true });
const projectRoot = process.cwd();
const env = process.env;
const snapshot = loadPilotConfig({ projectRoot, env });
const agentRef = snapshot.config.agent.model;
console.log("agent model:", agentRef.provider + "/" + agentRef.model);
const baseModel = createModelRuntime(snapshot.config.model);
const model = applyReplayEnvHooks(baseModel, { ...env, [REPLAY_RECORD_ROOT_ENV]: outDir });
const now = () => new Date();
const router = createRouterRuntime({ enabled: false }, { modelRuntime: model, now });
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
  provider: agentRef.provider,
  model: agentRef.model,
  cwd: projectRoot,
  permissionMode: "bypassPermissions",
  permissionContext,
  maxContextMessages: 60,
  env,
};
const session = createAgentSession({
  sessionId: "record-real-" + randomUUID().slice(0, 8),
  config,
  dependencies: { router, tools: { registry }, now, uuid: () => randomUUID() },
});
const task = process.argv[2] ?? "请调用 glob 工具查找当前目录下的 *.md 文件，然后告诉我找到了哪些。";
console.log("task:", task);
for await (const event of session.submit({ type: "text", text: task }, { canPrompt: false, maxTurns: 3 })) {
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
      console.log("  [turn_completed]", event.result.stopReason);
      break;
    case "turn_failed":
      console.log("  [turn_failed]", event.error?.message);
      break;
  }
}
console.log("done; records at", outDir);
console.log("validate with: pnpm record:replay " + outDir);
