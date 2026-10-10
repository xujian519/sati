import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimestampTransform } from "../../apps/desktop/src/server-manager.js";

/**
 * spawnWithLog 逐行时间戳管道（createTimestampTransform）的行为锚。
 *
 * 背景（2026-10 桌面端变慢排查）：desktop.server.log 此前 136k 行全无时间戳，
 * 「从何时开始变慢」只能靠外部线索推断。补前缀后有三类回归必须钉住：
 *   1. 多行 chunk —— 每个逻辑行各得一个前缀（不能只给 chunk 首行）；
 *   2. 跨 chunk 断行 —— 残行拼接后前缀恰好一次（不能重复加）；
 *   3. 未换行尾行 —— end() 时 flush 补出（崩溃日志最后一行往往最重要）；
 *   4. 跨 chunk 断多字节字符 —— 切点落在 UTF-8 字符中间不得出现 U+FFFD。
 * 只测第 1 条无法区分「逐行前缀」与「每 chunk 前缀」——前三者一起才钉住
 * 行缓冲语义；第 4 条钉住字节→字符串解码的多字节安全（中文日志为主）。
 */

const TS_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

/** 喂入 chunks 并收全量输出（end() 触发 flush）；Buffer 用于按字节切分。 */
function run(chunks: Array<string | Buffer>): Promise<string> {
  return new Promise((resolve, reject) => {
    const transform = createTimestampTransform();
    const parts: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => parts.push(chunk));
    transform.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    transform.on("error", reject);
    for (const chunk of chunks) transform.write(chunk);
    transform.end();
  });
}

test("多行 chunk：每个逻辑行各得一个 ISO 前缀", async () => {
  const out = await run(["alpha\nbeta\n"]);
  const lines = out.split("\n");
  assert.equal(lines.length, 3, "两行正文 + 末尾 split 空段");
  assert.match(lines[0], TS_PREFIX);
  assert.match(lines[1], TS_PREFIX);
  assert.equal(lines[0].replace(TS_PREFIX, ""), "alpha");
  assert.equal(lines[1].replace(TS_PREFIX, ""), "beta");
});

test("跨 chunk 断行：残行拼接后前缀恰好一次", async () => {
  const out = await run(["hel", "lo\n"]);
  assert.equal(out.match(/\d{4}-\d{2}-\d{2}T/g)?.length ?? 0, 1, "一个逻辑行只能有一个前缀");
  assert.equal(out.replace(TS_PREFIX, ""), "hello\n");
});

test("未换行尾行：end 时 flush 补出（崩溃现场最后一行不丢）", async () => {
  const out = await run(["tail-without-newline"]);
  assert.match(out, TS_PREFIX);
  assert.equal(out.replace(TS_PREFIX, ""), "tail-without-newline\n");
});

test("跨 chunk 断多字节字符：切点落在 UTF-8 字符中间不产生 U+FFFD", async () => {
  const line = "错误：模型加载失败\n";
  const bytes = Buffer.from(line, "utf8");
  // 「错」为 3 字节，在第 1 字节后切开——裸 toString 会让两侧各解出替换字符
  const out = await run([bytes.subarray(0, 1), bytes.subarray(1)]);
  assert.ok(!out.includes("\uFFFD"), `输出不应含 U+FFFD 替换字符: ${JSON.stringify(out)}`);
  assert.match(out, TS_PREFIX);
  assert.equal(out.replace(TS_PREFIX, ""), line);
});
