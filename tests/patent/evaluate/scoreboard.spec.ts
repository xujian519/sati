import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { appendScoreboard, readScoreboard, validateScoreboardRecord } from "../../../src/patent/evaluate/scoreboard.js";
import type { ScoreboardRecord } from "../../../src/patent/evaluate/scoreboard.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-scoreboard-"));
  tempDirs.push(dir);
  return dir;
}

function record(overrides: Partial<ScoreboardRecord> = {}): ScoreboardRecord {
  return {
    time: "2026-08-09T00:00:00.000Z",
    version: 1,
    provider: "deepseek",
    model_id: "deepseek-v4-pro",
    thinking_level: "medium",
    score: 80,
    cost: 0.12,
    duration_ms: 5000,
    cases: [
      {
        case: "patent_exam_2011_a22_02",
        score: 80,
        runs: [{ score: 80, cost: 0.12, duration_ms: 5000, session_id: "sess-1" }],
      },
    ],
    ...overrides,
  };
}

describe("readScoreboard", () => {
  it("文件缺失 → 空列表", async () => {
    const dir = makeDir();
    const result = await readScoreboard(join(dir, "no-such.yaml"));
    assert.equal(result.error, null);
    assert.deepEqual(result.records, []);
  });

  it("空文件 → 空列表", async () => {
    const dir = makeDir();
    const path = join(dir, "scoreboard.yaml");
    writeFileSync(path, "");
    const result = await readScoreboard(path);
    assert.equal(result.error, null);
    assert.deepEqual(result.records, []);
  });
});

describe("appendScoreboard", () => {
  it("追加后写回且写后自校验通过", async () => {
    const dir = makeDir();
    const path = join(dir, "scoreboard.yaml");
    const res = await appendScoreboard(path, record());
    assert.equal(res.ok, true);
    assert.equal(res.count, 1);
    const read = await readScoreboard(path);
    assert.equal(read.error, null);
    assert.equal(read.records.length, 1);
    assert.equal(read.records[0]!.version, 1);
  });

  it("追加不覆盖历史：二次追加 count 递增", async () => {
    const dir = makeDir();
    const path = join(dir, "scoreboard.yaml");
    await appendScoreboard(path, record());
    const res = await appendScoreboard(path, record({ version: 2 }));
    assert.equal(res.ok, true);
    assert.equal(res.count, 2);
    const read = await readScoreboard(path);
    assert.equal(read.records.length, 2);
  });

  it("非法 record 拒绝追加", async () => {
    const dir = makeDir();
    const path = join(dir, "scoreboard.yaml");
    const bad = record({ score: Number.NaN });
    const res = await appendScoreboard(path, bad);
    assert.equal(res.ok, false);
    assert.match(res.error!, /score/);
  });

  it("现有库含坏记录 → fail-closed 拒绝追加", async () => {
    const dir = makeDir();
    const path = join(dir, "scoreboard.yaml");
    writeFileSync(path, "- { time: 2026-08-09 }\n");
    const res = await appendScoreboard(path, record());
    assert.equal(res.ok, false);
    assert.match(res.error!, /invalid/);
  });
});

describe("validateScoreboardRecord", () => {
  it("合法记录返回空错误列表", () => {
    assert.deepEqual(validateScoreboardRecord(record()), []);
  });
  it("缺 cases 报错", () => {
    const errors = validateScoreboardRecord(record({ cases: [] }));
    assert.equal(errors.length, 0);
  });
  it("run 缺 session_id 报错", () => {
    const r = record();
    const run = r.cases[0]!.runs[0] as Record<string, unknown>;
    delete run.session_id;
    const errors = validateScoreboardRecord(r);
    assert.ok(errors.some(e => /session_id/.test(e)));
  });
});
