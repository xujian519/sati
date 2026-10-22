import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import { FeishuChannel } from "../../src/adapters/index.js";
import type { Gateway } from "../../src/gateway/index.js";

const VERIFY_TOKEN = "lifecycle-verify-token";

type AbortInput = { sessionKey: string; runId?: string; reason?: string };

function createMockResponse(): { statusCode?: number; body?: string } & Record<string, unknown> {
  return {
    writeHead(statusCode: number) {
      this.statusCode = statusCode;
    },
    end(body: string) {
      this.body = body;
    },
  };
}

async function post(channel: FeishuChannel, body: unknown): Promise<{ statusCode?: number; body?: string }> {
  const response = createMockResponse();
  await channel.handleWebhook({} as IncomingMessage, response as unknown as ServerResponse, JSON.stringify(body));
  return response;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met before timeout");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("stop 中止在途回合、丢弃迟到文本并拒绝后续 webhook", async () => {
  const sent: string[] = [];
  const aborts: AbortInput[] = [];
  let started = false;
  let releaseTurn: (() => void) | undefined;
  const turnGate = new Promise<void>(resolve => {
    releaseTurn = resolve;
  });

  const gateway = {
    submitTurn: async function* (input: { sessionKey: string }) {
      started = true;
      yield { type: "turn_started", runId: "run-1", sessionKey: input.sessionKey };
      await turnGate;
      // 停止后控制器已取消：这段迟到文本不得再发送。
      yield { type: "assistant_text_delta", text: "late reply after stop" };
    },
    abortTurn: async (input: AbortInput) => {
      aborts.push(input);
      releaseTurn?.();
    },
  } as unknown as Gateway;

  const channel = new FeishuChannel({
    connectionMode: "webhook",
    verifyToken: VERIFY_TOKEN,
    send: async message => {
      sent.push(message.text);
    },
  });
  const handle = await channel.start({ gateway, logger: {} });
  try {
    const response = await post(channel, {
      token: VERIFY_TOKEN,
      chatId: "oc_stop",
      text: "run",
      eventId: "stop-1",
    });
    assert.equal(response.statusCode, 200);

    await waitFor(() => started);
    const internals = channel as unknown as {
      chatState: { activeRun(chatId: string): { runId?: string } | undefined };
      activeChats: Set<string>;
      inboundBatches: Map<string, unknown>;
    };
    await waitFor(() => internals.chatState.activeRun("oc_stop")?.runId === "run-1");

    await handle.stop("test shutdown");
    await waitFor(() => internals.activeChats.size === 0);

    assert.deepEqual(aborts, [{ sessionKey: aborts[0]!.sessionKey, runId: "run-1", reason: "test shutdown" }]);
    assert.equal(
      sent.some(text => text.includes("late reply after stop")),
      false,
    );
    assert.equal(internals.inboundBatches.size, 0);

    const afterStop = await post(channel, {
      token: VERIFY_TOKEN,
      chatId: "oc_stop",
      text: "again",
      eventId: "stop-2",
    });
    assert.equal(afterStop.statusCode, 503);
    assert.deepEqual(JSON.parse(afterStop.body ?? "{}"), { error: "feishu_not_started" });
    assert.equal(internals.inboundBatches.size, 0);
  } finally {
    releaseTurn?.();
    await handle.stop("cleanup");
  }
});
