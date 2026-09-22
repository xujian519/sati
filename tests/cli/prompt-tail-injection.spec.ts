/**
 * 逐轮可变的注入段落必须落在**请求消息尾部**，而不是 system prompt（2.3「系统提示分桶」）。
 *
 * 起因：Anthropic 的 `cache_control` 打在整个 system 块上（`anthropic/request.ts`），
 * OpenAI / DeepSeek 的隐式前缀缓存同理——落在 system prompt 里的逐轮可变内容会把缓存
 * 前缀整段打穿，而不只是那一小段。账本块（`<workspace-state>`）是最典型的一例：
 * `readWorkspaceLedgerBlock` 曾把它作为 system-prompt 追加段注入，而
 * `src/context/cache/CachePlan.ts` 的布局约束早已声称这类注入「位于最近 N 条断点之后」。
 *
 * 断言走**真实网关接线 + 脚本化模型真写账本**（`workspace_note`）：要钉住的正是端到端落点，
 * 而账本块只有经真实写入才会出现（空账本不产生块）。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { isTailInjection } from "../../src/context/prompt/tailInjection.js";
import type { CanonicalModelRequest, CanonicalToolCall, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";

const BASE_CONFIG = [
  "schemaVersion: 1",
  "agent:",
  "  model: test/model",
  "  maxContextTokens: 131072",
  "  maxOutputTokens: 8192",
  "model:",
  "  providers:",
  "    test:",
  "      protocol: anthropic",
  "      url: https://example.test/v1",
  "      apiKey: test-key",
  "      models:",
  "        model: {}",
  "telemetry:",
  "  enabled: false",
  "",
].join("\n");

/** 首次请求发出 `workspace_note` 工具调用，其余请求纯文本（驱动真实账本写入）。 */
function fakeModelRuntime(
  requests: CanonicalModelRequest[],
  script: (requestIndex: number) => CanonicalToolCall[],
): ModelRuntime {
  return {
    stream: async function* (request) {
      requests.push(request);
      const toolCalls = script(requests.length);
      yield { type: "message_start", role: "assistant" };
      if (toolCalls.length === 0) {
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", finishReason: "stop" };
        return;
      }
      for (const toolCall of toolCalls) {
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
      }
      yield { type: "message_end", finishReason: "tool_call" };
    },
    complete: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" }),
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "anthropic",
    getProviderBaseUrl: () => undefined,
  };
}

function lastMessageText(request: CanonicalModelRequest): string {
  const last = request.messages.at(-1);
  if (!last) return "";
  return last.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

test("账本块落在请求消息尾部：system prompt 逐轮逐字节稳定，缓存断点不打在注入消息上", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-tail-injection-"));
  await writeFile(join(root, "sati.yaml"), BASE_CONFIG, "utf8");
  const requests: CanonicalModelRequest[] = [];
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    permissionMode: "bypassPermissions",
    env: { SATI_KNOWLEDGE_DIR: join(root, "knowledge-absent"), SATI_WORKSPACE_LEDGER_ENABLED: "1" },
    __testModelFactory: () =>
      fakeModelRuntime(requests, requestIndex =>
        requestIndex === 1
          ? [
              {
                id: "note-1",
                name: "workspace_note",
                input: { goal: "量出 system prompt 是否逐轮稳定", next: "对比账本写入前后的 system digest" },
              },
            ]
          : [],
      ),
  });
  try {
    for (const message of ["先记一笔账", "继续"]) {
      for await (const _event of local.gateway.submitTurn({
        projectKey: root,
        sessionKey: "cli:tail-injection",
        channelKey: "cli",
        message,
      })) {
        // 只需请求本身
      }
    }

    // 第 1 轮：首次请求（写入前）→ 之后那次请求（写入后）已带账本块；第 2 轮再取一次。
    const afterWrite = requests[1];
    const nextTurn = requests[2];
    assert.ok(afterWrite && nextTurn, `应捕获到写入后两个请求，实际 ${requests.length}`);
    assert.ok(lastMessageText(afterWrite).includes("<workspace-state>"), "写入后账本块应出现在请求里");

    for (const request of [afterWrite, nextTurn]) {
      assert.equal(request.systemPrompt?.includes("<workspace-state>"), false, "账本块不得进入 system prompt");
      const last = request.messages.at(-1);
      assert.ok(last !== undefined && isTailInjection(last), "账本块应作为尾部注入消息落在最后一条");
      assert.equal(isTailInjection(request.messages[1]), false, "普通历史消息不应被识别为尾部注入");
    }

    assert.equal(afterWrite.systemPrompt, nextTurn.systemPrompt, "system prompt 应跨轮逐字节稳定");
    const planned = afterWrite.cachePlan?.messages ?? [];
    assert.ok(planned.length > 0, "anthropic 协议下应有 per-request 缓存布局");
    assert.equal(
      planned.includes(afterWrite.messages.length - 1),
      false,
      "缓存断点不应打在逐轮变化的尾部注入上（该前缀永不重现）",
    );
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
