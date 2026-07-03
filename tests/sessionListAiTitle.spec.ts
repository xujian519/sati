import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionInfoFromLite } from "../src/session/storage/SessionList.js";
import type { SessionLiteFile } from "../src/session/storage/SessionLiteReader.js";

test("parseSessionInfoFromLite uses aiTitle as summary", () => {
  const info = parseSessionInfoFromLite("s1", lite([
    entry("accepted_input", { messages: [{ content: [{ type: "text", text: "Original prompt" }] }] }),
    entry("session_metadata", { metadata: { aiTitle: "Fix login flow" } }),
  ]));

  assert.equal(info?.summary, "Fix login flow");
  assert.equal(info?.aiTitle, "Fix login flow");
});

test("parseSessionInfoFromLite prefers manual title over aiTitle", () => {
  const info = parseSessionInfoFromLite("s1", lite([
    entry("accepted_input", { messages: [{ content: [{ type: "text", text: "Original prompt" }] }] }),
    entry("session_metadata", { metadata: { aiTitle: "Fix login flow" } }),
    entry("session_metadata", { metadata: { title: "Manual title" } }),
  ]));

  assert.equal(info?.summary, "Manual title");
  assert.equal(info?.customTitle, "Manual title");
  assert.equal(info?.aiTitle, "Fix login flow");
});

function lite(lines: string[]): SessionLiteFile {
  const content = lines.join("\n");
  return {
    path: "/tmp/s1.jsonl",
    mtime: 1,
    size: Buffer.byteLength(content),
    head: content,
    tail: content,
  };
}

function entry(type: string, extra: Record<string, unknown>): string {
  return JSON.stringify({
    type,
    sessionId: "s1",
    turnId: "t1",
    sequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
}
