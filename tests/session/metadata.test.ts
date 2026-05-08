import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryTranscriptWriter, SessionMetadataStore } from "../../src/session/index.js";

test("SessionMetadataStore persists metadata and lets user title win over AI title", async () => {
  const transcript = new InMemoryTranscriptWriter();
  const store = new SessionMetadataStore({
    transcript,
    sessionId: "session-1",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  await store.saveAiTitle("AI title");
  await store.saveTitle("User title");
  await store.saveAiTitle("New AI title");
  await store.saveTag("important");

  assert.deepEqual(store.getSnapshot(), {
    aiTitle: "New AI title",
    title: "User title",
    tag: "important",
    updatedAt: "2026-01-01T00:00:00.000Z",
    linkedPullRequest: undefined,
  });
  assert.deepEqual(
    transcript.entries.map((entry) => entry.type),
    ["session_metadata", "session_metadata", "session_metadata", "session_metadata"],
  );
});
