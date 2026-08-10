import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { hashText } from "edgeclaw-memory-core";
import type { EmbeddingClient } from "../../../src/model/embedding/types.js";
import { EmbeddingRequestError } from "../../../src/model/embedding/client.js";
import type { PilotMemoryConfig } from "../../../src/pilot/config/types.js";
import { createEdgeClawMemoryProviderFromConfig } from "../../../src/context/memory/createEdgeClawMemoryProviderFromConfig.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-memory-factory-"));
}

/**
 * 在 rootDir/workspaces/<hash>/memory/ 下写入一个 project 记忆文件，
 * 让 warmup 走"list → get → embed"路径（空库时 upsert 为空、embed 不会被调用）。
 * 路径布局与 EdgeClawMemoryService 的 workspace 目录约定一致。
 */
function writeMemoryFile(rootDir: string, workspaceDir: string): void {
  const slug = hashText(resolve(workspaceDir));
  const filePath = join(rootDir, "workspaces", slug, "memory", "Project", "factory-test.md");
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      "name: factory test",
      "description: factory semantic index test",
      "type: project",
      "scope: project",
      "updated_at: " + new Date().toISOString(),
      "---",
      "",
      "## Summary",
      "Factory semantic index test content.",
      "",
    ].join("\n"),
  );
}

function makeConfig(rootDir: string): PilotMemoryConfig {
  return {
    enabled: true,
    provider: "edgeclaw",
    rootDir,
    captureStrategy: "last_turn",
    includeAssistant: false,
    maxMessageChars: 6000,
    embedding: { enabled: true, model: "test", baseUrl: "http://localhost:1", dimensions: 8, indexMemory: true },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("service 在 warmup 进行中关闭：记录 info 取消、不产生 warn", async () => {
  const rootDir = makeTempDir();
  writeMemoryFile(rootDir, "/workspace");

  // embed 进入时 resolve（测试据此知道 warmup 已推进到 embed），
  // 然后挂起在 gate 上，直到测试关闭 service 后再放行。
  let enterEmbed: () => void = () => {};
  const embedEntered = new Promise<void>(resolve => {
    enterEmbed = resolve;
  });
  let releaseEmbed!: () => void;
  const embedGate = new Promise<void>(resolve => {
    releaseEmbed = resolve;
  });

  const embeddingClient: EmbeddingClient = {
    dimensions: 8,
    async embed(texts) {
      enterEmbed();
      await embedGate;
      return texts.map(() => [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    },
    async healthCheck() {
      return true;
    },
  };

  const info: string[] = [];
  const warn: string[] = [];
  const result = createEdgeClawMemoryProviderFromConfig({
    config: makeConfig(rootDir),
    modelConfig: { providers: {} },
    agentModel: "test/test",
    projectRoot: "/workspace",
    embeddingClient,
    embeddingDir: join(rootDir, "embeddings"),
    logger: {
      info: (...args) => info.push(args.map(String).join(" ")),
      warn: (...args) => warn.push(args.map(String).join(" ")),
      error: () => {},
    },
  });
  assert.ok(result, "config 满足条件时应创建 provider");

  await embedEntered;
  result.service.close();
  releaseEmbed();

  await waitFor(() => info.some(line => line.includes("warmup cancelled")));
  assert.ok(
    info.some(line => line.includes("warmup cancelled")),
    "关闭场景应记录 info 取消日志",
  );
  assert.equal(
    warn.some(line => line.includes("warmup failed")),
    false,
    "关闭场景不应产生 warn",
  );
});

test("embedding 真实失败仍走 warn（不被当作服务关闭）", async () => {
  const rootDir = makeTempDir();
  writeMemoryFile(rootDir, "/workspace");

  const embeddingClient: EmbeddingClient = {
    dimensions: 8,
    async embed() {
      throw new Error("embedding service down");
    },
    async healthCheck() {
      return true;
    },
  };

  const warn: string[] = [];
  createEdgeClawMemoryProviderFromConfig({
    config: makeConfig(rootDir),
    modelConfig: { providers: {} },
    agentModel: "test/test",
    projectRoot: "/workspace",
    embeddingClient,
    embeddingDir: join(rootDir, "embeddings"),
    logger: {
      info: () => {},
      warn: (...args) => warn.push(args.map(String).join(" ")),
      error: () => {},
    },
  });

  await waitFor(() => warn.some(line => line.includes("warmup failed") && line.includes("embedding service down")));
});

test("embedding retryable 失败后重试成功，不产生 warn", async () => {
  const rootDir = makeTempDir();
  writeMemoryFile(rootDir, "/workspace");

  let embedCalls = 0;
  const embeddingClient: EmbeddingClient = {
    dimensions: 8,
    async embed(texts) {
      embedCalls += 1;
      if (embedCalls === 1) {
        // 模拟启动期 embedding 服务尚未就绪：retryable 网络错误。
        throw new EmbeddingRequestError("Embedding request failed: fetch failed", undefined, true);
      }
      return texts.map(() => new Array(8).fill(0.1));
    },
    async healthCheck() {
      return true;
    },
  };

  const warn: string[] = [];
  const info: string[] = [];
  createEdgeClawMemoryProviderFromConfig({
    config: makeConfig(rootDir),
    modelConfig: { providers: {} },
    agentModel: "test/test",
    projectRoot: "/workspace",
    embeddingClient,
    embeddingDir: join(rootDir, "embeddings"),
    logger: {
      info: (...args) => info.push(args.map(String).join(" ")),
      warn: (...args) => warn.push(args.map(String).join(" ")),
      error: () => {},
    },
  });

  await waitFor(() => embedCalls >= 2);
  assert.ok(
    info.some(line => line.includes("warmup retryable failure")),
    "重试前应记录 retryable 提示",
  );
  assert.equal(
    warn.some(line => line.includes("warmup failed")),
    false,
    "重试成功不应产生 warn",
  );
});
