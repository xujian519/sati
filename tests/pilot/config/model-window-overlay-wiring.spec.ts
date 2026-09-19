/**
 * 窗口覆盖层的真实加载路径接线（issue #449）。
 *
 * 单测已覆盖 parseModelConfig 的优先级；本文件锁定**端到端**：`loadPilotConfig`
 * 从 `<pilotHome>/model-windows.json` 读到的事实，确实进入了最终模型能力
 * （也就是压缩阈值/blocking 判定实际使用的那个数）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";

const NOW = "2026-09-19T00:00:00.000Z";

const SATI_YAML = [
  "schemaVersion: 1",
  "agent:",
  "  model: openai/custom-model",
  "model:",
  "  providers:",
  "    openai:",
  "      protocol: openai",
  "      url: https://example.test/v1",
  "      apiKey: test-key",
  "      models:",
  "        custom-model: {}",
  "telemetry:",
  "  enabled: false",
  "",
].join("\n");

async function loadWith(entries?: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "sati-window-wiring-"));
  await writeFile(join(dir, "sati.yaml"), SATI_YAML, "utf8");
  if (entries) {
    await writeFile(join(dir, "model-windows.json"), JSON.stringify({ version: 1, entries }), "utf8");
  }
  const snapshot = loadPilotConfig({
    env: { SATI_HOME: dir, SATI_KNOWLEDGE_DIR: join(dir, "knowledge-absent") },
    projectRoot: dir,
  });
  return { dir, snapshot };
}

test("无覆盖层文件：catalog 未命中的模型仍按协议默认（128k），行为与改动前一致", async () => {
  const { dir, snapshot } = await loadWith();
  try {
    const model = snapshot.config.model.providers.openai?.models["custom-model"];
    assert.equal(model?.capabilities.maxContextTokens, 128000);
    assert.equal(snapshot.config.model.windowOverrides, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("覆盖层文件存在：生效窗口与来源都取自覆盖层（端到端接线）", async () => {
  const { dir, snapshot } = await loadWith({
    "openai/custom-model": { maxContextTokens: 262144, source: "probe", updatedAt: NOW, via: "context_length" },
  });
  try {
    const model = snapshot.config.model.providers.openai?.models["custom-model"];
    assert.equal(model?.capabilities.maxContextTokens, 262144);
    assert.equal(snapshot.config.model.windowOverrides?.["openai/custom-model"]?.source, "probe");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("覆盖层为实测（observed）：同样生效，来源标注为 observed", async () => {
  const { dir, snapshot } = await loadWith({
    "openai/custom-model": {
      maxContextTokens: 131072,
      source: "observed",
      updatedAt: NOW,
      via: "provider-context-cap",
    },
  });
  try {
    const model = snapshot.config.model.providers.openai?.models["custom-model"];
    assert.equal(model?.capabilities.maxContextTokens, 131072);
    assert.equal(snapshot.config.model.windowOverrides?.["openai/custom-model"]?.source, "observed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("损坏的覆盖层文件不影响配置加载（fail-open）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-window-wiring-"));
  try {
    await writeFile(join(dir, "sati.yaml"), SATI_YAML, "utf8");
    await writeFile(join(dir, "model-windows.json"), "{ not json", "utf8");
    const snapshot = loadPilotConfig({
      env: { SATI_HOME: dir, SATI_KNOWLEDGE_DIR: join(dir, "knowledge-absent") },
      projectRoot: dir,
    });
    assert.equal(snapshot.config.model.providers.openai?.models["custom-model"]?.capabilities.maxContextTokens, 128000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
