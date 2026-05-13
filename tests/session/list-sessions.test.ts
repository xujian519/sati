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
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-session-list-"));
  try {
    const projectRoot = path.join(root, "repo");
    const pilotHome = path.join(root, "home");

    await writeSession({ projectRoot, pilotHome, sessionId: "older", prompt: "First prompt", title: "Older title" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeSession({ projectRoot, pilotHome, sessionId: "newer", prompt: "Second prompt", aiTitle: "Newer AI title", tag: "tag" });

    const all = await listProjectSessions({ projectRoot, pilotHome });
    const paged = await listProjectSessions({ projectRoot, pilotHome, limit: 1, offset: 1 });

    assert.deepEqual(all.map((session) => session.sessionId), ["newer", "older"]);
    assert.equal(all[0]?.summary, "Newer AI title");
    assert.equal(all[0]?.tag, "tag");
    assert.equal(all[1]?.customTitle, "Older title");
    assert.deepEqual(paged.map((session) => session.sessionId), ["older"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listProjectSessions finds sessions created with TUI-style sessionId containing slashes", async () => {
  // Regression for the transcript-path bug: TUI sessionKeys embed an absolute
  // project path (e.g. `tui:project=/Users/foo/work/repo:default`). Without
  // sanitization, path.resolve() treats the raw `/` chars as directory
  // separators and buries the transcript under nested subdirs, where the
  // flat sidebar scan in listProjectSessions can never reach it.
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-tui-sanitize-"));
  try {
    const projectRoot = path.join(root, "repo");
    const pilotHome = path.join(root, "home");
    const tuiSessionId = "tui:project=/Users/foo/work/repo:default";

    await writeSession({ projectRoot, pilotHome, sessionId: tuiSessionId, prompt: "TUI chat" });

    const all = await listProjectSessions({ projectRoot, pilotHome });
    assert.equal(all.length, 1);
    assert.equal(all[0]?.firstPrompt, "TUI chat");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeSession(options: {
  projectRoot: string;
  pilotHome: string;
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
