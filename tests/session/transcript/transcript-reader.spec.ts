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
