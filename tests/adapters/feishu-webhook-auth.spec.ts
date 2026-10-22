import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { FeishuChannel } from "../../src/adapters/index.js";
import type { Gateway } from "../../src/gateway/index.js";

const VERIFY_TOKEN = "verify-token-for-test";
const ENCRYPT_KEY = "encrypt-key-for-test";

function createChannel(options: ConstructorParameters<typeof FeishuChannel>[0] = {}): FeishuChannel {
  return new FeishuChannel({
    connectionMode: "webhook",
    send: async () => undefined,
    ...options,
  });
}

async function startChannel(channel: FeishuChannel): Promise<void> {
  const gateway = {
    submitTurn: async function* () {
      // 鉴权用例只关心入站是否被接受；排空时给出空事件流即可。
      yield* [];
    },
  } as unknown as Gateway;
  await channel.start({ gateway, logger: {} });
}

type MockResponse = {
  statusCode?: number;
  body?: string;
  writeHead(statusCode: number): void;
  end(body: string): void;
};

function createMockResponse(): MockResponse {
  return {
    writeHead(statusCode: number) {
      this.statusCode = statusCode;
    },
    end(body: string) {
      this.body = body;
    },
  };
}

async function post(
  channel: FeishuChannel,
  body: string,
  headers: IncomingMessage["headers"] = {},
): Promise<MockResponse> {
  const response = createMockResponse();
  await channel.handleWebhook({ headers } as IncomingMessage, response as unknown as ServerResponse, body);
  return response;
}

function discardPending(channel: FeishuChannel): void {
  const internals = channel as unknown as {
    inboundBatches: Map<string, { timer?: ReturnType<typeof setTimeout> }>;
  };
  for (const batch of internals.inboundBatches.values()) {
    if (batch.timer) clearTimeout(batch.timer);
  }
  internals.inboundBatches.clear();
}

function hasPending(channel: FeishuChannel, chatId: string): boolean {
  return (channel as unknown as { inboundBatches: Map<string, unknown> }).inboundBatches.has(chatId);
}

function sign(body: string, key: string, timestamp = "1700000000", nonce = "nonce"): IncomingMessage["headers"] {
  return {
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": createHash("sha256")
      .update(timestamp + nonce + key + body)
      .digest("hex"),
  };
}

function encryptPayload(payload: unknown, key: string): string {
  const aesKey = createHash("sha256").update(key, "utf8").digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", aesKey, iv);
  const cipherText = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipherText]).toString("base64");
}

function messageBody(chatId = "oc_auth", eventId = "event-1"): string {
  return JSON.stringify({ chatId, text: "hello", eventId });
}

// ---------------------------------------------------------------------------
// 未配置任何密钥
// ---------------------------------------------------------------------------

test("没有 verifyToken/encryptKey 时拒绝所有 webhook，不消费事件", async () => {
  const channel = createChannel();
  await startChannel(channel);

  const response = await post(channel, messageBody());

  assert.equal(response.statusCode, 401);
  assert.deepEqual(JSON.parse(response.body ?? "{}"), { error: "invalid_feishu_webhook_auth" });
  assert.equal(hasPending(channel, "oc_auth"), false);
});

// ---------------------------------------------------------------------------
// verifyToken
// ---------------------------------------------------------------------------

test("verifyToken：缺失、错误或仅大小写不同都返回 401", async () => {
  const channel = createChannel({ verifyToken: VERIFY_TOKEN });
  await startChannel(channel);

  const missing = await post(channel, messageBody());
  const wrong = await post(channel, JSON.stringify({ chatId: "oc_auth", text: "hi", token: "wrong" }));
  const caseOnly = await post(
    channel,
    JSON.stringify({ chatId: "oc_auth", text: "hi", token: VERIFY_TOKEN.toUpperCase() }),
  );

  for (const response of [missing, wrong, caseOnly]) {
    assert.equal(response.statusCode, 401, response.body ?? "");
    assert.deepEqual(JSON.parse(response.body ?? "{}"), { error: "invalid_feishu_webhook_auth" });
  }
  assert.equal(hasPending(channel, "oc_auth"), false);
});

test("verifyToken：顶层 token 与 header.token 均可通过", async () => {
  const topLevel = createChannel({ verifyToken: VERIFY_TOKEN });
  await startChannel(topLevel);

  const topLevelResponse = await post(
    topLevel,
    JSON.stringify({ chatId: "oc_auth", text: "hi", eventId: "e1", token: VERIFY_TOKEN }),
  );
  assert.equal(topLevelResponse.statusCode, 200);
  assert.equal(hasPending(topLevel, "oc_auth"), true);
  discardPending(topLevel);

  const headerToken = createChannel({ verifyToken: VERIFY_TOKEN });
  await startChannel(headerToken);

  const v2Body = JSON.stringify({
    header: { token: VERIFY_TOKEN, event_id: "e2", event_type: "im.message.receive_v1" },
    event: { message: { chat_id: "oc_auth", content: JSON.stringify({ text: "hi" }), message_type: "text" } },
  });
  const headerResponse = await post(headerToken, v2Body);
  assert.equal(headerResponse.statusCode, 200);
  assert.equal(hasPending(headerToken, "oc_auth"), true);
  discardPending(headerToken);
});

