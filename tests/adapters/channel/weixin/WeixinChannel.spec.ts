import assert from "node:assert/strict";
import test from "node:test";

import type { Gateway, GatewayEvent } from "../../../../src/gateway/index.js";
import { WeixinChannel } from "../../../../src/adapters/channel/weixin/WeixinChannel.js";

test("weixin does not set a channel-level turn timeout by default", async () => {
  let observedTimeoutMs: number | undefined;
  const gateway = {
    async *submitTurn(input: { timeoutMs?: number }) {
      observedTimeoutMs = input.timeoutMs;
      yield { type: "turn_started", runId: "run-1" } satisfies GatewayEvent;
      yield { type: "turn_completed", usage: {}, finishReason: "completed" } satisfies GatewayEvent;
    },
  } as Partial<Gateway> as Gateway;
  const channel = new WeixinChannel();
  const testChannel = channel as unknown as {
    gateway: Gateway;
    client: {
      sendTextChunked(toUserId: string, text: string, contextToken: string, maxLength?: number): Promise<number>;
      sendTyping(userId: string, contextToken?: string): Promise<void>;
    };
    contextTokens: Map<string, string>;
    processMessage(userId: string, sessionKey: string, message: string, projectKey?: string): Promise<void>;
  };

  testChannel.gateway = gateway;
  testChannel.client = {
    async sendTextChunked() {
      return 1;
    },
    async sendTyping() {},
  };
  testChannel.contextTokens = new Map([["user-1", "ctx-1"]]);

  await testChannel.processMessage("user-1", "weixin:chat=user-1:general", "做一个 PPT");

  assert.equal(observedTimeoutMs, undefined);
});

test("weixin sends visible progress while a turn has no assistant text", async () => {
  const sentTexts: string[] = [];
  let resumeTurn: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resumeTurn = resolve;
  });
  const gateway = {
    async *submitTurn() {
      yield { type: "turn_started", runId: "run-1" } satisfies GatewayEvent;
      yield { type: "tool_call_started", toolCallId: "tool-1", name: "bash" } satisfies GatewayEvent;
      await gate;
      yield {
        type: "tool_call_finished",
        toolCallId: "tool-1",
        ok: true,
        toolName: "bash",
      } satisfies GatewayEvent;
      yield { type: "turn_completed", usage: {}, finishReason: "completed" } satisfies GatewayEvent;
    },
  } as Partial<Gateway> as Gateway;
  const channel = new WeixinChannel({
    liveReplyOptions: {
      activityDelayMs: 1,
      activityUpdateThrottleMs: 10_000,
      turnTimeoutMs: 60_000,
    },
  });
  const testChannel = channel as unknown as {
    gateway: Gateway;
    client: {
      sendTextChunked(toUserId: string, text: string, contextToken: string, maxLength?: number): Promise<number>;
      sendTyping(userId: string, contextToken?: string): Promise<void>;
    };
    contextTokens: Map<string, string>;
    processMessage(userId: string, sessionKey: string, message: string, projectKey?: string): Promise<void>;
  };

  testChannel.gateway = gateway;
  testChannel.client = {
    async sendTextChunked(_toUserId, text) {
      sentTexts.push(text);
      return 1;
    },
    async sendTyping() {},
  };
  testChannel.contextTokens = new Map([["user-1", "ctx-1"]]);

  const processing = testChannel.processMessage("user-1", "weixin:chat=user-1:general", "做一个 PPT");
  await new Promise((resolve) => setTimeout(resolve, 30));
  resumeTurn?.();
  await processing;

  assert.ok(sentTexts.some((text) => text.includes("仍在处理：正在执行工具")));
});

test("weixin honors an explicit live reply timeout override", async () => {
  let observedTimeoutMs: number | undefined;
  const gateway = {
    async *submitTurn(input: { timeoutMs?: number }) {
      observedTimeoutMs = input.timeoutMs;
      yield { type: "turn_started", runId: "run-1" } satisfies GatewayEvent;
      yield { type: "turn_completed", usage: {}, finishReason: "completed" } satisfies GatewayEvent;
    },
  } as Partial<Gateway> as Gateway;
  const channel = new WeixinChannel({ liveReplyOptions: { turnTimeoutMs: 1234 } });
  const testChannel = channel as unknown as {
    gateway: Gateway;
    client: {
      sendTextChunked(toUserId: string, text: string, contextToken: string, maxLength?: number): Promise<number>;
      sendTyping(userId: string, contextToken?: string): Promise<void>;
    };
    contextTokens: Map<string, string>;
    processMessage(userId: string, sessionKey: string, message: string, projectKey?: string): Promise<void>;
  };

  testChannel.gateway = gateway;
  testChannel.client = {
    async sendTextChunked() {
      return 1;
    },
    async sendTyping() {},
  };
  testChannel.contextTokens = new Map([["user-1", "ctx-1"]]);

  await testChannel.processMessage("user-1", "weixin:chat=user-1:general", "做一个 PPT");

  assert.equal(observedTimeoutMs, 1234);
});

