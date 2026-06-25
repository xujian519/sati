import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import type { MemoryResolver } from "../../src/context/memory/MemoryResolver.js";
import type { CanonicalMessage } from "../../src/model/index.js";
import { ForkSessionError, forkWebSession } from "../../src/web/server/forkSession.js";
import { readSubagentWebMessages, readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { createProjectId } from "../../src/pilot/paths.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";

function textFromMessage(message: CanonicalMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

test("forkWebSession copies history before target turn and returns prefill text", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-fork-"));
  const projectRoot = join(pilotHome, "workspace");
  const chatDir = join(pilotHome, "projects", createProjectId(projectRoot), "chats");
  const sessionKey = "web:s_parent";
  const transcriptPath = join(chatDir, `${sessionKey}.jsonl`);

  await mkdir(chatDir, { recursive: true });

  const lines = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-06-24T00:00:00.000Z",
      entryId: "entry-1",
      parentEntryId: null,
      messages: [{ role: "user", content: [{ type: "text", text: "first question" }] }],
    },
    {
      type: "assistant_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 2,
      createdAt: "2026-06-24T00:00:01.000Z",
      entryId: "entry-2",
      parentEntryId: "entry-1",
      message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 3,
      createdAt: "2026-06-24T00:00:02.000Z",
      entryId: "entry-3",
      parentEntryId: "entry-2",
      result: { stopReason: "completed", usage: {} },
    },
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-2",
      sequence: 4,
      createdAt: "2026-06-24T00:01:00.000Z",
      entryId: "entry-4",
      parentEntryId: "entry-3",
      messages: [{ role: "user", content: [{ type: "text", text: "second question" }] }],
    },
  ];

  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  const result = await forkWebSession(
    { sessionKey, projectKey: projectRoot, fromEntryId: "entry-4" },
    { projectRoot, pilotHome, now: () => new Date("2026-06-24T01:00:00.000Z") },
  );

  assert.equal(result.prefillText, "second question");
  assert.equal(result.carriedMessageCount, 2);
  assert.match(result.newSessionKey, /^web[:-]s_/);

  const newTranscriptPath = join(chatDir, `${result.newSessionKey}.jsonl`);
  const { entries } = await readTranscript(newTranscriptPath);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries.map((entry) => entry.sessionId), [
    result.newSessionKey,
    result.newSessionKey,
    result.newSessionKey,
    result.newSessionKey,
  ]);
  assert.equal(entries[0].sequence, 1);
  assert.equal(entries[2].type, "turn_result");
  assert.equal(entries[3].type, "session_metadata");
  if (entries[0].type === "accepted_input") {
    assert.deepEqual(entries[0].messages[0]?.metadata?.forkCarryover, {
      sourceSessionId: sessionKey,
      sourceTurnId: "turn-1",
    });
  }
  if (entries[1].type === "assistant_message") {
    assert.deepEqual(entries[1].message.metadata?.forkCarryover, {
      sourceSessionId: sessionKey,
      sourceTurnId: "turn-1",
    });
  }
  if (entries[3].type === "session_metadata") {
    assert.equal(entries[3].metadata.parentSessionId, sessionKey);
    assert.equal(entries[3].metadata.forkedFromTurnId, "turn-2");
  }

  await rm(pilotHome, { recursive: true, force: true });
});

test("DefaultContextRuntime skips fork carryover messages during memory capture", async () => {
  const captured: CanonicalMessage[][] = [];
  const memoryResolver: MemoryResolver = {
    async retrieve() {
      return { diagnostics: [] };
    },
    async captureTurn(input) {
      captured.push(input.messages);
    },
  };
  const runtime = new DefaultContextRuntime({ memoryResolver });

  await runtime.captureTurn({
    sessionId: "web:s_fork",
    turnId: "turn-2",
    errored: false,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "parent history" }],
        metadata: {
          forkCarryover: {
            sourceSessionId: "web:s_parent",
            sourceTurnId: "turn-1",
          },
        },
      },
      {
        role: "user",
        content: [{ type: "text", text: "new fork turn" }],
      },
    ],
  });

  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]?.map(textFromMessage), ["new fork turn"]);
});

