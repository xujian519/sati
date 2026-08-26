import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { CanonicalMessage } from "../../../src/model/index.js";
import { JsonlTranscriptWriter } from "../../../src/session/transcript/JsonlTranscriptWriter.js";
import type { AgentTranscriptEntry } from "../../../src/session/transcript/TranscriptEntry.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const FIXED_NOW = () => new Date("2026-08-09T00:00:00.000Z");

function makeTranscriptDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-jsonl-writer-torn-"));
  tempDirs.push(dir);
  return dir;
}

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

/** 逐行 JSON.parse；无法 parse 的行被返回在 badLines（reader 端会按 line_invalid 跳过）。 */
function splitEntries(raw: string): { entries: AgentTranscriptEntry[]; badLines: string[] } {
  const entries: AgentTranscriptEntry[] = [];
  const badLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      entries.push(JSON.parse(line) as AgentTranscriptEntry);
    } catch {
      badLines.push(line);
    }
  }
  return { entries, badLines };
}

function firstAcceptedText(entry: AgentTranscriptEntry): string {
  const messages = (entry as unknown as { messages: Array<{ content: Array<{ type: string; text?: string }> }> })
    .messages;
  const text = messages[0]?.content[0]?.text;
  assert.equal(typeof text, "string");
  return text as string;
}

describe("JsonlTranscriptWriter torn-tail 自愈", () => {
  it("续写前探测到崩溃残留半行：下一条记录从新行开始，半行被留作坏行", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    // 模拟上次进程崩溃留下的未以 `\n` 结尾的半行。
    const tornHalf = '{"type":"accepted_input","sessionId":"s1","turnId":"t0",';
    writeFileSync(path, tornHalf);

    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });
    await writer.recordAcceptedInput("s1", "t1", [userMessage("after-crash")]);

    const raw = readFileSync(path, "utf8");
    // 新记录必补换行从新行开始，不与半行粘连。
    assert.ok(raw.startsWith(`${tornHalf}\n`), "resumed record must start on a fresh line");
    assert.ok(raw.endsWith("\n"), "full record must end with newline");

    const { entries, badLines } = splitEntries(raw);
    // 半行不可 parse（读取端按 line_invalid 跳过）；新记录完整可解析。
    assert.equal(badLines.length, 1);
    assert.equal(badLines[0], tornHalf);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.type, "accepted_input");
    assert.equal(firstAcceptedText(entries[0]!), "after-crash");
  });

  it("正常文件无半行时续写不补多余空行", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });
    await writer.recordAcceptedInput("s1", "t1", [userMessage("first")]);

    await writer.recordAcceptedInput("s1", "t2", [userMessage("second")]);

    const raw = readFileSync(path, "utf8");
    // 无半行时不应在两条之间引入多余空行（无 torn-tail 补 `\n`）：非空行恰好两行。
    const lines = raw.split("\n").filter(l => l.length > 0);
    assert.equal(lines.length, 2);
    const { entries, badLines } = splitEntries(raw);
    assert.equal(badLines.length, 0);
    assert.equal(entries.length, 2);
    assert.equal(firstAcceptedText(entries[0]!), "first");
    assert.equal(firstAcceptedText(entries[1]!), "second");
  });
});

describe("JsonlTranscriptWriter 大记录不撕裂", () => {
  it("单条记录超过 appendFile 的 512 KiB 分块阈值仍完整落盘", async () => {
    const dir = makeTranscriptDir();
    const path = join(dir, "session.jsonl");
    const writer = new JsonlTranscriptWriter({ path, now: FIXED_NOW, flushThresholdBytes: 0 });

    const bigText = "x".repeat(700 * 1024); // ~700 KB > 512 KiB
    await writer.recordAcceptedInput("s1", "t1", [userMessage(bigText)]);

    const raw = readFileSync(path, "utf8");
    const { entries, badLines } = splitEntries(raw);
    assert.equal(badLines.length, 0, "no torn lines for a >512 KiB record");
    assert.equal(entries.length, 1);
    assert.equal(firstAcceptedText(entries[0]!), bigText, "record must be lossless");
  });
});