test("url_verification 也必须通过 verifyToken，不能绕过鉴权", async () => {
  const channel = createChannel({ verifyToken: VERIFY_TOKEN });
  await startChannel(channel);

  const wrong = await post(
    channel,
    JSON.stringify({ type: "url_verification", challenge: "challenge-1", token: "wrong" }),
  );
  const missing = await post(channel, JSON.stringify({ type: "url_verification", challenge: "challenge-1" }));
  const valid = await post(
    channel,
    JSON.stringify({ type: "url_verification", challenge: "challenge-1", token: VERIFY_TOKEN }),
  );

  assert.equal(wrong.statusCode, 401);
  assert.equal(missing.statusCode, 401);
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(JSON.parse(valid.body ?? "{}"), { challenge: "challenge-1" });
});

// ---------------------------------------------------------------------------
// encryptKey 与签名
// ---------------------------------------------------------------------------

test("encryptKey：明文事件缺少签名时返回 401", async () => {
  const channel = createChannel({ encryptKey: ENCRYPT_KEY });
  await startChannel(channel);

  const response = await post(channel, messageBody());

  assert.equal(response.statusCode, 401);
  assert.equal(hasPending(channel, "oc_auth"), false);
});

test("encryptKey：签名覆盖原始 body，正确签名放行、错误签名拒绝", async () => {
  const validChannel = createChannel({ encryptKey: ENCRYPT_KEY });
  await startChannel(validChannel);

  const body = messageBody();
  const valid = await post(validChannel, body, sign(body, ENCRYPT_KEY));
  assert.equal(valid.statusCode, 200);
  assert.equal(hasPending(validChannel, "oc_auth"), true);
  discardPending(validChannel);

  const invalidChannel = createChannel({ encryptKey: ENCRYPT_KEY });
  await startChannel(invalidChannel);
  const tampered = await post(invalidChannel, `${body} `, sign(body, ENCRYPT_KEY));
  assert.equal(tampered.statusCode, 401);
  assert.equal(hasPending(invalidChannel, "oc_auth"), false);
});

test("encryptKey：加密事件解密成功后仍需校验签名", async () => {
  const encrypted = JSON.stringify({
    encrypt: encryptPayload({ chatId: "oc_auth", text: "hi", eventId: "enc-1" }, ENCRYPT_KEY),
  });

  const unsigned = createChannel({ encryptKey: ENCRYPT_KEY });
  await startChannel(unsigned);
  assert.equal((await post(unsigned, encrypted)).statusCode, 401);

  const signed = createChannel({ encryptKey: ENCRYPT_KEY });
  await startChannel(signed);
  const response = await post(signed, encrypted, sign(encrypted, ENCRYPT_KEY));
  assert.equal(response.statusCode, 200);
  assert.equal(hasPending(signed, "oc_auth"), true);
  discardPending(signed);

  const wrongKey = createChannel({ encryptKey: "another-key" });
  await startChannel(wrongKey);
  assert.equal((await post(wrongKey, encrypted, sign(encrypted, "another-key"))).statusCode, 401);
});

test("加密的首次 url_verification 允许不带签名头，但必须能解密", async () => {
  const challenge = JSON.stringify({
    encrypt: encryptPayload({ type: "url_verification", challenge: "challenge-enc" }, ENCRYPT_KEY),
  });
  const channel = createChannel({ encryptKey: ENCRYPT_KEY });
  await startChannel(channel);

  const unsigned = await post(channel, challenge);
  assert.equal(unsigned.statusCode, 200);
  assert.deepEqual(JSON.parse(unsigned.body ?? "{}"), { challenge: "challenge-enc" });

  const plaintextUnsigned = await post(
    channel,
    JSON.stringify({ type: "url_verification", challenge: "challenge-plain" }),
  );
  assert.equal(plaintextUnsigned.statusCode, 401);

  const undecryptable = await post(
    channel,
    JSON.stringify({ encrypt: encryptPayload({ type: "url_verification", challenge: "x" }, "wrong-key") }),
  );
  assert.equal(undecryptable.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Lark / Feishu REST 域名
// ---------------------------------------------------------------------------

test("Open API 域名跟随 domainName，避免 Lark 租户打到飞书端点", () => {
  const lark = createChannel({ domainName: "lark" }) as unknown as { openApiUrl(path: string): string };
  const feishu = createChannel({ domainName: "feishu" }) as unknown as { openApiUrl(path: string): string };

  assert.equal(lark.openApiUrl("/open-apis/im/v1/messages"), "https://open.larksuite.com/open-apis/im/v1/messages");
  assert.equal(feishu.openApiUrl("/open-apis/im/v1/messages"), "https://open.feishu.cn/open-apis/im/v1/messages");
});
