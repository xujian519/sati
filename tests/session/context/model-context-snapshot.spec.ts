import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import {
  createModelContextSnapshot,
  modelContextSnapshotPath,
  readModelContextSnapshot,
  summarizeModelContext,
  writeModelContextSnapshot,
} from "../../../src/session/context/ModelContextSnapshot.js";

function request(overrides: Partial<CanonicalModelRequest> = {}): CanonicalModelRequest {
  return {
    provider: "test-provider",
    model: "test-model",
    systemPrompt: "You are Sati.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe the image" },
          {
            type: "image",
            source: "base64",
            data: "AQIDBA==",
            mimeType: "image/png",
            bytes: 4,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "ok" }],
            raw: { secret: "should-not-leak" },
          },
        ],
      },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
    ...overrides,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-model-context-"));
}

test("createModelContextSnapshot 脱敏媒体与 tool_result raw", () => {
  const snapshot = createModelContextSnapshot(request(), "turn-1", new Date("2026-11-07T00:00:00.000Z"));

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.turnId, "turn-1");
  assert.equal(snapshot.mediaOmitted, true);
  assert.equal(snapshot.systemPrompt, "You are Sati.");
  assert.equal(snapshot.tools[0]?.name, "read_file");

  const image = snapshot.messages[0]?.content[1];
  assert.equal(image?.type, "image");
  if (image?.type === "image") {
    assert.equal(image.data, "[media payload omitted]");
    assert.equal(image.mimeType, "image/png");
  }

  const toolResult = snapshot.messages[1]?.content[0];
  assert.equal(toolResult?.type, "tool_result");
  if (toolResult?.type === "tool_result") {
    assert.equal("raw" in toolResult, false);
  }

  assert.ok(snapshot.breakdown.systemPromptChars > 0);
  assert.ok(snapshot.breakdown.toolsChars > 0);
  assert.ok(snapshot.breakdown.messagesChars > 0);
});

test("写入/读取 roundtrip，快照文件权限 0600", async () => {
  const dir = tempDir();
  try {
    const transcript = join(dir, "session.jsonl");
    writeFileSync(transcript, "{}\n");
    const snapshot = createModelContextSnapshot(request(), "turn-1");

    await writeModelContextSnapshot(transcript, snapshot);
    const restored = await readModelContextSnapshot(transcript);

    assert.deepEqual(restored, snapshot);
    assert.equal(modelContextSnapshotPath(transcript), `${transcript}.context.json`);
    const mode = statSync(`${transcript}.context.json`).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺失或坏 JSON 返回 null", async () => {
  const dir = tempDir();
  try {
    const transcript = join(dir, "session.jsonl");
    writeFileSync(transcript, "{}\n");
    assert.equal(await readModelContextSnapshot(transcript), null);

    writeFileSync(`${transcript}.context.json`, "{not-json");
    assert.equal(await readModelContextSnapshot(transcript), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("符号链接快照被拒绝", async () => {
  const dir = tempDir();
  try {
    const transcript = join(dir, "session.jsonl");
    const target = join(dir, "other.json");
    writeFileSync(transcript, "{}\n");
    writeFileSync(target, JSON.stringify(createModelContextSnapshot(request(), "turn-1")));
    symlinkSync(target, `${transcript}.context.json`);

    assert.equal(await readModelContextSnapshot(transcript), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarizeModelContext 只保留元信息与体积", () => {
  const snapshot = createModelContextSnapshot(request(), "turn-1");
  const summary = summarizeModelContext(snapshot);

  assert.equal("systemPrompt" in summary, false);
  assert.equal("tools" in summary, false);
  assert.equal("messages" in summary, false);
  assert.equal(summary.turnId, "turn-1");
  assert.deepEqual(summary.breakdown, snapshot.breakdown);
});

test("快照不修改原请求对象", () => {
  const original = request();
  createModelContextSnapshot(original, "turn-1");
  const image = original.messages[0]?.content[1];
  assert.equal(image?.type, "image");
  if (image?.type === "image") {
    assert.equal(image.data, "AQIDBA==");
  }
});
