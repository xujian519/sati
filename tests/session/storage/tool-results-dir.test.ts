import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createAgentProjectSessionStorage } from "../../../src/session/storage/ProjectSessionStorage.js";

test("createAgentProjectSessionStorage exposes toolResultsDir under chat dir", () => {
  const storage = createAgentProjectSessionStorage({
    projectRoot: "/tmp/proj",
    pilotHome: "/tmp/pilotHome",
    sessionId: "session-1",
  });
  assert.equal(storage.toolResultsDir, resolve(storage.chatDir, "session-1", "tool-results"));
  assert.equal(storage.transcriptPath, resolve(storage.chatDir, "session-1.jsonl"));
});
