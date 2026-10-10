import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TokenStatsCollector, type RouterStatsRecord } from "../../src/router/stats/TokenStatsCollector.js";
import { logger } from "../../src/telemetry/index.js";

function makeRecord(overrides: Partial<RouterStatsRecord> = {}): RouterStatsRecord {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    projectPath: "/tmp/proj",
    scenarioType: "default",
    resolvedFrom: "explicit",
    provider: "anthropic",
    model: "claude-sonnet-4",
    tier: "fast",
    role: "main",
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
    startedAt: "2026-08-17T10:00:00.000Z",
    endedAt: "2026-08-17T10:00:01.000Z",
    ...overrides,
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sati-stats-"));
}

/**
 * 异步批量落盘（P0-5）：observe() 热路径不再同步写盘；
 * flush() 确保全部 pending 记录按序落盘；dispose() 同步兜底。
 */
test("observe 入缓冲，flush 后全部记录按序落盘", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "stats.jsonl");
  const collector = new TokenStatsCollector({ enabled: true, filePath });
  try {
    const first = makeRecord({ startedAt: "2026-08-17T10:00:00.000Z" });
    const second = makeRecord({ startedAt: "2026-08-17T10:00:02.000Z" });
    collector.observe(first);
    collector.observe(second);

    // 尚未 flush：文件可能为空（不再同步写）。
    await collector.flush();

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    const parsed = lines.map(line => JSON.parse(line) as RouterStatsRecord);
    assert.equal(parsed[0]!.startedAt, first.startedAt);
    assert.equal(parsed[1]!.startedAt, second.startedAt);
  } finally {
    collector.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("批量阈值触发自动落盘（无需显式 flush）", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "stats.jsonl");
  const collector = new TokenStatsCollector({ enabled: true, filePath });
  try {
    // 每条约 300B，写入 300 条（≈90KB）超过 64KB 批量阈值。
    for (let i = 0; i < 300; i++) {
      collector.observe(
        makeRecord({
          sessionId: `sess-${i % 7}`,
          startedAt: `2026-08-17T10:00:${String(i % 60).padStart(2, "0")}.000Z`,
        }),
      );
    }
    await collector.flush();
    const raw = fs.readFileSync(filePath, "utf-8");
    assert.equal(raw.split("\n").filter(Boolean).length, 300);
  } finally {
    collector.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dispose 同步兜底写掉剩余缓冲（不丢记录）", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "stats.jsonl");
  const collector = new TokenStatsCollector({ enabled: true, filePath });
  collector.observe(makeRecord());
  // 不调用 flush，直接 dispose：剩余记录应以同步路径落盘。
  collector.dispose();
  const raw = fs.readFileSync(filePath, "utf-8");
  assert.equal(raw.split("\n").filter(Boolean).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("clear 丢弃 pending 并截断文件", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "stats.jsonl");
  const collector = new TokenStatsCollector({ enabled: true, filePath });
  try {
    collector.observe(makeRecord());
    collector.clear();
    await collector.flush();
    assert.equal(fs.readFileSync(filePath, "utf-8"), "");
  } finally {
    collector.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("disabled 时不落盘且不报错", async () => {
  const collector = new TokenStatsCollector({ enabled: false });
  collector.observe(makeRecord());
  await collector.flush();
  assert.equal(collector.snapshot().totalRequests, 0);
  collector.dispose();
});

test("异步落盘失败（真实 I/O 错误）：warn 留痕、flush 不抛出", async t => {
  const dir = tempDir();
  const filePath = path.join(dir, "stats.jsonl");
  // 用同名目录占据 stats.jsonl 位置：openSync/appendFile 均以 EISDIR 真实失败
  // （fd 打开失败 ⇒ writePayload 走 appendFile 路径 ⇒ 仍失败 ⇒ reject）。
  fs.mkdirSync(filePath, { recursive: true });
  const warnings: unknown[][] = [];
  t.mock.method(logger, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  const collector = new TokenStatsCollector({ enabled: true, filePath });
  try {
    collector.observe(makeRecord());
    await collector.flush(); // 不抛：失败被降级并由 warn 留痕
    assert.equal(warnings.length, 1, "异步落盘失败必须记恰好一条 warn（否则重回静默降级）");
    assert.match(String(warnings[0]?.[0]), /async flush failed/);
    assert.ok(warnings[0]?.[1] instanceof Error, "warn 必须带原始 error");
    // 再次入缓冲后 dispose：同步兜底（drainSync）同样以 EISDIR 失败 ⇒ 第二条 warn。
    collector.observe(makeRecord());
    collector.dispose();
    assert.equal(warnings.length, 2, "drainSync 失败（丢弃缓冲）同样必须留痕");
    assert.match(String(warnings[1]?.[0]), /drainSync failed/);
  } finally {
    collector.dispose(); // 幂等保险（断言提前失败时仍收尾定时器）
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("正常落盘不记 warn（日志是失败信号，不是每次都打）", async t => {
  const dir = tempDir();
  const filePath = path.join(dir, "stats.jsonl");
  const warnings: unknown[][] = [];
  t.mock.method(logger, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  const collector = new TokenStatsCollector({ enabled: true, filePath });
  try {
    collector.observe(makeRecord());
    await collector.flush();
    assert.equal(warnings.length, 0);
    assert.equal(fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean).length, 1);
  } finally {
    collector.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
