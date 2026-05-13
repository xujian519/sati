import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TokenStatsCollector, type RouterStatsRecord } from "../../src/router/stats/TokenStatsCollector.js";

function makeRecord(overrides?: Partial<RouterStatsRecord>): RouterStatsRecord {
  return {
    sessionId: "sess-1",
    scenarioType: "default",
    resolvedFrom: "scenario",
    provider: "openai",
    model: "gpt-4o",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    startedAt: "2026-05-12T08:00:00.000Z",
    endedAt: "2026-05-12T08:00:01.000Z",
    ...overrides,
  };
}

function tmpStatsPath(): string {
  return path.join(os.tmpdir(), `pilotdeck-test-stats-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test("TokenStatsCollector accumulates requests and tokens", () => {
  const filePath = tmpStatsPath();
  const collector = new TokenStatsCollector({ enabled: true, filePath });
  try {
    collector.observe(makeRecord());
    collector.observe(makeRecord({ usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 } }));
    collector.observe(makeRecord({ provider: "anthropic", model: "claude-sonnet" }));

    const snap = collector.snapshot();
    assert.equal(snap.totalRequests, 3);
    assert.equal(snap.totalInputTokens, 400);
    assert.equal(snap.totalOutputTokens, 200);
    assert.equal(snap.perProvider["openai"], 2);
    assert.equal(snap.perProvider["anthropic"], 1);
  } finally {
    collector.dispose();
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
  }
});

test("TokenStatsCollector groups records into hourly buckets", () => {
  const filePath = tmpStatsPath();
  const collector = new TokenStatsCollector({ enabled: true, filePath });
  try {
    collector.observe(makeRecord({ startedAt: "2026-05-12T08:30:00.000Z" }));
    collector.observe(makeRecord({ startedAt: "2026-05-12T09:15:00.000Z" }));
    collector.observe(makeRecord({ startedAt: "2026-05-12T09:45:00.000Z" }));

    const hourly = collector.hourlySnapshots();
    assert.equal(hourly.length, 2);
    assert.equal(hourly[0].hour, "2026-05-12T08");
    assert.equal(hourly[0].totalRequests, 1);
    assert.equal(hourly[1].hour, "2026-05-12T09");
    assert.equal(hourly[1].totalRequests, 2);
  } finally {
    collector.dispose();
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
  }
});

test("TokenStatsCollector tracks per-session aggregates independently", () => {
  const filePath = tmpStatsPath();
  const collector = new TokenStatsCollector({ enabled: true, filePath });
  try {
    collector.observe(makeRecord({ sessionId: "A" }));
    collector.observe(makeRecord({ sessionId: "A" }));
    collector.observe(makeRecord({ sessionId: "B" }));

    const snapA = collector.sessionSnapshot("A");
    const snapB = collector.sessionSnapshot("B");
    assert.ok(snapA);
    assert.ok(snapB);
    assert.equal(snapA.aggregate.totalRequests, 2);
    assert.equal(snapB.aggregate.totalRequests, 1);
  } finally {
    collector.dispose();
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
  }
});

test("TokenStatsCollector persists to disk and reloads", async () => {
  const filePath = tmpStatsPath();
  const collector1 = new TokenStatsCollector({ enabled: true, filePath });
  try {
    collector1.observe(makeRecord());
    collector1.observe(makeRecord());
    await collector1.flush();
    collector1.dispose();

    const collector2 = new TokenStatsCollector({ enabled: true, filePath });
    try {
      const snap = collector2.snapshot();
      assert.equal(snap.totalRequests, 2);
      assert.equal(snap.totalInputTokens, 200);
    } finally {
      collector2.dispose();
    }
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
  }
});

test("TokenStatsCollector prunes hourly buckets beyond 72", () => {
  const filePath = tmpStatsPath();
  const collector = new TokenStatsCollector({ enabled: true, filePath });
  try {
    for (let i = 0; i < 80; i++) {
      const hour = String(i).padStart(2, "0");
      const day = String(Math.floor(i / 24) + 1).padStart(2, "0");
      const h = String(i % 24).padStart(2, "0");
      collector.observe(makeRecord({
        startedAt: `2026-05-${day}T${h}:00:00.000Z`,
      }));
    }
    const hourly = collector.hourlySnapshots();
    assert.ok(hourly.length <= 72, `Expected <= 72 hourly buckets, got ${hourly.length}`);
  } finally {
    collector.dispose();
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
  }
});

test("TokenStatsCollector uses nativeCost when available over pricing lookup", () => {
  const filePath = tmpStatsPath();
  const collector = new TokenStatsCollector({ enabled: true, filePath });
  try {
    collector.observe(makeRecord({
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, nativeCost: 0.42 },
    }));
    const recent = collector.recent(1);
    assert.equal(recent.length, 1);
    assert.ok(recent[0].cost);
    assert.equal(recent[0].cost!.total, 0.42);
    assert.equal(recent[0].cost!.input, 0);
  } finally {
    collector.dispose();
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
  }
});
