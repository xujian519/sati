import test from "node:test";
import assert from "node:assert/strict";
import { mapLegacySessionPresentation } from "../../src/web/server/legacySessionPresentation.js";

test("mapLegacySessionPresentation prefixes cron sessions and assigns a cron tag", () => {
  const result = mapLegacySessionPresentation({
    sessionId: "cron:task-123",
    summary: "Nightly summary",
  });

  assert.equal(result.title, "[Cron] Nightly summary");
  assert.equal(result.summary, "[Cron] Nightly summary");
  assert.equal(result.name, "[Cron] Nightly summary");
  assert.equal(result.tag, "cron");
});

test("mapLegacySessionPresentation preserves non-cron sessions", () => {
  const result = mapLegacySessionPresentation({
    sessionId: "web:s_123",
    summary: "Normal chat",
    tag: "custom",
  });

  assert.equal(result.title, "Normal chat");
  assert.equal(result.summary, "Normal chat");
  assert.equal(result.name, "Normal chat");
  assert.equal(result.tag, "custom");
});
