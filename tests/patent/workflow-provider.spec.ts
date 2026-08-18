import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowProvider } from "../../src/tool/builtin/patentWorkflowTool.js";
import { DEFAULT_MODEL_ID, DEFAULT_MODEL_PROVIDER } from "../../src/model/index.js";
import type { SatiToolModelClient } from "../../src/tool/index.js";

/**
 * buildWorkflowProvider 缺省链测试（2026-08 修复）：
 * 工具二次模型调用 provider/model 缺省链 = deps 显式 > 会话（context.provider/modelId）> 全局默认。
 * 此前仅 deps > 默认（openrouter/kimi），在 deepseek-only 配置下撰写链路原子恒降级。
 */

function recordingClient(requests: Array<{ provider: string; model: string }>): SatiToolModelClient {
  return {
    stream: async function* (request) {
      requests.push({ provider: request.provider, model: request.model });
      yield { type: "text_delta", text: "ok" };
    },
  };
}

test("会话 provider/modelId 继承（context 提供时不用默认 openrouter/kimi）", async () => {
  const requests: Array<{ provider: string; model: string }> = [];
  const provider = buildWorkflowProvider(
    { model: recordingClient(requests) },
    { provider: "deepseek", modelId: "deepseek-v4-flash" },
  );
  assert.ok(provider, "有 model 客户端时应装配成功");
  await provider!.callLLM!("测试 prompt");
  assert.equal(requests[0]?.provider, "deepseek", "应继承会话 provider");
  assert.equal(requests[0]?.model, "deepseek-v4-flash", "应继承会话 model");
});

test("deps 显式 provider/modelId 优先于会话", async () => {
  const requests: Array<{ provider: string; model: string }> = [];
  const provider = buildWorkflowProvider(
    { model: recordingClient(requests), provider: "anthropic", modelId: "claude-x" },
    { provider: "deepseek", modelId: "deepseek-v4-flash" },
  );
  await provider!.callLLM!("x");
  assert.equal(requests[0]?.provider, "anthropic");
  assert.equal(requests[0]?.model, "claude-x");
});

test("modelHint 命中映射时覆盖会话与默认", async () => {
  const requests: Array<{ provider: string; model: string }> = [];
  const provider = buildWorkflowProvider(
    {
      model: recordingClient(requests),
      modelHints: { cheap: { provider: "deepseek", model: "deepseek-v4-flash" } },
    },
    { provider: "anthropic", modelId: "claude-x" },
  );
  await provider!.callLLM!("x", { modelHint: "cheap" });
  assert.equal(requests[0]?.provider, "deepseek");
  assert.equal(requests[0]?.model, "deepseek-v4-flash");
});

test("无会话无 deps 时回退全局默认", async () => {
  const requests: Array<{ provider: string; model: string }> = [];
  const provider = buildWorkflowProvider({ model: recordingClient(requests) }, {});
  await provider!.callLLM!("x");
  assert.equal(requests[0]?.provider, DEFAULT_MODEL_PROVIDER);
  assert.equal(requests[0]?.model, DEFAULT_MODEL_ID);
});
