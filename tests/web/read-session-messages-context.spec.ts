import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { CanonicalModelRequest } from "../../src/model/index.js";
import {
  createModelContextSnapshot,
  writeModelContextSnapshot,
} from "../../src/session/context/ModelContextSnapshot.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";

function makeRequest(): CanonicalModelRequest {
  return {
    provider: "test-provider",
    model: "test-model",
    systemPrompt: "You are Sati.",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
  };
}

async function seed(projectRoot: string, pilotHome: string, sessionKey: string, turns: string[]) {
  const storage = createAgentProjectSessionStorage({
    flushThresholdBytes: 0,
    projectRoot,
    pilotHome,
    sessionId: sessionKey,
    now: () => new Date("2026-11-07T00:00:00.000Z"),
  });
  for (const turnId of turns) {
    await storage.transcript.recordAcceptedInput(sessionKey, turnId, [
      { role: "user", content: [{ type: "text", text: `request ${turnId}` }] },
    ]);
    await storage.transcript.recordDurableMessage(sessionKey, turnId, {
      role: "assistant",
      content: [{ type: "text", text: `answer ${turnId}` }],
    });
  }
  return storage.transcriptPath;
}

test("未请求时零额外读取：不返回 modelContext 字段", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-rsm-ctx-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-rsm-ctx-home-"));
  try {
    const sessionKey = "web:ctx_not_requested";
    await seed(projectRoot, pilotHome, sessionKey, ["turn-1"]);

    const result = await readWebSessionMessages({ sessionKey }, { projectRoot, pilotHome });

    assert.equal("modelContext" in result, false);
    assert.equal("modelContextStatus" in result, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("请求完整快照且 turnId 匹配时返回内容", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-rsm-ctx-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-rsm-ctx-home-"));
  try {
    const sessionKey = "web:ctx_available";
    const transcriptPath = await seed(projectRoot, pilotHome, sessionKey, ["turn-1", "turn-2"]);
    const snapshot = createModelContextSnapshot(makeRequest(), "turn-2");
    await writeModelContextSnapshot(transcriptPath, snapshot);

    const result = await readWebSessionMessages({ sessionKey, includeModelContext: true }, { projectRoot, pilotHome });

    assert.equal(result.modelContextStatus, "available");
    assert.deepEqual(result.modelContext, snapshot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("summary 模式只返回元信息与体积", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-rsm-ctx-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-rsm-ctx-home-"));
  try {
    const sessionKey = "web:ctx_summary";
    const transcriptPath = await seed(projectRoot, pilotHome, sessionKey, ["turn-1"]);
    await writeModelContextSnapshot(transcriptPath, createModelContextSnapshot(makeRequest(), "turn-1"));

    const result = await readWebSessionMessages(
      { sessionKey, includeModelContext: "summary" },
      { projectRoot, pilotHome },
    );

    assert.equal(result.modelContextStatus, "available");
    const context = result.modelContext as Record<string, unknown> | undefined;
    assert.equal(context?.turnId, "turn-1");
    assert.equal("systemPrompt" in (context ?? {}), false);
    assert.equal("tools" in (context ?? {}), false);
    assert.equal("messages" in (context ?? {}), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("快照属于更早回合时标记 stale，不返回旧内容", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-rsm-ctx-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-rsm-ctx-home-"));
  try {
    const sessionKey = "web:ctx_stale";
    const transcriptPath = await seed(projectRoot, pilotHome, sessionKey, ["turn-1", "turn-2"]);
    await writeModelContextSnapshot(transcriptPath, createModelContextSnapshot(makeRequest(), "turn-1"));

    const result = await readWebSessionMessages({ sessionKey, includeModelContext: true }, { projectRoot, pilotHome });

    assert.equal(result.modelContextStatus, "stale");
    assert.equal("modelContext" in result, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("没有 sidecar 时标记 missing", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-rsm-ctx-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-rsm-ctx-home-"));
  try {
    const sessionKey = "web:ctx_missing";
    await seed(projectRoot, pilotHome, sessionKey, ["turn-1"]);

    const result = await readWebSessionMessages({ sessionKey, includeModelContext: true }, { projectRoot, pilotHome });

    assert.equal(result.modelContextStatus, "missing");
    assert.equal("modelContext" in result, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
