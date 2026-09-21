/**
 * 渠道合成消息（`syntheticMessages`）的非用户来源护栏。
 *
 * 走真实网关接线（`createLocalGateway` + 注入假模型），因为要证明的正是接线本身：
 * 渠道附带的提示文本最终以什么形态进入模型请求。`WeComChannel` 的交付物提示是
 * 今天唯一的生产者，但通道是网关级的——任何渠道都能塞文本进来。
 *
 * 两条不变量：
 * 1. 合成消息带护栏抬头（不是用户输入、也不构成授权）；
 * 2. 合成消息的 `metadata.synthetic` / `purpose` 一字不改——Web 投影过滤与压缩
 *    锚点判定都依赖它。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { NON_USER_ORIGIN_MARKER, NON_USER_ORIGIN_NOTICE } from "../../src/context/prompt/nonUserOriginNotice.js";
import type { CanonicalMessage, CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";

const BASE = [
  "schemaVersion: 1",
  "agent:",
  "  model: test/model",
  "  maxContextTokens: 65536",
  "  maxOutputTokens: 8192",
  "model:",
  "  providers:",
  "    test:",
  "      protocol: openai",
  "      url: https://example.test/v1",
  "      apiKey: test-key",
  "      models:",
  "        model: {}",
  "telemetry:",
  "  enabled: false",
  "",
].join("\n");

function fakeModelRuntime(requests: CanonicalModelRequest[]): ModelRuntime {
  return {
    stream: async function* (request) {
      requests.push(request);
      yield { type: "text_delta", text: "ok" };
    },
    complete: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" }),
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => undefined,
  };
}

function textOf(message: CanonicalMessage): string {
  return message.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("");
}

/** 跑一个真实回合，返回首个模型请求里 user 角色的消息。 */
async function userMessagesFor(syntheticMessages?: Array<{ text: string; purpose?: string }>) {
  const root = await mkdtemp(join(tmpdir(), "sati-synth-origin-"));
  await writeFile(join(root, "sati.yaml"), BASE, "utf8");
  const requests: CanonicalModelRequest[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: { SATI_KNOWLEDGE_DIR: join(root, "knowledge-absent") },
    __testModelFactory: () => fakeModelRuntime(requests),
  });
  try {
    for await (const _event of local.gateway.submitTurn({
      projectKey: root,
      sessionKey: "web:synth-origin",
      channelKey: "web",
      message: "把交底书转成权利要求",
      ...(syntheticMessages ? { syntheticMessages } : {}),
    })) {
      // 只需捕获首个请求的消息
    }
    const request = requests[0];
    assert.ok(request, "应捕获到模型请求");
    return request.messages
      .filter(message => message.role === "user")
      .map(message => ({ text: textOf(message), message }));
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("渠道合成消息带非用户来源护栏，且 synthetic/purpose 不变", async () => {
  const userMessages = await userMessagesFor([{ text: "本渠道要求交付物使用 HTML 附件", purpose: "test_hint" }]);
  const synthetic = userMessages.find(entry => entry.text.includes("本渠道要求交付物使用 HTML 附件"));
  assert.ok(synthetic, "合成消息应进入模型请求");
  assert.ok(synthetic.text.startsWith(NON_USER_ORIGIN_MARKER), "护栏抬头必须居首");
  assert.ok(synthetic.text.includes(NON_USER_ORIGIN_NOTICE), "护栏说明必须存在");
  assert.ok(synthetic.text.endsWith("本渠道要求交付物使用 HTML 附件"), "不得改写渠道原文");
  assert.deepEqual(synthetic.message.metadata, { synthetic: true, purpose: "test_hint" });
});

test("用户自己的消息不带护栏（不改动用户输入）", async () => {
  const userMessages = await userMessagesFor([{ text: "渠道提示" }]);
  const userTurn = userMessages.find(entry => entry.text.includes("把交底书转成权利要求"));
  assert.ok(userTurn, "用户消息应进入模型请求");
  assert.ok(!userTurn.text.includes(NON_USER_ORIGIN_MARKER), "用户输入不得被加护栏");
  assert.equal(userTurn.message.metadata, undefined);
});

test("无合成消息时不产生任何护栏抬头（回归）", async () => {
  const userMessages = await userMessagesFor();
  assert.ok(userMessages.length > 0);
  assert.ok(
    userMessages.every(entry => !entry.text.includes(NON_USER_ORIGIN_MARKER)),
    "没有非用户来源文本时不得注入护栏",
  );
});
