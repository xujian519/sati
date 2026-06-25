import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ForkSessionError, forkWebSession } from "../../src/web/server/forkSession.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";
import { createProjectId } from "../../src/pilot/paths.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";

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
  if (entries[3].type === "session_metadata") {
    assert.equal(entries[3].metadata.parentSessionId, sessionKey);
    assert.equal(entries[3].metadata.forkedFromTurnId, "turn-2");
  }

  await rm(pilotHome, { recursive: true, force: true });
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
