import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as net from "node:net";
import { afterEach, test } from "node:test";
import { WeComCallbackChannel } from "../../src/adapters/channel/wecom-callback/WeComCallbackChannel.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";

/**
 * 企微回调渠道（WeComCallbackChannel）契约测试 —— P3 第一卡。
 *
 * 覆盖的是**入站回调 → 解密 → gateway → 出站回复**这条闭环，用真实的 `node:http` 回调服务器 +
 * 按企微规范自行构造的 AES 密文/签名，而不是调用内部私有方法：
 *
 *   1. `GET`（回调 URL 验证）：sha1(msg_signature) 校验 → AES-256-CBC 解出 `echostr` 明文回写；
 *      签名不符 → 403，且不做任何解密。
 *   2. `POST`（消息推送）：签名校验 → XML 解出 `<Encrypt>` → AES 解密 → 200 `success` →
 *      入站文本进入 `gateway.submitTurn()` → 出站回复经 `message/send` 发回原会话。
 *   3. 坏签名 `POST`：403 且**不进入 gateway**（防伪造回调）。
 *   4. 缺 `<Encrypt>`：400（协议不符，不进入解密路径）。
 *
 * 出站方向（qyapi.weixin.qq.com）按仓库既有约定 stub `globalThis.fetch`
 * （见 tests/model/embedding/client.spec.ts），断言实际请求体字段。
 */

const CORP_ID = "ww_contract_corp";
const AGENT_ID = "1000002";
const CALLBACK_TOKEN = "contract-token";
/** 43 字符 base64（企微 EncodingAESKey 形态）：补一个 `=` 后正好解出 32 字节。 */
const ENCODING_AES_KEY = crypto.randomBytes(32).toString("base64").replace(/=+$/u, "");

function aesKey(): Buffer {
  const key = Buffer.from(`${ENCODING_AES_KEY}=`, "base64");
  assert.equal(key.length, 32, "EncodingAESKey 必须解出 32 字节");
  return key;
}

/** 按企微规范加密：16 字节随机 + 4 字节大端长度 + 明文 + corpId，PKCS#7 补齐到 32 字节块。 */
function encryptWxMessage(plain: string, corpId: string = CORP_ID): string {
  const key = aesKey();
  const msg = Buffer.from(plain, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(msg.length, 0);
  const raw = Buffer.concat([crypto.randomBytes(16), length, msg, Buffer.from(corpId, "utf8")]);
  const padLen = 32 - (raw.length % 32); // 1..32（长度整除时补满一整块）
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

/** 企微签名：sha1(sort(token, timestamp, nonce, encrypt).join(""))。 */
function sign(timestamp: string, nonce: string, encrypt: string): string {
  const sorted = [CALLBACK_TOKEN, timestamp, nonce, encrypt].sort().join("");
  return crypto.createHash("sha1").update(sorted).digest("hex");
}

/** 取一个空闲端口（渠道的 port=0 会回落默认 8780，故测试先探测再占用）。 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

type FetchCall = { url: string; body?: unknown };
const realFetch = globalThis.fetch;
const fetchCalls: FetchCall[] = [];

/** 只放行企微两处出站调用：gettoken 与 message/send。 */
function stubWxApi(onSend?: () => void): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("/gettoken")) {
      return json({ errcode: 0, access_token: "contract-access-token", expires_in: 7200 });
    }
    if (url.includes("/message/send")) {
      fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      onSend?.();
      return json({ errcode: 0, errmsg: "ok" });
    }
    throw new Error(`契约测试未预期的出站请求：${url}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  fetchCalls.length = 0;
});

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待超时：${what}`)), ms);
      timer.unref?.();
    }),
  ]);
}

type FakeGateway = { gateway: Gateway; turns: GatewaySubmitTurnInput[] };

function fakeGateway(events: GatewayEvent[]): FakeGateway {
  const turns: GatewaySubmitTurnInput[] = [];
  const gateway = {
    submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
      turns.push(input);
      return (async function* generate() {
        for (const event of events) yield event;
      })();
    },
  } as unknown as Gateway;
  return { gateway, turns };
}

function createChannel(port: number): WeComCallbackChannel {
  return new WeComCallbackChannel({
    corpId: CORP_ID,
    agentId: AGENT_ID,
    secret: "contract-corp-secret",
    token: CALLBACK_TOKEN,
    encodingAesKey: ENCODING_AES_KEY,
    port,
  });
}

