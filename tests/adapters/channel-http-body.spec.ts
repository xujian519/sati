import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { readRequestBody } from "../../src/adapters/channel/protocol/httpBody.js";

/**
 * 用 Readable 冒充 IncomingMessage：readRequestBody 只消费 data/end/error/destroy，
 * 不需要真实 socket。
 */
function fakeRequest(chunks: Buffer[], destroyError?: Error): IncomingMessage {
  const stream = new Readable({ read() {} });
  setImmediate(() => {
    for (const chunk of chunks) stream.push(chunk);
    if (destroyError) stream.destroy(destroyError);
    else stream.push(null);
  });
  return stream as unknown as IncomingMessage;
}

test("readRequestBody 拼接分片并按 UTF-8 解码（多字节字符跨分片）", async () => {
  const bytes = Buffer.from("中文", "utf8");
  assert.equal(bytes.length, 6);
  const req = fakeRequest([bytes.subarray(0, 2), bytes.subarray(2, 4), bytes.subarray(4)]);
  assert.equal(await readRequestBody(req, 1024), "中文");
});

test("readRequestBody 恰好等于上限时正常返回", async () => {
  const req = fakeRequest([Buffer.alloc(4, 0x61)]);
  assert.equal(await readRequestBody(req, 4), "aaaa");
});

test("readRequestBody 超过上限时以 payload too large 拒绝并销毁请求", async () => {
  const req = fakeRequest([Buffer.alloc(4, 0x61), Buffer.alloc(1, 0x62)]);
  await assert.rejects(() => readRequestBody(req, 4), /^Error: payload too large$/);
  assert.equal((req as unknown as Readable).destroyed, true);
});

test("readRequestBody 透传流错误", async () => {
  const req = fakeRequest([], new Error("socket hang up"));
  await assert.rejects(() => readRequestBody(req, 1024), /socket hang up/);
});
