import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { readTranscript } from "../../../src/session/transcript/TranscriptReader.js";

const tempDirs: string[] = [];

function makeTranscriptPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-transcript-reader-"));
  tempDirs.push(dir);
  return join(dir, "session.jsonl");
}

function entryLine(sessionId: string, sequence: number, text: string): string {
  return `${JSON.stringify({
    type: "accepted_input",
    sessionId,
    turnId: `t${sequence}`,
    sequence,
    createdAt: `2026-08-09T00:00:0${sequence % 10}.000Z`,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  })}\n`;
}

function writeTranscript(path: string, lines: string[]): void {
  writeFileSync(path, lines.join(""), "utf-8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("TranscriptReader mtime+size 感知缓存", () => {
  it("解析合法 entry 并按 sequence 排序", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 2, "第二条"), entryLine("s1", 1, "第一条")]);

    const result = await readTranscript(path);
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0]?.sequence, 1);
    assert.equal(result.entries[1]?.sequence, 2);
  });

  it("TTL 内文件未变化时重复读取命中缓存（返回相同 entries）", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "内容")]);

    const first = await readTranscript(path);
    const second = await readTranscript(path);
    assert.equal(first.entries.length, 1);
    assert.equal(second.entries.length, 1);
    assert.deepEqual(
      second.entries.map(entry => entry.sequence),
      first.entries.map(entry => entry.sequence),
    );
  });

  it("文件变化（size/mtime）后重新解析，返回新数据", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "旧内容")]);
    await readTranscript(path);

    // 追加新 entry：文件 size 变化 → 缓存失效 → 重新解析
    writeTranscript(path, [entryLine("s1", 1, "旧内容"), entryLine("s1", 2, "新内容")]);

    const result = await readTranscript(path);
    assert.equal(result.entries.length, 2, "文件变化后应重新解析");
  });

  it("返回数组为拷贝：修改返回结果不影响缓存", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "内容")]);

    const first = await readTranscript(path);
    first.entries.pop(); // 篡改返回数组

    const second = await readTranscript(path);
    assert.equal(second.entries.length, 1, "缓存数据不应被调用方修改污染");
  });

  it("超过 maxBytes 返回 transcript_too_large 诊断", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "内容")]);

    const result = await readTranscript(path, { maxBytes: 1 });
    assert.equal(result.entries.length, 0);
    assert.equal(result.diagnostics[0]?.code, "transcript_too_large");
  });

  it("文件不存在返回 transcript_missing 诊断", async () => {
    const path = join(makeTranscriptPath(), "..", "missing.jsonl");
    const result = await readTranscript(path);
    assert.equal(result.entries.length, 0);
    assert.equal(result.diagnostics[0]?.code, "transcript_missing");
  });
});

