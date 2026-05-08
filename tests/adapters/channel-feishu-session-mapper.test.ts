import test from "node:test";
import assert from "node:assert/strict";
import { FeishuSessionMapper } from "../../src/adapters/index.js";

test("FeishuSessionMapper uses general session until /new switches the chat", () => {
  let index = 0;
  const mapper = new FeishuSessionMapper(undefined, () => `uuid-${++index}`);

  assert.deepEqual(mapper.resolve({ chatId: "chat-1", text: "hello" }), {
    sessionKey: "feishu:chat=chat-1:general",
    message: "hello",
  });
  assert.deepEqual(mapper.resolve({ chatId: "chat-1", text: "/new" }), {
    sessionKey: "feishu:chat=chat-1:s_uuid-1",
    command: "new",
    message: "",
  });
  assert.deepEqual(mapper.resolve({ chatId: "chat-1", text: "next" }), {
    sessionKey: "feishu:chat=chat-1:s_uuid-1",
    message: "next",
  });
});
