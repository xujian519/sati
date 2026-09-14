import test from "node:test";
import assert from "node:assert/strict";
import type { Gateway } from "../../src/gateway/index.js";
import type { ChannelLogger } from "../../src/adapters/channel/protocol/types.js";
import {
  type ChannelDispatchDeps,
  type ChannelDispatchInteraction,
  dispatchChannelMessage,
} from "../../src/adapters/channel/protocol/ImInboundDispatch.js";

// ---------------------------------------------------------------------------
// 假件
// ---------------------------------------------------------------------------

type Mapped = { command?: "new"; message: string; sessionKey: string };

/** answer/hasPending 只把 gateway 透传给被测方，测试里用不透明替身即可。 */
const gateway = { __fake: "gateway" } as unknown as Gateway;

type Harness = {
  deps: ChannelDispatchDeps<Mapped>;
  activeChats: Set<string>;
  answered: Array<{ key: string; text: string; gateway: Gateway }>;
  sent: Array<{ key: string; text: string }>;
  turns: Mapped[];
  resolved: Array<{ chatId: string; text: string }>;
  logged: string[];
  order: string[];
};

function harness(
  options: {
    connected?: boolean;
    elicitPending?: boolean;
    permissionPending?: boolean;
    elicitConfirmation?: string | undefined;
    permissionConfirmation?: string | undefined;
    answerThrows?: boolean;
    mapped?: Mapped;
    turnThrows?: boolean;
    resolveThrows?: boolean;
    activeChats?: string[];
  } = {},
): Harness {
  const answered: Harness["answered"] = [];
  const sent: Harness["sent"] = [];
  const turns: Mapped[] = [];
  const resolved: Harness["resolved"] = [];
  const logged: string[] = [];
  const order: string[] = [];
  const activeChats = new Set(options.activeChats ?? []);

  const interaction = (
    label: string,
    pending: boolean,
    confirmation: string | undefined,
  ): ChannelDispatchInteraction => ({
    hasPending(key) {
      order.push(`${label}-hasPending:${key}`);
      return pending;
    },
    answer(key, text, gw) {
      order.push(`${label}-answer`);
      answered.push({ key, text, gateway: gw });
      if (options.answerThrows) return Promise.reject(new Error(`${label} boom`));
      return Promise.resolve(confirmation);
    },
  });

  const logger: ChannelLogger = {
    info: message => logged.push(`info:${message}`),
    error: message => logged.push(`error:${message}`),
  };

  const deps: ChannelDispatchDeps<Mapped> = {
    channelKey: "sms",
    ...(options.connected === false ? {} : { gateway }),
    elicitation: interaction("elicit", options.elicitPending ?? false, options.elicitConfirmation),
    permissions: interaction("permission", options.permissionPending ?? false, options.permissionConfirmation),
    activeChats,
    mapper: {
      resolve(input) {
        order.push(`resolve:${input.chatId}`);
        resolved.push(input);
        if (options.resolveThrows) throw new Error("resolve boom");
        return options.mapped ?? { message: input.text, sessionKey: `sms:${input.chatId}` };
      },
    },
    send: (key, text) => {
      order.push(`send:${key}`);
      sent.push({ key, text });
      return Promise.resolve(true);
    },
    turn: mapped => {
      order.push("turn");
      turns.push(mapped);
      if (options.turnThrows) return Promise.reject(new Error("turn boom"));
      return Promise.resolve();
    },
    logger,
  };

  return { deps, activeChats, answered, sent, turns, resolved, logged, order };
}

// ---------------------------------------------------------------------------
// 交互应答优先
// ---------------------------------------------------------------------------

test("elicitation 挂起：应答后投递确认并结束该条消息（不进轮次）", async () => {
  const h = harness({ elicitPending: true, elicitConfirmation: "已选择 1" });
  await dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "1" });
  assert.deepEqual(h.answered, [{ key: "chat-1", text: "1", gateway }]);
  assert.deepEqual(h.sent, [{ key: "chat-1", text: "已选择 1" }]);
  assert.deepEqual(h.turns, []);
  assert.deepEqual(h.resolved, []);
  assert.equal(h.activeChats.size, 0);
});

test("permission 挂起：同 elicitation，应答后不进轮次", async () => {
  const h = harness({ permissionPending: true, permissionConfirmation: "回复 1 允许一次" });
  await dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "1" });
  assert.deepEqual(h.answered, [{ key: "chat-1", text: "1", gateway }]);
  assert.deepEqual(h.sent, [{ key: "chat-1", text: "回复 1 允许一次" }]);
  assert.deepEqual(h.turns, []);
});