function inboundTextXml(text: string, from = "zhangsan"): string {
  return (
    "<xml>" +
    `<ToUserName><![CDATA[${CORP_ID}]]></ToUserName>` +
    `<FromUserName><![CDATA[${from}]]></FromUserName>` +
    "<CreateTime>1726000000</CreateTime>" +
    "<MsgType><![CDATA[text]]></MsgType>" +
    `<Content><![CDATA[${text}]]></Content>` +
    "<MsgId>4567890123</MsgId>" +
    `<AgentID>${AGENT_ID}</AgentID>` +
    "</xml>"
  );
}

test("企微回调 GET：签名校验通过则 AES 解密 echostr 并回写明文，坏签名 403", async () => {
  const port = await freePort();
  const { gateway } = fakeGateway([]);
  const handle = await createChannel(port).start({ gateway });
  try {
    const plain = "verify-echostr-1726000000";
    const echostr = encryptWxMessage(plain);
    const timestamp = "1726000000";
    const nonce = "1234567890";

    const ok = await realFetch(
      `http://127.0.0.1:${port}/?msg_signature=${sign(timestamp, nonce, echostr)}` +
        `&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`,
    );
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), plain, "验证应回写解密后的 echostr 明文");

    const bad = await realFetch(
      `http://127.0.0.1:${port}/?msg_signature=0f1e2d3c4b5a` +
        `&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`,
    );
    assert.equal(bad.status, 403);
  } finally {
    await handle.stop("contract-test");
  }
});

test("企微回调 POST：签名有效则入站文本进入 gateway，回复经 message/send 发回原会话", async () => {
  const port = await freePort();
  const events: GatewayEvent[] = [{ type: "assistant_text_delta", text: "契约回执：状态正常" }];
  const { gateway, turns } = fakeGateway(events);
  let notifySent: (() => void) | undefined;
  const sent = new Promise<void>(resolve => {
    notifySent = resolve;
  });
  stubWxApi(() => notifySent?.());

  const handle = await createChannel(port).start({ gateway });
  try {
    const encrypt = encryptWxMessage(inboundTextXml("你好，查一下任务状态"));
    const timestamp = "1726000001";
    const nonce = "abcdef1234";
    const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;

    const res = await realFetch(
      `http://127.0.0.1:${port}/?msg_signature=${sign(timestamp, nonce, encrypt)}&timestamp=${timestamp}&nonce=${nonce}`,
      { method: "POST", body },
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "success", "回调必须先应答 success，再由渠道异步处理");

    await withTimeout(sent, 5_000, "出站 message/send");

    assert.equal(turns.length, 1, "同一条入站消息应只驱动一次 submitTurn");
    assert.equal(turns[0]?.channelKey, "wecom_callback");
    assert.equal(turns[0]?.message, "你好，查一下任务状态");
    assert.equal(turns[0]?.sessionKey, "wecom_callback:chat=zhangsan:general");

    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0]!.url, /\/message\/send\?access_token=/u);
    assert.deepEqual(fetchCalls[0]!.body, {
      touser: "zhangsan",
      msgtype: "text",
      agentid: Number(AGENT_ID),
      text: { content: "契约回执：状态正常" },
    });
  } finally {
    await handle.stop("contract-test");
  }
});

test("企微回调 POST：坏签名 403 且不进入 gateway", async () => {
  const port = await freePort();
  const { gateway, turns } = fakeGateway([{ type: "assistant_text_delta", text: "不应出现" }]);
  stubWxApi();

  const handle = await createChannel(port).start({ gateway });
  try {
    const encrypt = encryptWxMessage(inboundTextXml("伪造回调"));
    const timestamp = "1726000002";
    const nonce = "ffffffff";
    const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;

    const res = await realFetch(
      `http://127.0.0.1:${port}/?msg_signature=deadbeefdeadbeef&timestamp=${timestamp}&nonce=${nonce}`,
      { method: "POST", body },
    );
    assert.equal(res.status, 403);
    assert.equal(await res.text(), "signature");
    assert.equal(turns.length, 0, "签名不符的回调不得进入 agent 回路");
    assert.equal(fetchCalls.length, 0, "签名不符的回调不得触发任何出站请求");
  } finally {
    await handle.stop("contract-test");
  }
});

test("企微回调 POST：缺 <Encrypt> 节点 400", async () => {
  const port = await freePort();
  const { gateway, turns } = fakeGateway([]);
  stubWxApi();

  const handle = await createChannel(port).start({ gateway });
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/?msg_signature=x&timestamp=1&nonce=2`, {
      method: "POST",
      body: "<xml><ToUserName><![CDATA[ww_contract_corp]]></ToUserName></xml>",
    });
    assert.equal(res.status, 400);
    assert.equal(await res.text(), "no Encrypt");
    assert.equal(turns.length, 0);
  } finally {
    await handle.stop("contract-test");
  }
});
