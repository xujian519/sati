import test from "node:test";
import assert from "node:assert/strict";
import type { GatewayEvent, GatewaySubmitTurnInput } from "../../src/gateway/index.js";
import type { ChannelLogger } from "../../src/adapters/channel/protocol/types.js";
import {
  CHANNEL_TURN_FAILURE_TEXT,
  type ChannelTurnDeps,
  type ChannelTurnElicitationSink,
  type ChannelTurnGateway,
  type ChannelTurnPermissionSink,
  processChannelTurn,
} from "../../src/adapters/channel/protocol/ImTurnProcessor.js";

// ---------------------------------------------------------------------------
// 假件：事件源 + 交互捕获 + 投递记录
// ---------------------------------------------------------------------------

type Harness = {
  deps: ChannelTurnDeps;
  requests: GatewaySubmitTurnInput[];
  delivered: string[];
  rendered: GatewayEvent[];
  captured: Array<{ key: string; sessionKey: string; event: GatewayEvent }>;
  cleared: string[];
  order: string[];
  logged: string[];
};

/**
 * 构造被测依赖。
 *
 * `events` 按序产出；`throwAfter` 为真时在产出完毕后抛错（模拟流中断），
 * 用于验证错误兜底与轮末清理仍然执行。
 */
function harness(
  options: {
    events?: GatewayEvent[];
    throwAfter?: boolean;
    elicitText?: string | undefined;
    permissionText?: string | undefined;
    render?: (event: GatewayEvent) => string | undefined;
    connected?: boolean;
    beforeTurn?: boolean;
    errorLabel?: string;
  } = {},
): Harness {
  const requests: GatewaySubmitTurnInput[] = [];
  const delivered: string[] = [];
  const rendered: GatewayEvent[] = [];
  const captured: Array<{ key: string; sessionKey: string; event: GatewayEvent }> = [];
  const cleared: string[] = [];
  const order: string[] = [];
  const logged: string[] = [];

  const events = options.events ?? [];
  const gateway: ChannelTurnGateway = {
    async *submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
      requests.push(input);
      order.push("submitTurn");
      for (const event of events) yield event;
      if (options.throwAfter) throw new Error("stream boom");
    },
  };

  const elicitation: ChannelTurnElicitationSink = {
    capture(key, sessionKey, event) {
      captured.push({ key, sessionKey, event });
      order.push("elicit-capture");
      return options.elicitText ?? "请选择：1 允许 / 2 拒绝";
    },
    clear(key) {
      cleared.push(key);
      order.push("elicit-clear");
    },
  };

  const permissions: ChannelTurnPermissionSink = {
    capture(key, sessionKey, event) {
      captured.push({ key, sessionKey, event });
      order.push("permission-capture");
      return options.permissionText;
    },
    clear(key) {
      cleared.push(key);
      order.push("permission-clear");
    },
  };

  const logger: ChannelLogger = {
    error(message) {
      logged.push(message);
    },
  };

  const deps: ChannelTurnDeps = {
    channelKey: "sms",
    ...(options.connected === false ? {} : { gateway }),
    elicitation,
    permissions,
    render:
      options.render ??
      ((event: GatewayEvent) => {
        rendered.push(event);
        return event.type === "assistant_text_delta" ? event.text : undefined;
      }),
    deliver: text => {
      delivered.push(text);
      order.push(`deliver:${text}`);
      return Promise.resolve(true);
    },
    logger,
    ...(options.beforeTurn ? { beforeTurn: () => order.push("beforeTurn") } : {}),
    ...(options.errorLabel ? { errorLabel: options.errorLabel } : {}),
  };

  return { deps, requests, delivered, rendered, captured, cleared, order, logged };
}

const text = (value: string): GatewayEvent => ({ type: "assistant_text_delta", text: value });

const elicitationEvent: GatewayEvent = {
  type: "elicitation_request",
  requestId: "req-1",
  toolCallId: "tc-1",
  toolName: "ask_user",
  questions: [],
};

const permissionEvent: GatewayEvent = {
  type: "permission_request",
  requestId: "perm-1",
  toolName: "shell",
  payload: {},
};

// ---------------------------------------------------------------------------
// 常规轮次
// ---------------------------------------------------------------------------

test("processChannelTurn 透传 sessionKey/channelKey/message 给 submitTurn", async () => {
  const h = harness({ events: [] });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "sms:chat-1", message: "你好" });
  assert.deepEqual(h.requests, [{ sessionKey: "sms:chat-1", channelKey: "sms", message: "你好" }]);
});

test("processChannelTurn 累积渲染片段、trim 后一次性投递", async () => {
  const h = harness({ events: [text("  第一段"), text("第二段  ")] });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "s", message: "m" });
  assert.deepEqual(h.delivered, ["第一段第二段"]);
});

test("processChannelTurn 在无可见文本时不投递", async () => {
  const h = harness({ events: [text("   "), { type: "tool_call_started", toolCallId: "t1", name: "read_file" }] });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "s", message: "m" });
  assert.deepEqual(h.delivered, []);
});