describe("TranscriptReader tail-append 增量读取", () => {
  it("追加后只读新字节：结果与一次性全量读取一致", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "一")]);
    const first = await readTranscript(path);
    assert.equal(first.entries.length, 1);

    // 增量路径：追加两条后读取
    writeTranscript(path, [entryLine("s1", 1, "一"), entryLine("s1", 2, "二"), entryLine("s1", 3, "三")]);
    const incr = await readTranscript(path);

    // 对照：全新文件一次性写入全部内容
    const fresh = makeTranscriptPath();
    writeTranscript(fresh, [entryLine("s1", 1, "一"), entryLine("s1", 2, "二"), entryLine("s1", 3, "三")]);
    const full = await readTranscript(fresh);
    assert.deepEqual(incr.entries, full.entries, "增量结果应与全量解析逐字节一致");
    assert.deepEqual(
      incr.entries.map(e => e.sequence),
      [1, 2, 3],
    );
  });

  it("多次追加连续增量：状态持续累积且无重复", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "一")]);
    await readTranscript(path);
    writeTranscript(path, [entryLine("s1", 1, "一"), entryLine("s1", 2, "二")]);
    await readTranscript(path);
    writeTranscript(path, [entryLine("s1", 1, "一"), entryLine("s1", 2, "二"), entryLine("s1", 3, "三")]);
    const result = await readTranscript(path);
    assert.deepEqual(
      result.entries.map(e => e.sequence),
      [1, 2, 3],
      "连续增量不重不漏",
    );
  });

  it("快路径命中返回共享元素浅拷贝", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "内容")]);
    const first = await readTranscript(path);
    const second = await readTranscript(path);
    assert.notEqual(second.entries, first.entries, "数组应为新拷贝");
    assert.equal(second.entries[0], first.entries[0], "元素应共享引用");
    assert.equal(second.diagnostics, first.diagnostics, "诊断数组共享引用（与旧行为一致）");
  });

  it("半行拼接：写一半 → 诊断占位 → 补全 → entry 到达", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "一")]);
    await readTranscript(path);

    // 写第 2 条的前半（无换行结尾，切断 JSON 中间）
    const line2 = entryLine("s1", 2, "二");
    const partial = line2.slice(0, 40);
    writeFileSync(path, partial, { flag: "a" });
    const mid = await readTranscript(path);
    assert.equal(mid.entries.length, 1, "半行未达，不解析");
    assert.equal(mid.diagnostics.length, 1, "半行产生 line_invalid 诊断");
    assert.equal(mid.diagnostics[0]?.line, 2, "半行应为文件第 2 行");

    // 补全剩余字节
    writeFileSync(path, line2.slice(40), { flag: "a" });
    const done = await readTranscript(path);
    assert.deepEqual(
      done.entries.map(e => e.sequence),
      [1, 2],
      "拼接后 entry 到达且无重复",
    );
    assert.equal(done.entries[1]?.turnId, "t2");
  });

  it("增量诊断行号接续文件行号", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "一"), entryLine("s1", 2, "二")]);
    await readTranscript(path);
    // 追加一条坏 JSON 行（第 3 行）
    writeFileSync(path, "NOT_JSON\n", { flag: "a" });
    const result = await readTranscript(path);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.line, 3, "增量段诊断行号应为文件绝对行号");
  });

  it("sequence 回退守卫：文件被替换重写 → 全量重读", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "旧一"), entryLine("s1", 2, "旧二")]);
    await readTranscript(path);
    // 替换文件（sequence 从头开始，size 增大 → 若走增量会拼出乱数据）
    writeTranscript(path, [entryLine("s1", 1, "新一"), entryLine("s1", 2, "新二"), entryLine("s1", 3, "新三")]);
    const result = await readTranscript(path);
    assert.deepEqual(
      result.entries.map(e => e.sequence),
      [1, 2, 3],
      "守卫触发全量重读",
    );
    assert.equal(result.entries[0]?.turnId, "t1", "替换后内容来自新文件");
  });

  it("size 回缩守卫：文件被截断 → 全量重读", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "一"), entryLine("s1", 2, "二"), entryLine("s1", 3, "三")]);
    await readTranscript(path);
    writeTranscript(path, [entryLine("s1", 1, "一")]);
    const result = await readTranscript(path);
    assert.equal(result.entries.length, 1, "截断后应全量重读");
  });

  it("并发读取串行化：同 path 并发不重复读段", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "一")]);
    const [a, b] = await Promise.all([readTranscript(path), readTranscript(path)]);
    assert.deepEqual(a.entries, b.entries);
    assert.deepEqual(
      a.entries.map(e => e.sequence),
      [1],
      "并发读取结果一致且不重复",
    );
  });

  it("SATI_TRANSCRIPT_TAIL=0 回滚到 TtlCache 全量路径", async () => {
    process.env.SATI_TRANSCRIPT_TAIL = "0";
    try {
      const path = makeTranscriptPath();
      writeTranscript(path, [entryLine("s1", 1, "一")]);
      const first = await readTranscript(path);
      writeTranscript(path, [entryLine("s1", 1, "一"), entryLine("s1", 2, "二")]);
      const result = await readTranscript(path);
      assert.equal(result.entries.length, 2, "回滚路径追加后全量重解析");
      assert.equal(first.entries.length, 1);
    } finally {
      delete process.env.SATI_TRANSCRIPT_TAIL;
    }
  });
});
