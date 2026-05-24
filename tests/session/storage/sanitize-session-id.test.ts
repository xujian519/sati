import test from "node:test";
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import {
  sanitizeSessionIdForPath,
  createAgentProjectSessionStorage,
} from "../../../src/session/storage/ProjectSessionStorage.js";

test("sanitizeSessionIdForPath replaces forward slashes in TUI sessionKey", () => {
  const result = sanitizeSessionIdForPath("tui:project=/Users/foo/work/repo:default");
  const expected = process.platform === "win32"
    ? "tui-project=-Users-foo-work-repo-default"
    : "tui:project=-Users-foo-work-repo:default";
  assert.equal(result, expected);
  assert.ok(!result.includes("/"), "result must not contain forward slashes");
});

test("sanitizeSessionIdForPath is idempotent for web session keys without slashes", () => {
  const input = "web:s_abc-123";
  const expected = process.platform === "win32" ? "web-s_abc-123" : input;
  assert.equal(sanitizeSessionIdForPath(input), expected);
});

test("sanitizeSessionIdForPath replaces Windows-style backslashes", () => {
  // In a JS string literal, "C:\\Users\\foo" is the 12-char string `C:\Users\foo`.
  const result = sanitizeSessionIdForPath("tui:project=C:\\Users\\foo:default");
  const expected = process.platform === "win32"
    ? "tui-project=C-Users-foo-default"
    : "tui:project=C:-Users-foo:default";
  assert.equal(result, expected);
  assert.ok(!result.includes("\\"), "result must not contain backslashes");
});

test("sanitizeSessionIdForPath collapses runs of slashes into a single dash", () => {
  const result = sanitizeSessionIdForPath("a///b\\\\c");
  assert.equal(result, "a-b-c");
});

test("sanitizeSessionIdForPath falls back to 'session' for slash-only input", () => {
  assert.equal(sanitizeSessionIdForPath("///"), "session");
  assert.equal(sanitizeSessionIdForPath("\\\\\\"), "session");
});

test("sanitizeSessionIdForPath falls back to 'session' for empty input", () => {
  assert.equal(sanitizeSessionIdForPath(""), "session");
});

test("sanitizeSessionIdForPath leaves already-safe ids unchanged", () => {
  assert.equal(sanitizeSessionIdForPath("my-session.v2"), "my-session.v2");
  assert.equal(sanitizeSessionIdForPath("session-1"), "session-1");
});

test("sanitizeSessionIdForPath strips leading and trailing dashes after replacement", () => {
  assert.equal(sanitizeSessionIdForPath("/foo/"), "foo");
  assert.equal(sanitizeSessionIdForPath("\\bar\\"), "bar");
});

test("createAgentProjectSessionStorage produces a flat transcriptPath for TUI-style sessionId", () => {
  const tuiSessionId = "tui:project=/Users/foo/work/repo:default";
  const storage = createAgentProjectSessionStorage({
    projectRoot: "/tmp/proj",
    pilotHome: "/tmp/pilotHome",
    sessionId: tuiSessionId,
  });

  const safeId = sanitizeSessionIdForPath(tuiSessionId);
  const expectedFilename = `${safeId}.jsonl`;
  assert.equal(storage.transcriptPath, resolve(storage.chatDir, expectedFilename));

  const relative = storage.transcriptPath.slice(storage.chatDir.length + 1);
  assert.equal(relative, expectedFilename);
  assert.ok(!relative.includes(sep), "transcriptPath must be flat under chatDir");
});

test("createAgentProjectSessionStorage uses sanitized id for per-session subdirectories", () => {
  const tuiSessionId = "tui:project=/Users/foo/work/repo:default";
  const storage = createAgentProjectSessionStorage({
    projectRoot: "/tmp/proj",
    pilotHome: "/tmp/pilotHome",
    sessionId: tuiSessionId,
  });

  const safeId = sanitizeSessionIdForPath(tuiSessionId);
  assert.equal(storage.toolResultsDir, resolve(storage.chatDir, safeId, "tool-results"));
  assert.equal(storage.fileHistoryDir, resolve(storage.chatDir, safeId, "file-history"));
  assert.equal(storage.subagentsDir, resolve(storage.chatDir, safeId, "subagents"));
});

test("createAgentProjectSessionStorage subagentTranscriptPath sanitizes subagentId", () => {
  const storage = createAgentProjectSessionStorage({
    projectRoot: "/tmp/proj",
    pilotHome: "/tmp/pilotHome",
    sessionId: "session-1",
  });

  const subagentId = "sub/agent\\one";
  const path = storage.subagentTranscriptPath(subagentId);
  assert.equal(path, resolve(storage.subagentsDir, "sub-agent-one.jsonl"));
});