test("forkWebSession rejects non-text target turns instead of dropping attachments", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-fork-unsupported-"));
  const projectRoot = join(pilotHome, "workspace");
  const chatDir = join(pilotHome, "projects", createProjectId(projectRoot), "chats");
  const sessionKey = "web:s_unsupported";
  const transcriptPath = join(chatDir, `${sessionKey}.jsonl`);

  await mkdir(chatDir, { recursive: true });

  const lines = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-06-24T00:00:00.000Z",
      entryId: "entry-1",
      parentEntryId: null,
      messages: [{ role: "user", content: [{ type: "text", text: "first question" }] }],
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 2,
      createdAt: "2026-06-24T00:00:01.000Z",
      entryId: "entry-2",
      parentEntryId: "entry-1",
      result: { stopReason: "completed", usage: {} },
    },
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-2",
      sequence: 3,
      createdAt: "2026-06-24T00:01:00.000Z",
      entryId: "entry-3",
      parentEntryId: "entry-2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            {
              type: "image",
              source: "base64",
              data: "aW1hZ2U=",
              mimeType: "image/png",
            },
          ],
        },
      ],
    },
  ];

  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  await assert.rejects(
    () =>
      forkWebSession(
        { sessionKey, projectKey: projectRoot, fromEntryId: "entry-3" },
        { projectRoot, pilotHome },
      ),
    (error) => {
      assert.equal(error instanceof ForkSessionError, true);
      assert.equal((error as ForkSessionError).code, "fork_unsupported_content");
      return true;
    },
  );

  await rm(pilotHome, { recursive: true, force: true });
});

test("forkWebSession preserves plan mode for forked plan turns", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-fork-plan-"));
  const projectRoot = join(pilotHome, "workspace");
  const chatDir = join(pilotHome, "projects", createProjectId(projectRoot), "chats");
  const sessionKey = "web:s_plan_fork";
  const transcriptPath = join(chatDir, `${sessionKey}.jsonl`);

  await mkdir(chatDir, { recursive: true });

  const lines = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-plan",
      sequence: 1,
      createdAt: "2026-06-24T00:00:00.000Z",
      entryId: "entry-plan",
      parentEntryId: null,
      metadata: {
        permissionMode: "plan",
        basePermissionMode: "default",
        allowPlanModeTools: true,
      },
      messages: [{ role: "user", content: [{ type: "text", text: "design this safely" }] }],
    },
  ];

  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  const result = await forkWebSession(
    { sessionKey, projectKey: projectRoot, fromEntryId: "entry-plan" },
    { projectRoot, pilotHome },
  );

  assert.equal(result.prefillText, "design this safely");
  assert.equal(result.mode, "plan");

  await rm(pilotHome, { recursive: true, force: true });
});

test("readWebSessionMessages marks hidden media turns as unsupported fork targets", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-fork-media-marker-"));
  const projectRoot = join(pilotHome, "workspace");
  const chatDir = join(pilotHome, "projects", createProjectId(projectRoot), "chats");
  const sessionKey = "web:s_media_marker";
  const transcriptPath = join(chatDir, `${sessionKey}.jsonl`);

  await mkdir(chatDir, { recursive: true });

  const lines = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-06-24T00:00:00.000Z",
      entryId: "entry-1",
      parentEntryId: null,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "please inspect this pdf" },
            {
              type: "pdf",
              source: "base64",
              data: "JVBERi0xLjQK",
              mimeType: "application/pdf",
              bytes: 9,
              pages: 1,
            },
          ],
        },
      ],
    },
  ];

  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  const result = await readWebSessionMessages(
    { sessionKey, projectKey: projectRoot },
    { projectRoot, pilotHome },
  );

  const userMessage = result.messages.find(
    (message) => message.kind === "text" && message.entryId === "entry-1",
  );
  assert.ok(userMessage);
  assert.equal((userMessage.payload as { forkUnsupportedContent?: boolean }).forkUnsupportedContent, true);

  await rm(pilotHome, { recursive: true, force: true });
});

