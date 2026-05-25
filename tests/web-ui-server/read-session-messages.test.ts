import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";
import { createProjectId } from "../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";

function makeFixture(projectRoot: string, pilotHome: string, sessionKey: string): void {
  const projectId = createProjectId(projectRoot);
  const chatDir = join(pilotHome, "projects", projectId, "chats");
  mkdirSync(chatDir, { recursive: true });
  const safeId = sanitizeSessionIdForPath(sessionKey);
  const path = join(chatDir, `${safeId}.jsonl`);
  // Minimal transcript: an accepted_input + assistant message + turn_result
  // so replayTranscriptEntries keeps both messages.
  const lines = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello?" }] },
      ],
    },
    {
      type: "assistant_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 2,
      createdAt: "2026-01-01T00:00:00.500Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi there" }],
      },
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 3,
      createdAt: "2026-01-01T00:00:01.000Z",
      result: {
        type: "success",
        sessionId: sessionKey,
        turnId: "turn-1",
        stopReason: "completed",
        usage: { totalTokens: 1 },
        permissionDenials: [],
        turns: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      },
    },
  ];
  const content = lines.map((line) => JSON.stringify(line)).join("\n");
  writeFileSync(path, content + "\n");
}

test("readWebSessionMessages returns user + assistant messages in order", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-rsm-"));
  const projectRoot = join(pilotHome, "fake-project");
  mkdirSync(projectRoot, { recursive: true });
  const sessionKey = "web:demo";
  try {
    makeFixture(projectRoot, pilotHome, sessionKey);
    const result = await readWebSessionMessages(
      { sessionKey },
      { projectRoot, pilotHome, now: () => new Date("2026-05-09T00:00:00.000Z") },
    );
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, "user");
    assert.equal(result.messages[0].kind, "text");
    assert.equal(result.messages[0].text, "hello?");
    assert.equal(result.messages[1].role, "assistant");
    assert.equal(result.messages[1].text, "hi there");
    assert.equal(result.session.sessionKey, sessionKey);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("readWebSessionMessages resolves transcript paths from input.projectKey when provided", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-rsm-project-key-"));
  const defaultProjectRoot = join(pilotHome, "default-project");
  const cronProjectRoot = join(pilotHome, "cron-project");
  mkdirSync(defaultProjectRoot, { recursive: true });
  mkdirSync(cronProjectRoot, { recursive: true });
  const sessionKey = "cron:task-1";
  try {
    makeFixture(cronProjectRoot, pilotHome, sessionKey);
    const result = await readWebSessionMessages(
      { sessionKey, projectKey: cronProjectRoot },
      { projectRoot: defaultProjectRoot, pilotHome, now: () => new Date("2026-05-09T00:00:00.000Z") },
    );
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].text, "hello?");
    assert.equal(result.messages[1].text, "hi there");
    assert.equal(result.session.cwd, cronProjectRoot);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("readWebSessionMessages filters out synthetic messages", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-rsm-synth-"));
  const projectRoot = join(pilotHome, "fake-project");
  mkdirSync(projectRoot, { recursive: true });
  const sessionKey = "web:synth";
  try {
    const projectId = createProjectId(projectRoot);
    const chatDir = join(pilotHome, "projects", projectId, "chats");
    mkdirSync(chatDir, { recursive: true });
    const path = join(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`);
    const lines = [
      {
        type: "accepted_input",
        sessionId: sessionKey,
        turnId: "turn-1",
        sequence: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        messages: [
          { role: "user", content: [{ type: "text", text: "hello?" }] },
        ],
      },
      {
        type: "assistant_message",
        sessionId: sessionKey,
        turnId: "turn-1",
        sequence: 2,
        createdAt: "2026-01-01T00:00:00.300Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "bad json" }],
        },
      },
      {
        type: "durable_message",
        sessionId: sessionKey,
        turnId: "turn-1",
        sequence: 3,
        createdAt: "2026-01-01T00:00:00.500Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Please retry with valid JSON." }],
          metadata: { synthetic: true, purpose: "json_self_correct" },
        },
      },
      {
        type: "assistant_message",
        sessionId: sessionKey,
        turnId: "turn-1",
        sequence: 4,
        createdAt: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "fixed response" }],
        },
      },
      {
        type: "turn_result",
        sessionId: sessionKey,
        turnId: "turn-1",
        sequence: 5,
        createdAt: "2026-01-01T00:00:01.500Z",
        result: {
          type: "success",
          sessionId: sessionKey,
          turnId: "turn-1",
          stopReason: "completed",
          usage: { totalTokens: 10 },
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.500Z",
        },
      },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await readWebSessionMessages(
      { sessionKey },
      { projectRoot, pilotHome, now: () => new Date("2026-05-09T00:00:00.000Z") },
    );
    const texts = result.messages
      .filter((m) => m.kind === "text")
      .map((m) => m.text);
    assert.ok(!texts.includes("Please retry with valid JSON."),
      "synthetic json_self_correct message should be filtered out");
    assert.ok(texts.includes("hello?"), "user message should be present");
    assert.ok(texts.includes("fixed response"), "non-synthetic assistant message should be present");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("readWebSessionMessages preserves tool error codes for permission UI gating", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-rsm-error-code-"));
  const projectRoot = join(pilotHome, "fake-project");
  mkdirSync(projectRoot, { recursive: true });
  const sessionKey = "web:error-code";
  try {
    const projectId = createProjectId(projectRoot);
    const chatDir = join(pilotHome, "projects", projectId, "chats");
    mkdirSync(chatDir, { recursive: true });
    const path = join(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`);
    const lines = [
      {
        type: "accepted_input",
        sessionId: sessionKey,
        turnId: "turn-timeout",
        sequence: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        messages: [
          { role: "user", content: [{ type: "text", text: "run a long command" }] },
        ],
      },
      {
        type: "assistant_message",
        sessionId: sessionKey,
        turnId: "turn-timeout",
        sequence: 2,
        createdAt: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "tool-bash",
              name: "bash",
              input: { command: "brew install something" },
            },
          ],
        },
      },
      {
        type: "tool_result_message",
        sessionId: sessionKey,
        turnId: "turn-timeout",
        sequence: 3,
        createdAt: "2026-01-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "tool-bash",
              content: [{ type: "text", text: "Command timed out after 120000ms." }],
              isError: true,
              raw: {
                type: "error",
                toolCallId: "tool-bash",
                toolName: "bash",
                error: { code: "tool_timeout", message: "Command timed out after 120000ms." },
                content: [{ type: "text", text: "Command timed out after 120000ms." }],
                startedAt: "2026-01-01T00:00:01.000Z",
                completedAt: "2026-01-01T00:00:02.000Z",
              },
            },
          ],
        },
      },
      {
        type: "turn_result",
        sessionId: sessionKey,
        turnId: "turn-timeout",
        sequence: 4,
        createdAt: "2026-01-01T00:00:03.000Z",
        result: {
          type: "success",
          sessionId: sessionKey,
          turnId: "turn-timeout",
          stopReason: "completed",
          usage: { totalTokens: 10 },
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:03.000Z",
        },
      },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await readWebSessionMessages(
      { sessionKey },
      { projectRoot, pilotHome, now: () => new Date("2026-05-09T00:00:00.000Z") },
    );
    const toolResult = result.messages.find((message) => message.kind === "tool_result");
    assert.equal(toolResult?.errorCode, "tool_timeout");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("readWebSessionMessages restores incomplete turns with continuous tool calls", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-rsm-incomplete-tools-"));
  const projectRoot = join(pilotHome, "fake-project");
  mkdirSync(projectRoot, { recursive: true });
  const sessionKey = "web:incomplete-tools";
  try {
    const projectId = createProjectId(projectRoot);
    const chatDir = join(pilotHome, "projects", projectId, "chats");
    mkdirSync(chatDir, { recursive: true });
    const path = join(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`);
    const lines = [
      {
        type: "accepted_input",
        sessionId: sessionKey,
        turnId: "turn-incomplete",
        sequence: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        messages: [
          { role: "user", content: [{ type: "text", text: "查一下最近新闻，连续用工具" }] },
        ],
      },
      {
        type: "assistant_message",
        sessionId: sessionKey,
        turnId: "turn-incomplete",
        sequence: 2,
        createdAt: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "我先搜索。" },
            {
              type: "tool_call",
              id: "tool-search",
              name: "web_search",
              input: { query: "中美会谈", gl: "CN" },
            },
          ],
        },
      },
      {
        type: "tool_result_message",
        sessionId: sessionKey,
        turnId: "turn-incomplete",
        sequence: 3,
        createdAt: "2026-01-01T00:00:02.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "tool-search",
              content: [{ type: "text", text: "搜索结果摘要" }],
              isError: false,
            },
          ],
        },
      },
      {
        type: "assistant_message",
        sessionId: sessionKey,
        turnId: "turn-incomplete",
        sequence: 4,
        createdAt: "2026-01-01T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "tool-fetch",
              name: "web_fetch",
              input: { url: "https://example.com/news", prompt: "提取要点" },
            },
          ],
        },
      },
      {
        type: "tool_result_message",
        sessionId: sessionKey,
        turnId: "turn-incomplete",
        sequence: 5,
        createdAt: "2026-01-01T00:00:04.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "tool-fetch",
              content: [{ type: "text", text: "网页提取结果" }],
              isError: false,
            },
          ],
        },
      },
      // Intentionally no turn_result: this is the exact shape users hit
      // when a running turn is interrupted or the page reconnects mid-run.
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await readWebSessionMessages(
      { sessionKey },
      { projectRoot, pilotHome, now: () => new Date("2026-05-09T00:00:00.000Z") },
    );

    assert.deepEqual(
      result.messages.map((message) => message.kind),
      ["text", "text", "tool_use", "tool_result", "tool_use", "tool_result", "status"],
    );
    assert.equal(result.messages[2].toolName, "web_search");
    assert.deepEqual(result.messages[2].payload, { query: "中美会谈", gl: "CN" });
    assert.equal(result.messages[3].text, "搜索结果摘要");
    assert.equal(result.messages[4].toolName, "web_fetch");
    assert.equal(result.messages[5].text, "网页提取结果");
    assert.match(result.messages[6].text ?? "", /未正常结束|中断/);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("readWebSessionMessages paginates with cursor + limit", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-rsm-page-"));
  const projectRoot = join(pilotHome, "fake-project");
  mkdirSync(projectRoot, { recursive: true });
  const sessionKey = "web:page";
  try {
    makeFixture(projectRoot, pilotHome, sessionKey);
    const page1 = await readWebSessionMessages(
      { sessionKey, limit: 1 },
      { projectRoot, pilotHome },
    );
    assert.equal(page1.messages.length, 1);
    assert.equal(page1.nextCursor, "1");
    assert.equal(page1.total, 2);

    const page2 = await readWebSessionMessages(
      { sessionKey, limit: 1, cursor: page1.nextCursor },
      { projectRoot, pilotHome },
    );
    assert.equal(page2.messages.length, 1);
    assert.equal(page2.nextCursor, undefined);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
