import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { readTranscript } from "../../../src/session/transcript/TranscriptReader.js";
import type { AgentTranscriptEntry } from "../../../src/session/transcript/TranscriptEntry.js";

/** 提取 accepted_input 首条文本（union 判别收窄）。 */
function acceptedInputText(entry: AgentTranscriptEntry | undefined): string {
  if (entry === undefined || entry.type !== "accepted_input") return "";
  const content = entry.messages[0]?.content[0];
  return content?.type === "text" ? content.text : "";
}

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

  it("快路径命中返回共享元素浅拷贝（诊断数组为拷贝）", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "内容")]);
    const first = await readTranscript(path);
    const second = await readTranscript(path);
    assert.notEqual(second.entries, first.entries, "数组应为新拷贝");
    assert.equal(second.entries[0], first.entries[0], "元素应共享引用");
    assert.notEqual(second.diagnostics, first.diagnostics, "诊断数组应为拷贝（防御消费者 push 污染进程级状态）");
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
    assert.equal(done.diagnostics.length, 0, "半行补全后其 line_invalid 诊断应被治愈（不累积）");
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

  it("多次增量后诊断行号不漂移（尾空段不算行）", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "一"), entryLine("s1", 2, "二")]);
    await readTranscript(path);
    // 三次追加（每次都 \n 结尾 → 每轮末段为空段）：旧实现每轮 lineCount +1
    // 漂移，坏行诊断行号逐轮错位；新实现与全量解析一致。
    writeFileSync(path, entryLine("s1", 3, "三"), { flag: "a" });
    await readTranscript(path);
    writeFileSync(path, entryLine("s1", 4, "四"), { flag: "a" });
    await readTranscript(path);
    writeFileSync(path, entryLine("s1", 5, "五"), { flag: "a" });
    await readTranscript(path);
    writeFileSync(path, "NOT_JSON\n", { flag: "a" });
    const result = await readTranscript(path);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.line, 6, "多次增量后行号仍为文件绝对行号");

    // 对照全量解析同文件
    const fresh = makeTranscriptPath();
    writeFileSync(
      fresh,
      [
        entryLine("s1", 1, "一"),
        entryLine("s1", 2, "二"),
        entryLine("s1", 3, "三"),
        entryLine("s1", 4, "四"),
        entryLine("s1", 5, "五"),
        "NOT_JSON\n",
      ].join(""),
    );
    const full = await readTranscript(fresh);
    assert.equal(full.diagnostics[0]?.line, result.diagnostics[0]?.line, "增量与全量诊断行号一致");
  });

  it("UTF-8 多字节撕裂：半行切在字符中间，补全后内容完整", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "一")]);
    await readTranscript(path);

    // 第 2 行含中文，把切片点定在第一个「正」的第 2 字节（多字节字符中间）
    const line2 = entryLine("s1", 2, "正".repeat(10));
    const line2Bytes = Buffer.from(line2, "utf8");
    const firstCharByteStart = Buffer.byteLength(line2.slice(0, line2.indexOf("正")));
    const cut = firstCharByteStart + 1; // 第一个「正」3 字节中的中间字节
    writeFileSync(path, line2Bytes.subarray(0, cut), { flag: "a" });
    const mid = await readTranscript(path);
    assert.equal(mid.entries.length, 1, "撕裂半行不解析");

    writeFileSync(path, line2Bytes.subarray(cut), { flag: "a" });
    const done = await readTranscript(path);
    const text = acceptedInputText(done.entries[1]);
    assert.equal(text, "正".repeat(10), "拼接后中文字符完整（无 U+FFFD 混入）");
    assert.ok(!text.includes("�"), "不得包含替换字符");
    assert.equal(done.diagnostics.length, 0);
  });

  it("头部指纹守卫：sequence 递增的会话替换（stat 三维全合理）→ 全量重读", async () => {
    const path = makeTranscriptPath();
    writeTranscript(path, [entryLine("s1", 1, "旧一"), entryLine("s1", 2, "旧二"), entryLine("s1", 3, "旧三")]);
    await readTranscript(path);
    // 替换为另一会话：size 更大、mtime 更新、sequence 单调递增（4,5,6）——
    // 旧守卫 1/2/3b 全部放行会静默合并两会话条目；头部指纹不同 → 全量。
    writeTranscript(path, [entryLine("s2", 4, "新四"), entryLine("s2", 5, "新五"), entryLine("s2", 6, "新六")]);
    const result = await readTranscript(path);
    assert.deepEqual(
      result.entries.map(e => e.sequence),
      [4, 5, 6],
      "替换后只含新会话条目（不静默合并旧内容）",
    );
    assert.equal(result.entries[0]?.sessionId, "s2");
  });

  it("同 mtime+size 替换：快路径周期校验兜底可见（最迟一个校验周期）", async () => {
    process.env.SATI_TRANSCRIPT_VERIFY_MS = "50";
    try {
      const path = makeTranscriptPath();
      const original = entryLine("s1", 1, "AAA");
      writeTranscript(path, [original]);
      // 先固定 mtime（过去时刻）再读入：state.mtimeMs 精确等于文件 mtime，
      // 后续覆盖 + utimes 重置同值 → stat 三维完全一致。
      const fixedMtime = new Date("2020-01-01T00:00:00.000Z");
      utimesSync(path, fixedMtime, fixedMtime);
      await readTranscript(path);

      // 同长度覆盖（内容不同）+ mtime 重置：stat 三维完全一致
      writeFileSync(path, original.replace("AAA", "BBB"));
      utimesSync(path, fixedMtime, fixedMtime);
      // 校验周期内：快路径命中返回旧内容（设计行为：最迟一个周期可见）
      const stale = await readTranscript(path);
      assert.equal(acceptedInputText(stale.entries[0]), "AAA", "周期内快路径命中（陈旧但一致，非错乱）");

      // 越过校验周期：头部指纹差异 → 全量重读 → 新内容可见
      await new Promise(resolve => setTimeout(resolve, 80));
      const fresh = await readTranscript(path);
      assert.equal(acceptedInputText(fresh.entries[0]), "BBB", "同 mtime+size 替换最迟一个校验周期内可见");
    } finally {
      delete process.env.SATI_TRANSCRIPT_VERIFY_MS;
    }
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
