import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  JsonlTranscriptWriter,
  SessionMetadataStore,
  createAgentProjectSessionStorage,
  listProjectSessions,
} from "../../src/session/index.js";

test("listProjectSessions reads lite metadata and paginates by modification time", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "politdeck-session-list-"));
  try {
    const projectRoot = path.join(root, "repo");
    const politHome = path.join(root, "home");

    await writeSession({ projectRoot, politHome, sessionId: "older", prompt: "First prompt", title: "Older title" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeSession({ projectRoot, politHome, sessionId: "newer", prompt: "Second prompt", aiTitle: "Newer AI title", tag: "tag" });

    const all = await listProjectSessions({ projectRoot, politHome });
    const paged = await listProjectSessions({ projectRoot, politHome, limit: 1, offset: 1 });

    assert.deepEqual(all.map((session) => session.sessionId), ["newer", "older"]);
    assert.equal(all[0]?.summary, "Newer AI title");
    assert.equal(all[0]?.tag, "tag");
    assert.equal(all[1]?.customTitle, "Older title");
    assert.deepEqual(paged.map((session) => session.sessionId), ["older"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeSession(options: {
  projectRoot: string;
  politHome: string;
  sessionId: string;
  prompt: string;
  title?: string;
  aiTitle?: string;
  tag?: string;
}): Promise<void> {
  const storage = createAgentProjectSessionStorage(options);
  const writer = new JsonlTranscriptWriter({ path: storage.transcriptPath });
  await writer.recordAcceptedInput(options.sessionId, "turn-1", [
    { role: "user", content: [{ type: "text", text: options.prompt }] },
  ]);
  const metadata = new SessionMetadataStore({ transcript: writer, sessionId: options.sessionId });
  if (options.aiTitle) await metadata.saveAiTitle(options.aiTitle);
  if (options.title) await metadata.saveTitle(options.title);
  if (options.tag) await metadata.saveTag(options.tag);
}