test("weixin sends a visible final message when the turn times out", async () => {
  const sentTexts: string[] = [];
  const gateway = {
    async *submitTurn() {
      yield { type: "turn_started", runId: "run-1" } satisfies GatewayEvent;
      yield {
        type: "error",
        code: "turn_timeout",
        message: "Turn timed out.",
        recoverable: false,
      } satisfies GatewayEvent;
    },
  } as Partial<Gateway> as Gateway;
  const channel = new WeixinChannel();
  const testChannel = channel as unknown as {
    gateway: Gateway;
    client: {
      sendTextChunked(toUserId: string, text: string, contextToken: string, maxLength?: number): Promise<number>;
      sendTyping(userId: string, contextToken?: string): Promise<void>;
    };
    contextTokens: Map<string, string>;
    processMessage(userId: string, sessionKey: string, message: string, projectKey?: string): Promise<void>;
  };

  testChannel.gateway = gateway;
  testChannel.client = {
    async sendTextChunked(_toUserId, text) {
      sentTexts.push(text);
      return 1;
    },
    async sendTyping() {},
  };
  testChannel.contextTokens = new Map([["user-1", "ctx-1"]]);

  await testChannel.processMessage("user-1", "weixin:chat=user-1:general", "做一个 PPT");

  assert.ok(sentTexts.some((text) => text.includes("处理时间已超过上限，任务已停止")));
});

test("weixin notifies active chats once on connection loss and once on recovery", async () => {
  const sentTexts: string[] = [];
  let polls = 0;
  const channel = new WeixinChannel();
  const testChannel = channel as unknown as {
    client: {
      cursor: string;
      poll(): Promise<{ ret?: number; msgs?: unknown[] }>;
      sendTextChunked(toUserId: string, text: string, contextToken: string, maxLength?: number): Promise<number>;
      sendTyping(userId: string, contextToken?: string): Promise<void>;
    };
    activeChats: Set<string>;
    contextTokens: Map<string, string>;
    loopAbort: AbortController;
    sleep(ms: number): Promise<void>;
    pollLoop(): Promise<void>;
  };

  testChannel.client = {
    cursor: "",
    async poll() {
      polls++;
      if (polls === 1 || polls === 2) {
        return { ret: 500, msgs: [] };
      }
      testChannel.loopAbort.abort();
      return { ret: 0, msgs: [] };
    },
    async sendTextChunked(_toUserId, text) {
      sentTexts.push(text);
      return 1;
    },
    async sendTyping() {},
  };
  testChannel.activeChats = new Set(["user-1"]);
  testChannel.contextTokens = new Map([["user-1", "ctx-1"]]);
  testChannel.loopAbort = new AbortController();
  testChannel.sleep = async () => {};

  await testChannel.pollLoop();

  assert.equal(sentTexts.filter((text) => text.includes("微信连接暂时中断")).length, 1);
  assert.equal(sentTexts.filter((text) => text.includes("微信连接已恢复")).length, 1);
});

test("weixin reports recovered disconnect and flushes replies missed while offline", async () => {
  const sentTexts: string[] = [];
  let online = false;
  let polls = 0;
  const channel = new WeixinChannel();
  const testChannel = channel as unknown as {
    client: {
      cursor: string;
      poll(): Promise<{ ret?: number; msgs?: unknown[] }>;
      sendTextChunked(toUserId: string, text: string, contextToken: string, maxLength?: number): Promise<number>;
      sendTyping(userId: string, contextToken?: string): Promise<void>;
    };
    activeChats: Set<string>;
    contextTokens: Map<string, string>;
    loopAbort: AbortController;
    sleep(ms: number): Promise<void>;
    pollLoop(): Promise<void>;
    sendReply(userId: string, text: string, options?: { queueOnFailure?: boolean }): Promise<boolean>;
  };

  testChannel.client = {
    cursor: "",
    async poll() {
      polls++;
      if (polls === 1) {
        return { ret: 500, msgs: [] };
      }
      online = true;
      testChannel.loopAbort.abort();
      return { ret: 0, msgs: [] };
    },
    async sendTextChunked(_toUserId, text) {
      if (!online) {
        throw new Error("offline");
      }
      sentTexts.push(text);
      return 1;
    },
    async sendTyping() {},
  };
  testChannel.activeChats = new Set(["user-1"]);
  testChannel.contextTokens = new Map([["user-1", "ctx-1"]]);
  testChannel.loopAbort = new AbortController();
  testChannel.sleep = async () => {
    testChannel.activeChats.delete("user-1");
    await testChannel.sendReply("user-1", "最终结果", { queueOnFailure: true });
  };

  await testChannel.pollLoop();

  assert.equal(sentTexts.some((text) => text.includes("微信连接暂时中断")), false);
  assert.ok(sentTexts.some((text) => text.includes("微信连接刚刚中断过，现在已恢复")));
  assert.ok(sentTexts.some((text) => text.includes("最终结果")));
});
