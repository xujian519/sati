import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AlwaysOnRunHistoryService } from "../../src/always-on/web/AlwaysOnRunHistoryService.js";

function makeTestEnv() {
  const base = mkdtempSync(join(tmpdir(), "pilotdeck-rh-"));
  const projectRoot = join(base, "project");
  const alwaysOnRoot = join(base, "ao");
  mkdirSync(alwaysOnRoot, { recursive: true });

  const service = new AlwaysOnRunHistoryService({
    paths: { getAlwaysOnRoot: () => alwaysOnRoot },
    logs: {
      getAlwaysOnRunLog: async () => ({ content: "", truncated: false, updatedAt: undefined, size: 0 }),
    },
  });

  return {
    base,
    projectRoot,
    alwaysOnRoot,
    service,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function writeHistory(alwaysOnRoot: string, events: Array<Record<string, unknown>>) {
  const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(alwaysOnRoot, "run-history.jsonl"), content);
}

// ---- appendRunEvent --------------------------------------------------------

test("appendRunEvent writes normalized event to disk", async () => {
  const env = makeTestEnv();
  try {
    const result = await env.service.appendRunEvent(env.projectRoot, {
      runId: "run-1",
      kind: "plan",
      sourceId: "src-1",
      status: "queued",
      timestamp: "2026-05-08T10:00:00Z",
    });
    assert.ok(result);
    assert.equal(result!.runId, "run-1");

    const content = readFileSync(join(env.alwaysOnRoot, "run-history.jsonl"), "utf8");
    assert.ok(content.includes("run-1"));
  } finally {
    env.cleanup();
  }
});

test("appendRunEvent rejects invalid events", async () => {
  const env = makeTestEnv();
  try {
    const result = await env.service.appendRunEvent(env.projectRoot, {
      runId: "",
      kind: "invalid",
      sourceId: "",
      status: "",
    });
    assert.equal(result, null);
  } finally {
    env.cleanup();
  }
});

// ---- getRunHistory ---------------------------------------------------------

test("getRunHistory returns empty for missing file", async () => {
  const env = makeTestEnv();
  try {
    const result = await env.service.getRunHistory(env.projectRoot);
    assert.deepEqual(result.runs, []);
  } finally {
    env.cleanup();
  }
});

test("getRunHistory merges multiple events per runId", async () => {
  const env = makeTestEnv();
  try {
    writeHistory(env.alwaysOnRoot, [
      { runId: "run-1", kind: "plan", sourceId: "s-1", status: "queued", timestamp: "2026-05-08T10:00:00Z", startedAt: "2026-05-08T10:00:00Z" },
      { runId: "run-1", kind: "plan", sourceId: "s-1", status: "running", timestamp: "2026-05-08T10:01:00Z" },
      { runId: "run-1", kind: "plan", sourceId: "s-1", status: "completed", timestamp: "2026-05-08T10:02:00Z" },
    ]);

    const result = await env.service.getRunHistory(env.projectRoot);
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0]!.status, "completed");
  } finally {
    env.cleanup();
  }
});

test("getRunHistory filters out unknown status", async () => {
  const env = makeTestEnv();
  try {
    writeHistory(env.alwaysOnRoot, [
      { runId: "run-1", kind: "cron", sourceId: "s-1", status: "unknown", timestamp: "2026-05-08T10:00:00Z" },
      { runId: "run-2", kind: "plan", sourceId: "s-2", status: "completed", timestamp: "2026-05-08T10:01:00Z", startedAt: "2026-05-08T10:01:00Z" },
    ]);

    const result = await env.service.getRunHistory(env.projectRoot);
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0]!.runId, "run-2");
  } finally {
    env.cleanup();
  }
});

test("getRunHistory respects limit", async () => {
  const env = makeTestEnv();
  try {
    const events = Array.from({ length: 10 }, (_, i) => ({
      runId: `run-${i}`,
      kind: "plan",
      sourceId: `s-${i}`,
      status: "completed",
      timestamp: new Date(Date.now() - i * 60000).toISOString(),
      startedAt: new Date(Date.now() - i * 60000).toISOString(),
    }));
    writeHistory(env.alwaysOnRoot, events);

    const result = await env.service.getRunHistory(env.projectRoot, { limit: 3 });
    assert.equal(result.runs.length, 3);
  } finally {
    env.cleanup();
  }
});

test("getRunHistory sorts by time descending", async () => {
  const env = makeTestEnv();
  try {
    writeHistory(env.alwaysOnRoot, [
      { runId: "old", kind: "plan", sourceId: "s-1", status: "completed", timestamp: "2026-05-07T10:00:00Z", startedAt: "2026-05-07T10:00:00Z" },
      { runId: "new", kind: "plan", sourceId: "s-2", status: "completed", timestamp: "2026-05-08T10:00:00Z", startedAt: "2026-05-08T10:00:00Z" },
    ]);

    const result = await env.service.getRunHistory(env.projectRoot);
    assert.equal(result.runs[0]!.runId, "new");
    assert.equal(result.runs[1]!.runId, "old");
  } finally {
    env.cleanup();
  }
});

// ---- getRunHistoryDetail ---------------------------------------------------

test("getRunHistoryDetail throws NOT_FOUND for missing runId", async () => {
  const env = makeTestEnv();
  try {
    writeHistory(env.alwaysOnRoot, [
      { runId: "run-1", kind: "plan", sourceId: "s-1", status: "completed", timestamp: "2026-05-08T10:00:00Z" },
    ]);

    await assert.rejects(
      () => env.service.getRunHistoryDetail(env.projectRoot, "nonexistent"),
      (error: Error & { code?: string }) => error.code === "NOT_FOUND",
    );
  } finally {
    env.cleanup();
  }
});

test("getRunHistoryDetail returns merged detail with metadata", async () => {
  const env = makeTestEnv();
  try {
    writeHistory(env.alwaysOnRoot, [
      { runId: "run-1", kind: "plan", sourceId: "s-1", status: "queued", timestamp: "2026-05-08T10:00:00Z", startedAt: "2026-05-08T10:00:00Z", output: "Starting..." },
      { runId: "run-1", kind: "plan", sourceId: "s-1", status: "completed", timestamp: "2026-05-08T10:05:00Z", finishedAt: "2026-05-08T10:05:00Z", output: "Done!" },
    ]);

    const detail = await env.service.getRunHistoryDetail(env.projectRoot, "run-1");
    assert.equal(detail.status, "completed");
    assert.ok(detail.outputLog.includes("Starting..."));
    assert.ok(detail.outputLog.includes("Done!"));
    assert.equal(detail.metadata.status, "completed");
  } finally {
    env.cleanup();
  }
});
