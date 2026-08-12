import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  MIN_COMPRESS_CHARS,
  compressChunk,
  decompressChunk,
  registerChunkUncompress,
  shouldCompress,
} from "../../src/knowledge/shared/chunk-compression.js";

/**
 * chunk 应用级压缩（--compress-chunks 产物）单元测试。
 */

test("chunk-compression: 压缩/解压往返一致（中文长文本）", () => {
  const text = "权利要求所述技术方案具有突出的实质性特点，不属于本领域技术人员容易想到的改进。".repeat(30);
  const blob = compressChunk(text);
  assert.ok(blob.length < Buffer.byteLength(text, "utf8"), "压缩后应显著更小");
  assert.equal(blob[0], 0x53, "魔数第 1 字节");
  assert.equal(blob[1], 0x43, "魔数第 2 字节");
  assert.equal(decompressChunk(blob), text, "解压应还原原文");
});

test("chunk-compression: 明文 TEXT 原样返回（knowledgeNoteSave 写入兼容）", () => {
  const text = "普通明文笔记内容，无需压缩。";
  assert.equal(decompressChunk(text), text);
});

test("chunk-compression: 短文本保持明文（shouldCompress 阈值）", () => {
  const short = "短文本";
  assert.equal(shouldCompress(short), false, "低于 MIN_COMPRESS_CHARS 不压缩");
  const long = "超过阈值的长文本".repeat(Math.ceil(MIN_COMPRESS_CHARS / 8));
  assert.ok(long.length >= MIN_COMPRESS_CHARS, "fixture 长度达标");
  assert.equal(shouldCompress(long), true, "长度达标且有收益应压缩");
});

test("chunk-compression: 异常 BLOB 按 utf8 兜底", () => {
  const raw = Buffer.from("非压缩 BLOB 内容", "utf8");
  assert.equal(decompressChunk(raw), "非压缩 BLOB 内容");
});

test("chunk-compression: SC 魔数但非有效 gzip 不抛错（按 utf8 兜底）", () => {
  // 截断的迁移写入：前两字节是魔数但后面不是合法 gzip 流
  const corrupt = Buffer.concat([Buffer.from([0x53, 0x43]), Buffer.from("不是 gzip 数据", "utf8")]);
  assert.doesNotThrow(() => decompressChunk(corrupt), "非法 gzip 不应抛错（否则一行坏数据拖垮整条检索）");
  assert.equal(decompressChunk(corrupt), corrupt.toString("utf8"), "魔数匹配但解压失败时按 utf8 原样返回");
});

test("chunk-compression: sati_uncompress SQL 函数对损坏 BLOB 不抛错", () => {
  const db = new DatabaseSync(":memory:");
  registerChunkUncompress(db);
  db.exec("CREATE TABLE t (content)");
  db.prepare("INSERT INTO t VALUES (?)").run(Buffer.concat([Buffer.from([0x53, 0x43]), Buffer.from("坏数据")]));
  const row = db.prepare("SELECT sati_uncompress(content) AS c FROM t").get() as { c: string };
  assert.equal(typeof row.c, "string", "损坏行应返回字符串而非抛错");
  db.close();
});

test("chunk-compression: sati_uncompress SQL 函数（明文 TEXT 原样 / 压缩 BLOB 解压）", () => {
  const db = new DatabaseSync(":memory:");
  registerChunkUncompress(db);
  db.exec("CREATE TABLE t (content)");
  db.prepare("INSERT INTO t VALUES (?)").run("明文内容");
  db.prepare("INSERT INTO t VALUES (?)").run(compressChunk("压缩后的长正文内容".repeat(50)));
  db.prepare("INSERT INTO t VALUES (?)").run(null);
  const rows = db.prepare("SELECT sati_uncompress(content) AS c FROM t ORDER BY rowid").all() as Array<{
    c: string;
  }>;
  assert.equal(rows[0]!.c, "明文内容");
  assert.equal(rows[1]!.c, "压缩后的长正文内容".repeat(50));
  assert.equal(rows[2]!.c, "", "NULL 返回空串");
  db.close();
});

test("chunk-compression: 解压幂等（对压缩结果与明文均可重复调用）", () => {
  const text = "幂等性验证文本。".repeat(100);
  const blob = compressChunk(text);
  assert.equal(decompressChunk(decompressChunk(blob)), text, "两次解压结果一致");
});
