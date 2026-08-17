import assert from "node:assert/strict";
import test from "node:test";
import { getTokenizer, resetTokenCache } from "../../../src/context/budget/tokenizer.js";
import { countMessagesTokens } from "../../../src/router/utils/countTokens.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

/**
 * countMessagesTokens 增量语义（docs/workbuddy-sati-performance-analysis-review.md
 * P2-20 → 第二批 #8）。
 *
 * 逐消息计数 + tokenizer 内容级 sha1 缓存：追加新消息只编码新消息，
 * 旧消息 hash 命中，避免"全量 join → 整体缓存键变化 → 每轮全量重编码"
 * （CJK 高重复文本下分钟级阻塞）。
 */

function textMessage(role: CanonicalMessage["role"], text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] } as CanonicalMessage;
}

function spyEncode(): { encodeCalls: () => number } {
  const tokenizer = getTokenizer();
  const original = tokenizer.encode.bind(tokenizer);
  let calls = 0;
  (tokenizer as unknown as { encode: (text: string) => number[] }).encode = (text: string) => {
    calls += 1;
    return original(text);
  };
  return { encodeCalls: () => calls };
}

test("countMessagesTokens: 相同消息重复计数全部缓存命中（零 encode）", () => {
  resetTokenCache();
  const spy = spyEncode();
  const messages: CanonicalMessage[] = [
    textMessage("user", "第一段消息内容，涉及检索方法。"),
    textMessage("assistant", "第二段回复内容，涉及权利要求撰写。"),
  ];
  const first = countMessagesTokens(messages);
  assert.ok(first > 0);
  const callsAfterFirst = spy.encodeCalls();

  const second = countMessagesTokens(messages);
  assert.equal(second, first, "相同消息重复计数结果应一致");
  assert.equal(spy.encodeCalls(), callsAfterFirst, "内容未变不应触发 tokenizer 编码");
});

test("countMessagesTokens: 追加新消息仅编码新消息（增量）", () => {
  resetTokenCache();
  const spy = spyEncode();
  const base: CanonicalMessage[] = [
    textMessage("user", "增量测试第一段：语义索引构建。"),
    textMessage("assistant", "增量测试第二段：检索通道选择。"),
  ];
  countMessagesTokens(base);
  const callsAfterBase = spy.encodeCalls();

  const appended: CanonicalMessage[] = [...base, textMessage("user", "增量测试第三段：追加消息内容。")];
  const total = countMessagesTokens(appended);
  assert.ok(total > 0);
  assert.equal(spy.encodeCalls(), callsAfterBase + 1, "追加一条新消息应只编码新消息（旧消息 sha1 命中）");
});

test("countMessagesTokens: 空消息与空序列为零", () => {
  resetTokenCache();
  assert.equal(countMessagesTokens([]), 0);
  const empty: CanonicalMessage = { role: "user", content: [] } as CanonicalMessage;
  assert.equal(countMessagesTokens([empty]), 0);
});
