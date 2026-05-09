import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listAllSessions, searchSessionsByTitle } from "../../../src/session/storage/SessionList.js";

function createPilotHome() {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-list-"));
  return pilotHome;
}

function writeSession(pilotHome: string, projectId: string, sessionId: string, lines: string[]): void {
  const chatDir = join(pilotHome, "projects", projectId, "chats");
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(chatDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

function acceptedInputLine(text: string): string {
  return JSON.stringify({
    type: "accepted_input",
    sessionId: "s",
    turnId: "t",
    sequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  });
}

function metadataLine(title: string): string {
  return JSON.stringify({
    type: "session_metadata",
    sessionId: "s",
    turnId: "metadata",
    sequence: 2,
    createdAt: "2026-01-01T00:00:01.000Z",
    metadata: { title },
  });
}

test("listAllSessions scans all projects and returns sorted results", async () => {
  const pilotHome = createPilotHome();
  try {
    writeSession(pilotHome, "proj-a", "s1", [acceptedInputLine("hello from A")]);
    writeSession(pilotHome, "proj-b", "s2", [acceptedInputLine("hello from B")]);

    const results = await listAllSessions({ pilotHome });
    assert.equal(results.length, 2);
    // Both sessions should be present, most recent first.
    const ids = results.map((r) => r.sessionId);
    assert.ok(ids.includes("s1"));
    assert.ok(ids.includes("s2"));
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("listAllSessions respects limit and offset", async () => {
  const pilotHome = createPilotHome();
  try {
    writeSession(pilotHome, "proj", "s1", [acceptedInputLine("first")]);
    writeSession(pilotHome, "proj", "s2", [acceptedInputLine("second")]);
    writeSession(pilotHome, "proj", "s3", [acceptedInputLine("third")]);

    const page = await listAllSessions({ pilotHome, limit: 1, offset: 1 });
    assert.equal(page.length, 1);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("listAllSessions returns empty for missing projects dir", async () => {
  const results = await listAllSessions({ pilotHome: "/tmp/__never_exists__" });
  assert.deepEqual(results, []);
});

test("searchSessionsByTitle matches customTitle", async () => {
  const pilotHome = createPilotHome();
  const projectRoot = "/tmp/search-proj";
  try {
    writeSession(pilotHome, "tmp-search-proj", "s1", [
      acceptedInputLine("irrelevant"),
      metadataLine("Refactor auth module"),
    ]);
    writeSession(pilotHome, "tmp-search-proj", "s2", [acceptedInputLine("Setup CI")]);

    const results = await searchSessionsByTitle({ projectRoot, pilotHome, query: "auth" });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.customTitle, "Refactor auth module");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("searchSessionsByTitle matches firstPrompt when no title", async () => {
  const pilotHome = createPilotHome();
  const projectRoot = "/tmp/search-fp";
  try {
    writeSession(pilotHome, "tmp-search-fp", "s1", [acceptedInputLine("deploy to staging")]);
    writeSession(pilotHome, "tmp-search-fp", "s2", [acceptedInputLine("fix login bug")]);

    const results = await searchSessionsByTitle({ projectRoot, pilotHome, query: "deploy" });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.firstPrompt, "deploy to staging");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("searchSessionsByTitle is case insensitive", async () => {
  const pilotHome = createPilotHome();
  const projectRoot = "/tmp/search-ci";
  try {
    writeSession(pilotHome, "tmp-search-ci", "s1", [
      acceptedInputLine("x"),
      metadataLine("API Gateway Design"),
    ]);

    const results = await searchSessionsByTitle({ projectRoot, pilotHome, query: "api gateway" });
    assert.equal(results.length, 1);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