test("elicitation 与 permission 同时挂起时只走 elicitation", async () => {
  const h = harness({ elicitPending: true, permissionPending: true, elicitConfirmation: "确认 elicitation" });
  await dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "1" });
  assert.deepEqual(h.answered.length, 1);
  assert.ok(h.order.some(l => l.startsWith("elicit-answer")));
  assert.ok(!h.order.some(l => l.startsWith("permission-")));
});

test("应答返回 undefined 时不投递，但仍结束该条消息", async () => {
  const h = harness({ elicitPending: true, elicitConfirmation: undefined });
  await dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "1" });
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.turns, []);
});

test("应答抛错：记录渠道前缀日志、不投递、不进入轮次", async () => {
  const h = harness({ elicitPending: true, answerThrows: true });
  await dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "1" });
  assert.deepEqual(h.logged, ["error:sms: elicitation answer error: Error: elicit boom"]);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.turns, []);
});

test("未连接 gateway：交互守卫短路（不应答），消息继续走轮次", async () => {
  const h = harness({ connected: false, elicitPending: true });
  await dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "1" });
  assert.deepEqual(h.answered, []);
  assert.deepEqual(
    h.turns.map(t => t.sessionKey),
    ["sms:chat-1"],
  );
});

// ---------------------------------------------------------------------------
// 去重与命令解析
// ---------------------------------------------------------------------------

test("会话在跑：记 info 日志并丢弃该条消息（不解析、不进轮次）", async () => {
  const h = harness({ activeChats: ["chat-1"] });
  await dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "你好" });
  assert.deepEqual(h.logged, ["info:sms: chat chat-1 already active, skipping"]);
  assert.deepEqual(h.resolved, []);
  assert.deepEqual(h.turns, []);
});

test("/new 无正文：由 resolveIncomingMessage 回执，不进轮次", async () => {
  const h = harness({ mapped: { command: "new", message: "", sessionKey: "sms:chat-1" } });
  await dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "/new" });
  assert.deepEqual(h.sent, [{ key: "chat-1", text: "已创建新会话。" }]);
  assert.deepEqual(h.turns, []);
  assert.equal(h.activeChats.size, 0);
});

test("空正文：直接吞掉（无回执、不进轮次）", async () => {
  const h = harness({ mapped: { message: "", sessionKey: "sms:chat-1" } });
  await dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "   " });
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.turns, []);
});

// ---------------------------------------------------------------------------
// 轮次执行
// ---------------------------------------------------------------------------

test("正常消息：mapper 收到 (chatId, text)，轮次在 activeChats 包围下执行", async () => {
  const h = harness();
  let seenDuringTurn: string[] = [];
  h.deps.turn = mapped => {
    seenDuringTurn = [...h.activeChats];
    h.turns.push(mapped);
    return Promise.resolve();
  };
  await dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "你好" });
  assert.deepEqual(h.resolved, [{ chatId: "chat-1", text: "你好" }]);
  assert.deepEqual(seenDuringTurn, ["chat-1"]);
  assert.equal(h.activeChats.size, 0);
});

test("轮次抛错：标记仍被清除，错误向上抛出", async () => {
  const h = harness({ turnThrows: true });
  await assert.rejects(() => dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "你好" }), /turn boom/);
  assert.equal(h.activeChats.size, 0);
});

test("mapper 解析抛错时不落标记（add 在解析之后）", async () => {
  const h = harness({ resolveThrows: true });
  await assert.rejects(
    () => dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "你好" }),
    /resolve boom/,
  );
  assert.equal(h.activeChats.size, 0);
});

test("交互键与投递目标解耦：去重、解析、应答键都用 interactionKey", async () => {
  const h = harness({ elicitPending: true, elicitConfirmation: "确认" });
  const targets: string[] = [];
  h.deps.send = (key, text) => {
    targets.push(key);
    h.sent.push({ key, text });
    return Promise.resolve(true);
  };
  await dispatchChannelMessage(h.deps, { interactionKey: "group:g1:thread-9", text: "1" });
  assert.deepEqual(
    h.answered.map(a => a.key),
    ["group:g1:thread-9"],
  );
  assert.deepEqual(targets, ["group:g1:thread-9"]);
});

test("channelKey 同时用于日志前缀与错误分类", async () => {
  const h = harness({ elicitPending: true, answerThrows: true, activeChats: ["chat-1"] });
  h.deps.channelKey = "wecom_callback";
  await dispatchChannelMessage(h.deps, { interactionKey: "chat-1", text: "1" });
  assert.deepEqual(h.logged, ["error:wecom_callback: elicitation answer error: Error: elicit boom"]);
});