test("processChannelTurn 把每个非交互事件都交给 render", async () => {
  const started: GatewayEvent = { type: "tool_call_started", toolCallId: "t1", name: "read_file" };
  const h = harness({ events: [started, text("x")] });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "s", message: "m" });
  assert.deepEqual(h.rendered, [started, text("x")]);
});

test("processChannelTurn 视 render 返回 undefined 为无片段", async () => {
  const h = harness({ events: [text("a")], render: () => undefined });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "s", message: "m" });
  assert.deepEqual(h.delivered, []);
});

// ---------------------------------------------------------------------------
// 交互请求
// ---------------------------------------------------------------------------

test("elicitation 请求：capture 带挂起键与 sessionKey，提问文本无条件投递，且不进入 render", async () => {
  const h = harness({ events: [elicitationEvent] });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "sms:chat-1", message: "m" });
  assert.deepEqual(
    h.captured.map(c => ({ key: c.key, sessionKey: c.sessionKey, same: c.event === elicitationEvent })),
    [{ key: "chat-1", sessionKey: "sms:chat-1", same: true }],
  );
  assert.deepEqual(h.delivered, ["请选择：1 允许 / 2 拒绝"]);
  assert.deepEqual(h.rendered, []);
});

test("permission 请求：capture 返回 undefined 时不投递", async () => {
  const h = harness({ events: [permissionEvent], permissionText: undefined });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "s", message: "m" });
  assert.deepEqual(
    h.captured.map(c => c.event === permissionEvent),
    [true],
  );
  assert.deepEqual(h.delivered, []);
});

test("permission 请求：capture 返回文本时投递", async () => {
  const h = harness({ events: [permissionEvent], permissionText: "回复 1 允许一次" });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "s", message: "m" });
  assert.deepEqual(h.delivered, ["回复 1 允许一次"]);
});

test("挂起键与回复目标解耦：capture/clear 用 interactionKey，投递由 deliver 决定", async () => {
  const h = harness({ events: [elicitationEvent, text("正文")] });
  await processChannelTurn(h.deps, { interactionKey: "group:g1:ctx-9", sessionKey: "s", message: "m" });
  assert.deepEqual(h.cleared, ["group:g1:ctx-9", "group:g1:ctx-9"]);
  assert.deepEqual(h.delivered, ["请选择：1 允许 / 2 拒绝", "正文"]);
});

// ---------------------------------------------------------------------------
// 守卫、顺序与错误
// ---------------------------------------------------------------------------

test("未连接 gateway 时整轮跳过：不调 beforeTurn、不碰交互状态、不投递", async () => {
  const h = harness({ connected: false, beforeTurn: true, events: [text("x")] });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "s", message: "m" });
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.delivered, []);
  assert.deepEqual(h.captured, []);
  assert.deepEqual(h.cleared, []);
  assert.deepEqual(h.order, []);
});

test("beforeTurn 在 submitTurn 之前触发", async () => {
  const h = harness({ beforeTurn: true, events: [] });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "s", message: "m" });
  assert.ok(h.order.indexOf("beforeTurn") < h.order.indexOf("submitTurn"), h.order.join(" → "));
});

test("流中断：错误日志带渠道前缀、兜底文案替换已累积文本、轮末仍清理挂起状态", async () => {
  const h = harness({ events: [text("半截")], throwAfter: true });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "s", message: "m" });
  assert.deepEqual(h.logged, ["sms: submitTurn error: Error: stream boom"]);
  assert.deepEqual(h.delivered, [CHANNEL_TURN_FAILURE_TEXT]);
  assert.deepEqual(h.cleared, ["chat-1", "chat-1"]);
});

test("errorLabel 覆盖错误日志前缀（同渠道多条循环时区分来源）", async () => {
  const h = harness({ events: [], throwAfter: true, errorLabel: "qq: submitTurn error (c2c)" });
  await processChannelTurn(h.deps, { interactionKey: "c2c:u1", sessionKey: "s", message: "m" });
  assert.deepEqual(h.logged, ["qq: submitTurn error (c2c): Error: stream boom"]);
});

test("清理挂起状态发生在最终投递之前", async () => {
  const h = harness({ events: [text("正文")] });
  await processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "s", message: "m" });
  assert.deepEqual(h.order, ["submitTurn", "elicit-clear", "permission-clear", "deliver:正文"]);
});

test("投递被 await：上一次投递完成后才继续下一个事件", async () => {
  const h = harness({ events: [elicitationEvent, permissionEvent], permissionText: "允许？" });
  const gate: Array<() => void> = [];
  h.deps.deliver = text => {
    h.delivered.push(text);
    h.order.push(`deliver:${text}`);
    return new Promise<void>(resolve => gate.push(resolve));
  };
  const turn = processChannelTurn(h.deps, { interactionKey: "chat-1", sessionKey: "s", message: "m" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.delivered, ["请选择：1 允许 / 2 拒绝"]);
  gate.shift()?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.delivered, ["请选择：1 允许 / 2 拒绝", "允许？"]);
  gate.shift()?.();
  await turn;
});