test("readWebSessionMessages reads background task transcripts by relative path", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-background-read-"));
  const projectRoot = join(pilotHome, "workspace");
  const chatDir = join(pilotHome, "projects", createProjectId(projectRoot), "chats");
  const parentSessionId = "web:s_parent_background";
  const backgroundSessionId = "background-web-s_parent_background-agent-cron";
  const relativeTranscriptPath = `${parentSessionId}/subagents/agent-cron.jsonl`;
  const transcriptPath = join(chatDir, relativeTranscriptPath);

  await mkdir(join(chatDir, parentSessionId, "subagents"), { recursive: true });
  const lines = [
    {
      type: "accepted_input",
      sessionId: backgroundSessionId,
      turnId: "bg-turn-1",
      sequence: 1,
      createdAt: "2026-06-24T00:00:00.000Z",
      entryId: "bg-entry-1",
      parentEntryId: null,
      messages: [{ role: "user", content: [{ type: "text", text: "background prompt" }] }],
    },
    {
      type: "assistant_message",
      sessionId: backgroundSessionId,
      turnId: "bg-turn-1",
      sequence: 2,
      createdAt: "2026-06-24T00:00:01.000Z",
      entryId: "bg-entry-2",
      parentEntryId: "bg-entry-1",
      message: { role: "assistant", content: [{ type: "text", text: "background result" }] },
    },
    {
      type: "turn_result",
      sessionId: backgroundSessionId,
      turnId: "bg-turn-1",
      sequence: 3,
      createdAt: "2026-06-24T00:00:02.000Z",
      entryId: "bg-entry-3",
      parentEntryId: "bg-entry-2",
      result: { stopReason: "completed", usage: {} },
    },
  ];
  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  const result = await readWebSessionMessages(
    {
      sessionKey: backgroundSessionId,
      projectKey: projectRoot,
      sessionKind: "background_task",
      parentSessionId,
      relativeTranscriptPath,
    },
    { projectRoot, pilotHome },
  );

  assert.deepEqual(
    result.messages.filter((message) => message.kind === "text").map((message) => message.text),
    ["background prompt", "background result"],
  );
  assert.equal(result.session.sessionKind, "background_task");
  assert.equal(result.session.parentSessionId, parentSessionId);
  assert.equal(result.session.relativeTranscriptPath, relativeTranscriptPath);

  await rm(pilotHome, { recursive: true, force: true });
});

test("readSubagentWebMessages resolves subagents from background task transcripts", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-background-subagent-"));
  const projectRoot = join(pilotHome, "workspace");
  const chatDir = join(pilotHome, "projects", createProjectId(projectRoot), "chats");
  const parentSessionId = "web:s_parent_background_subagent";
  const backgroundSessionId = "background-web-s_parent_background_subagent-agent-cron";
  const relativeTranscriptPath = `${parentSessionId}/subagents/agent-cron.jsonl`;
  const backgroundDir = join(chatDir, parentSessionId, "subagents");
  const subagentRelativePath = "agent-cron/subagents/sub-bg.jsonl";

  await mkdir(join(backgroundDir, "agent-cron", "subagents"), { recursive: true });
  const parentLines = [
    {
      type: "accepted_input",
      sessionId: backgroundSessionId,
      turnId: "bg-turn-1",
      sequence: 1,
      createdAt: "2026-06-24T00:00:00.000Z",
      entryId: "bg-entry-1",
      parentEntryId: null,
      messages: [{ role: "user", content: [{ type: "text", text: "background prompt" }] }],
    },
    {
      type: "subagent_started",
      sessionId: backgroundSessionId,
      turnId: "bg-turn-1",
      sequence: 2,
      createdAt: "2026-06-24T00:00:01.000Z",
      entryId: "bg-entry-2",
      parentEntryId: "bg-entry-1",
      subagentId: "sub-bg",
      subagentType: "general-purpose",
      promptPreview: "inspect",
      promptTruncated: false,
      transcriptRelativePath: subagentRelativePath,
    },
  ];
  const sidechainLines = [
    {
      type: "accepted_input",
      sessionId: `${projectRoot}::sub::sub-bg`,
      turnId: "sub-turn-1",
      sequence: 1,
      createdAt: "2026-06-24T00:00:01.100Z",
      entryId: "sub-entry-1",
      parentEntryId: null,
      messages: [{ role: "user", content: [{ type: "text", text: "inspect" }] }],
    },
    {
      type: "assistant_message",
      sessionId: `${projectRoot}::sub::sub-bg`,
      turnId: "sub-turn-1",
      sequence: 2,
      createdAt: "2026-06-24T00:00:01.200Z",
      entryId: "sub-entry-2",
      parentEntryId: "sub-entry-1",
      message: { role: "assistant", content: [{ type: "text", text: "subagent result" }] },
    },
  ];
  await writeFile(
    join(chatDir, relativeTranscriptPath),
    `${parentLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    join(backgroundDir, subagentRelativePath),
    `${sidechainLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );

  const result = await readSubagentWebMessages(
    {
      sessionKey: backgroundSessionId,
      subagentId: "sub-bg",
      projectKey: projectRoot,
      sessionKind: "background_task",
      parentSessionId,
      relativeTranscriptPath,
    },
    { projectRoot, pilotHome },
  );

  assert.deepEqual(
    result.messages.filter((message) => message.kind === "text").map((message) => message.text),
    ["subagent result"],
  );

  await rm(pilotHome, { recursive: true, force: true });
});

