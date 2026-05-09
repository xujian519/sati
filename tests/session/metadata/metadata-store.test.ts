import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionMetadataStore } from "../../../src/session/metadata/SessionMetadataStore.js";
import { JsonlTranscriptWriter } from "../../../src/session/transcript/JsonlTranscriptWriter.js";

const sessionId = "session-meta-test";

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), "politdeck-meta-"));
  const path = join(dir, `${sessionId}.jsonl`);
  const writer = new JsonlTranscriptWriter({ path });
  const store = new SessionMetadataStore({ transcript: writer, sessionId });
  return { dir, path, writer, store };
}

test("SessionMetadataStore.restoreFromReplay seeds in-memory metadata without writing", () => {
  const { store } = createFixture();
  store.restoreFromReplay({ title: "restored title", tag: "test" });
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.title, "restored title");
  assert.equal(snapshot.tag, "test");
});

test("SessionMetadataStore.reappendTail writes a session_metadata entry to the transcript tail", async () => {
  const { dir, path, store } = createFixture();
  try {
    await store.saveTitle("my title");
    await store.saveTag("v1");
    await store.reappendTail();
    const content = readFileSync(path, "utf8");
    const lines = content.trim().split("\n");
    // 3 entries: saveTitle, saveTag, reappendTail
    assert.equal(lines.length, 3);
    const lastEntry = JSON.parse(lines[2]!) as { type: string; metadata: { title: string; tag: string } };
    assert.equal(lastEntry.type, "session_metadata");
    assert.equal(lastEntry.metadata.title, "my title");
    assert.equal(lastEntry.metadata.tag, "v1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionMetadataStore.reappendTail is a no-op when metadata is empty", async () => {
  const { dir, path, store } = createFixture();
  try {
    await store.reappendTail();
    let fileExists = false;
    try {
      readFileSync(path, "utf8");
      fileExists = true;
    } catch {
      // expected: file should not exist
    }
    assert.equal(fileExists, false, "Expected no file to be written when metadata is empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoreFromReplay then saveTitle merges correctly", async () => {
  const { store } = createFixture();
  store.restoreFromReplay({ aiTitle: "ai-gen", tag: "old" });
  await store.saveTitle("user override");
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.title, "user override");
  assert.equal(snapshot.aiTitle, "ai-gen");
  assert.equal(snapshot.tag, "old");
});
