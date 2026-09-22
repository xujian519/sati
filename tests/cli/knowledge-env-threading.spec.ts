/**
 * `createLocalGateway({ env })` 的 env 必须真的被下游消费。
 *
 * 起因（测量脚本发现的真实缺口）：`projectRuntimeFactory` 解析知识库路径时调
 * `resolveKnowledgeDbPaths()` 而未传 `deps.env`，于是调用方给的
 * `SATI_KNOWLEDGE_DIR` / `SATI_LAW_DB` 等覆盖被静默忽略、回落到宿主 `process.env`。
 * 后果不只是测量不可复现：任何以自定义 env 构造网关的调用方（桌面壳、测试、脚本）
 * 都会意外读到宿主本机的知识库。
 *
 * 断言走真实网关接线 + 公开出口 `knowledgeCapabilities`（`dataDir` 与各能力状态同源），
 * 因为要钉住的正是「接线是否把 env 传下去」。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";

const BASE_CONFIG = [
  "schemaVersion: 1",
  "agent:",
  "  model: test/model",
  "  maxContextTokens: 131072",
  "  maxOutputTokens: 8192",
  "model:",
  "  providers:",
  "    test:",
  "      protocol: openai",
  "      url: https://example.test/v1",
  "      apiKey: test-key",
  "      models:",
  "        model: {}",
  "telemetry:",
  "  enabled: false",
  "",
].join("\n");

function fakeModelRuntime(requests: CanonicalModelRequest[]): ModelRuntime {
  return {
    stream: async function* (request) {
      requests.push(request);
      yield { type: "text_delta", text: "ok" };
    },
    complete: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" }),
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => undefined,
  };
}

test("知识库路径解析使用调用方 env（缺失目录 ⇒ 数据源不可用）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-knowledge-env-"));
  await writeFile(join(root, "sati.yaml"), BASE_CONFIG, "utf8");
  // 目录不存在：若 env 被透传，所有依赖数据目录的能力都必须是 unavailable。
  const absentDir = join(root, "knowledge-absent");
  const requests: CanonicalModelRequest[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: { SATI_KNOWLEDGE_DIR: absentDir },
    __testModelFactory: () => fakeModelRuntime(requests),
  });
  try {
    const report = await local.gateway.knowledgeCapabilities?.({ projectKey: root });
    assert.ok(report, "网关应实现 knowledgeCapabilities");
    assert.equal(report.dataDir, absentDir, "dataDir 必须来自调用方 env");
    const statusById = new Map<string, string>(
      report.capabilities.map(capability => [capability.id, capability.status]),
    );
    for (const id of ["patent-kg", "legal-fts", "case-law"]) {
      const status = statusById.get(id);
      assert.ok(status !== undefined, `${id} 应出现在自检清单里`);
      assert.notEqual(status, "ready", `${id} 在缺失数据目录下不应 ready`);
    }
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