test("forkWebSession rewrites copied auxiliary references to the new session", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-fork-aux-"));
  const projectRoot = join(pilotHome, "workspace");
  const chatDir = join(pilotHome, "projects", createProjectId(projectRoot), "chats");
  const sessionKey = "web:s_parent_aux";
  const safeSessionKey = sanitizeSessionIdForPath(sessionKey);
  const sourceSessionDir = join(chatDir, safeSessionKey);
  const transcriptPath = join(chatDir, `${safeSessionKey}.jsonl`);
  const sourceToolResultPath = join(sourceSessionDir, "tool-results", "tc-1.txt");
  const sourceMediaPath = join(sourceSessionDir, "tool-results", "media-1.png");
  const sourceSubagentPath = join(sourceSessionDir, "subagents", "sub-1.jsonl");
  const sourceSubagentRelativePath = `${safeSessionKey}/subagents/sub-1.jsonl`;

  await mkdir(join(sourceSessionDir, "tool-results"), { recursive: true });
  await mkdir(join(sourceSessionDir, "subagents"), { recursive: true });
  await writeFile(sourceToolResultPath, "full tool result", "utf8");
  await writeFile(sourceMediaPath, "base64-media", "utf8");
  const sidechainSessionId = `${projectRoot}::sub::sub-1`;
  const sidechainLines = [
    {
      type: "accepted_input",
      sessionId: sidechainSessionId,
      turnId: "sub-turn-1",
      sequence: 1,
      createdAt: "2026-06-24T00:00:02.100Z",
      entryId: "sub-entry-1",
      parentEntryId: null,
      messages: [{ role: "user", content: [{ type: "text", text: "inspect" }] }],
    },
    {
      type: "durable_message",
      sessionId: sidechainSessionId,
      turnId: "sub-turn-1",
      sequence: 2,
      createdAt: "2026-06-24T00:00:02.200Z",
      entryId: "sub-entry-2",
      parentEntryId: "sub-entry-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result_reference",
            toolCallId: "sub-tc-1",
            path: sourceToolResultPath,
            originalBytes: 16,
            preview: "full",
            hasMore: true,
            mimeType: "text/plain",
            reason: "tool_result_too_large",
          },
          {
            type: "media_reference",
            toolCallId: "sub-tc-1",
            path: sourceMediaPath,
            originalBytes: 12,
            preview: "media",
            hasMore: true,
            mimeType: "image/png",
            mediaType: "image",
            reason: "media_result_too_large",
          },
        ],
      },
    },
    {
      type: "turn_result",
      sessionId: sidechainSessionId,
      turnId: "sub-turn-1",
      sequence: 3,
      createdAt: "2026-06-24T00:00:02.300Z",
      entryId: "sub-entry-3",
      parentEntryId: "sub-entry-2",
      result: { stopReason: "completed", usage: {} },
    },
  ];
  await writeFile(
    sourceSubagentPath,
    `${sidechainLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );

  const lines = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-06-24T00:00:00.000Z",
      entryId: "entry-1",
      parentEntryId: null,
      messages: [{ role: "user", content: [{ type: "text", text: "first question" }] }],
    },
    {
      type: "durable_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 2,
      createdAt: "2026-06-24T00:00:01.000Z",
      entryId: "entry-2",
      parentEntryId: "entry-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result_reference",
            toolCallId: "tc-1",
            path: sourceToolResultPath,
            originalBytes: 16,
            preview: "full",
            hasMore: true,
            mimeType: "text/plain",
            reason: "tool_result_too_large",
          },
          {
            type: "media_reference",
            toolCallId: "tc-1",
            path: sourceMediaPath,
            originalBytes: 12,
            preview: "media",
            hasMore: true,
            mimeType: "image/png",
            mediaType: "image",
            reason: "media_result_too_large",
          },
        ],
      },
    },
    {
      type: "subagent_started",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 3,
      createdAt: "2026-06-24T00:00:02.000Z",
      entryId: "entry-3",
      parentEntryId: "entry-2",
      subagentId: "sub-1",
      subagentType: "general-purpose",
      promptPreview: "inspect",
      promptTruncated: false,
      transcriptRelativePath: sourceSubagentRelativePath,
      subagentSessionId: sidechainSessionId,
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 4,
      createdAt: "2026-06-24T00:00:03.000Z",
      entryId: "entry-4",
      parentEntryId: "entry-3",
      result: { stopReason: "completed", usage: {} },
    },
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-2",
      sequence: 5,
      createdAt: "2026-06-24T00:01:00.000Z",
      entryId: "entry-5",
      parentEntryId: "entry-4",
      messages: [{ role: "user", content: [{ type: "text", text: "second question" }] }],
    },
  ];

  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  const result = await forkWebSession(
    { sessionKey, projectKey: projectRoot, fromEntryId: "entry-5" },
    { projectRoot, pilotHome, now: () => new Date("2026-06-24T01:00:00.000Z") },
  );
  const newSafeId = sanitizeSessionIdForPath(result.newSessionKey);
  const { entries } = await readTranscript(join(chatDir, `${newSafeId}.jsonl`));
  const durable = entries.find((entry) => entry.entryId === "entry-2");
  assert.equal(durable?.type, "durable_message");
  if (durable?.type === "durable_message") {
    const [toolReference, mediaReference] = durable.message.content;
    assert.equal(toolReference.type, "tool_result_reference");
    assert.equal(mediaReference.type, "media_reference");
    if (toolReference.type === "tool_result_reference") {
      assert.equal(toolReference.path, join(chatDir, newSafeId, "tool-results", "tc-1.txt"));
      assert.equal(await readFile(toolReference.path, "utf8"), "full tool result");
    }
    if (mediaReference.type === "media_reference") {
      assert.equal(mediaReference.path, join(chatDir, newSafeId, "tool-results", "media-1.png"));
      assert.equal(await readFile(mediaReference.path, "utf8"), "base64-media");
    }
  }
  const subagentStarted = entries.find((entry) => entry.entryId === "entry-3");
  assert.equal(subagentStarted?.type, "subagent_started");
  if (subagentStarted?.type === "subagent_started") {
    assert.equal(subagentStarted.transcriptRelativePath, `${newSafeId}/subagents/sub-1.jsonl`);
    const { entries: sidechainEntries } = await readTranscript(
      join(chatDir, subagentStarted.transcriptRelativePath),
    );
    const sidechainDurable = sidechainEntries.find((entry) => entry.entryId === "sub-entry-2");
    assert.equal(sidechainDurable?.type, "durable_message");
    if (sidechainDurable?.type === "durable_message") {
      const [toolReference, mediaReference] = sidechainDurable.message.content;
      assert.equal(toolReference.type, "tool_result_reference");
      assert.equal(mediaReference.type, "media_reference");
      if (toolReference.type === "tool_result_reference") {
        assert.equal(toolReference.path, join(chatDir, newSafeId, "tool-results", "tc-1.txt"));
      }
      if (mediaReference.type === "media_reference") {
        assert.equal(mediaReference.path, join(chatDir, newSafeId, "tool-results", "media-1.png"));
      }
    }
  }

  await rm(pilotHome, { recursive: true, force: true });
});

test("readWebSessionMessages keeps entry ids aligned after synthetic messages are hidden", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-fork-entryid-"));
  const projectRoot = join(pilotHome, "workspace");
  const chatDir = join(pilotHome, "projects", createProjectId(projectRoot), "chats");
  const sessionKey = "web:s_entryid";
  const transcriptPath = join(chatDir, `${sessionKey}.jsonl`);

  await mkdir(chatDir, { recursive: true });
  const lines = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-06-24T00:00:00.000Z",
      entryId: "entry-visible-1",
      parentEntryId: null,
      messages: [{ role: "user", content: [{ type: "text", text: "first visible" }] }],
    },
    {
      type: "durable_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 2,
      createdAt: "2026-06-24T00:00:01.000Z",
      entryId: "entry-synthetic",
      parentEntryId: "entry-visible-1",
      message: {
        role: "user",
        metadata: { synthetic: true, purpose: "json_self_correct" },
        content: [{ type: "text", text: "hidden synthetic" }],
      },
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 3,
      createdAt: "2026-06-24T00:00:02.000Z",
      entryId: "entry-result",
      parentEntryId: "entry-synthetic",
      result: { stopReason: "completed", usage: {} },
    },
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-2",
      sequence: 4,
      createdAt: "2026-06-24T00:01:00.000Z",
      entryId: "entry-visible-2",
      parentEntryId: "entry-result",
      messages: [{ role: "user", content: [{ type: "text", text: "second visible" }] }],
    },
  ];
  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  const result = await readWebSessionMessages(
    { sessionKey, projectKey: projectRoot },
    { projectRoot, pilotHome, now: () => new Date("2026-06-24T01:00:00.000Z") },
  );

  assert.deepEqual(
    result.messages.map((message) => message.entryId),
    ["entry-visible-1", "entry-visible-2"],
  );

  await rm(pilotHome, { recursive: true, force: true });
});

test("readWebSessionMessages ignores pre-compact subagent refs when attaching visible tool rows", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-fork-subagent-compact-"));
  const projectRoot = join(pilotHome, "workspace");
  const chatDir = join(pilotHome, "projects", createProjectId(projectRoot), "chats");
  const sessionKey = "web:s_subagent_compact";
  const transcriptPath = join(chatDir, `${sessionKey}.jsonl`);

  await mkdir(chatDir, { recursive: true });
  const lines = [
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 1,
      createdAt: "2026-06-24T00:00:00.000Z",
      entryId: "entry-old-user",
      parentEntryId: null,
      messages: [{ role: "user", content: [{ type: "text", text: "old task" }] }],
    },
    {
      type: "assistant_message",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 2,
      createdAt: "2026-06-24T00:00:01.000Z",
      entryId: "entry-old-agent",
      parentEntryId: "entry-old-user",
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "agent-old", name: "agent", input: {} }],
      },
    },
    {
      type: "subagent_started",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 3,
      createdAt: "2026-06-24T00:00:02.000Z",
      entryId: "entry-old-subagent",
      parentEntryId: "entry-old-agent",
      subagentId: "sub-old",
      subagentType: "general-purpose",
      promptPreview: "old",
      promptTruncated: false,
      transcriptRelativePath: `${sessionKey}/subagents/sub-old.jsonl`,
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-1",
      sequence: 4,
      createdAt: "2026-06-24T00:00:03.000Z",
      entryId: "entry-old-result",
      parentEntryId: "entry-old-subagent",
      result: { stopReason: "completed", usage: {} },
    },
    {
      type: "control_boundary",
      sessionId: sessionKey,
      turnId: "compact",
      sequence: 5,
      createdAt: "2026-06-24T00:00:04.000Z",
      entryId: "entry-compact",
      parentEntryId: "entry-old-result",
      boundary: {
        kind: "compact",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "manual", preTokens: 100 },
      },
    },
    {
      type: "accepted_input",
      sessionId: sessionKey,
      turnId: "turn-2",
      sequence: 6,
      createdAt: "2026-06-24T00:01:00.000Z",
      entryId: "entry-new-user",
      parentEntryId: "entry-compact",
      messages: [{ role: "user", content: [{ type: "text", text: "new task" }] }],
    },
    {
      type: "assistant_message",
      sessionId: sessionKey,
      turnId: "turn-2",
      sequence: 7,
      createdAt: "2026-06-24T00:01:01.000Z",
      entryId: "entry-new-agent",
      parentEntryId: "entry-new-user",
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "agent-new", name: "agent", input: {} }],
      },
    },
    {
      type: "subagent_started",
      sessionId: sessionKey,
      turnId: "turn-2",
      sequence: 8,
      createdAt: "2026-06-24T00:01:02.000Z",
      entryId: "entry-new-subagent",
      parentEntryId: "entry-new-agent",
      subagentId: "sub-new",
      subagentType: "general-purpose",
      promptPreview: "new",
      promptTruncated: false,
      transcriptRelativePath: `${sessionKey}/subagents/sub-new.jsonl`,
    },
    {
      type: "turn_result",
      sessionId: sessionKey,
      turnId: "turn-2",
      sequence: 9,
      createdAt: "2026-06-24T00:01:03.000Z",
      entryId: "entry-new-result",
      parentEntryId: "entry-new-subagent",
      result: { stopReason: "completed", usage: {} },
    },
  ];
  await writeFile(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

  const result = await readWebSessionMessages(
    { sessionKey, projectKey: projectRoot },
    { projectRoot, pilotHome, now: () => new Date("2026-06-24T01:00:00.000Z") },
  );

  const toolUse = result.messages.find((message) => message.kind === "tool_use");
  assert.equal(toolUse?.toolCallId, "agent-new");
  assert.equal(toolUse?.subagentId, "sub-new");

  await rm(pilotHome, { recursive: true, force: true });
});
