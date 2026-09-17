import test from "node:test";
import assert from "node:assert/strict";
import type { ChannelAdapter } from "../../src/adapters/channel/protocol/ChannelAdapter.js";
import { ChatSessionMapper } from "../../src/adapters/channel/protocol/ChatSessionMapper.js";
import { BlueBubblesChannel } from "../../src/adapters/channel/bluebubbles/BlueBubblesChannel.js";
import { DingTalkChannel } from "../../src/adapters/channel/dingtalk/DingTalkChannel.js";
import { DiscordChannel } from "../../src/adapters/channel/discord/DiscordChannel.js";
import { EmailChannel } from "../../src/adapters/channel/email/EmailChannel.js";
import { HomeAssistantChannel } from "../../src/adapters/channel/homeassistant/HomeAssistantChannel.js";
import { MatrixChannel } from "../../src/adapters/channel/matrix/MatrixChannel.js";
import { MattermostChannel } from "../../src/adapters/channel/mattermost/MattermostChannel.js";
import { SignalChannel } from "../../src/adapters/channel/signal/SignalChannel.js";
import { SlackChannel } from "../../src/adapters/channel/slack/SlackChannel.js";
import { SmsChannel } from "../../src/adapters/channel/sms/SmsChannel.js";
import { TelegramChannel } from "../../src/adapters/channel/telegram/TelegramChannel.js";
import { WebhookChannel } from "../../src/adapters/channel/webhook/WebhookChannel.js";
import { WhatsAppChannel } from "../../src/adapters/channel/whatsapp/WhatsAppChannel.js";

/**
 * 渠道默认会话映射器的接线判据 + 共享 `ChatSessionMapper` 语义。
 *
 * 背景：13 个渠道的 `*SessionMapper.ts`（归一化后逐字相同的 10 行薄壳）已收敛掉，
 * 渠道改为直接 `new ChatSessionMapper("<渠道键>")`（见
 * `docs/notes/implemented/2026-09-17-adapters-session-mapper-shells.md`）。
 * 自此「渠道会话命名空间」不再由具名类承载，**唯一还会错的地方就是那个字符串**：
 * 写错会让会话键前缀与渠道自身的 `channelKey` 漂移（同一个 chat 在 `/new` 前后落到
 * 不同命名空间、恢复出来的活跃映射对不上），且不会有任何编译期错误。本 spec 是这条
 * 接线的唯一判据。
 */

/** 渠道私有的默认 mapper 与自身渠道键：接线判据观测的就是这两个字段。 */
function wiringOf(channel: ChannelAdapter): { mapper: ChatSessionMapper; channelKey: string } {
  return channel as unknown as { mapper: ChatSessionMapper; channelKey: string };
}

/**
 * 「薄壳渠道」→ 会话命名空间。第二列是**登记值**：会话键会落进渠道状态文件
 * （`activeByChatId`），改名即兼容性变更，必须在此同步登记。第一列的构造会走到渠道
 * 的默认 mapper 分支（不注入 `options.mapper`），这正是要验的那条接线。
 */
const SHELL_CHANNEL_NAMESPACES: readonly (readonly [string, () => ChannelAdapter])[] = [
  ["bluebubbles", () => new BlueBubblesChannel()],
  ["dingtalk", () => new DingTalkChannel()],
  ["discord", () => new DiscordChannel()],
  ["email", () => new EmailChannel()],
  ["homeassistant", () => new HomeAssistantChannel()],
  ["matrix", () => new MatrixChannel()],
  ["mattermost", () => new MattermostChannel()],
  ["signal", () => new SignalChannel()],
  ["slack", () => new SlackChannel()],
  ["sms", () => new SmsChannel()],
  ["telegram", () => new TelegramChannel()],
  ["webhook", () => new WebhookChannel()],
  ["whatsapp", () => new WhatsAppChannel()],
];

test("接线判据覆盖 13 个渠道且命名空间互不相同（集合护栏，防止判据侧被清空后恒真）", () => {
  assert.equal(SHELL_CHANNEL_NAMESPACES.length, 13);
  assert.equal(new Set(SHELL_CHANNEL_NAMESPACES.map(([ns]) => ns)).size, 13);
});

for (const [namespace, make] of SHELL_CHANNEL_NAMESPACES) {
  test(`${namespace}：默认 mapper 的会话命名空间与渠道自身 channelKey 一致`, () => {
    const { mapper, channelKey } = wiringOf(make());
    assert.equal(channelKey, namespace);

    // 空闲态：无活跃会话时会话键直接暴露 mapper 的渠道键。
    assert.equal(mapper.resolve({ chatId: "chat-1", text: "hi" }).sessionKey, `${namespace}:chat=chat-1:general`);

    // `/new`：同一命名空间下开新会话（uuid 段只断言形状）。
    const created = mapper.resolve({ chatId: "chat-1", text: "/new" });
    assert.equal(created.command, "new");
    assert.match(created.sessionKey, new RegExp(`^${namespace}:chat=chat-1:s_[0-9a-f-]{36}$`));
  });
}

test("ChatSessionMapper：/new 建立会话，后续消息复用同一 sessionKey", () => {
  const mapper = new ChatSessionMapper("slack", undefined, () => "uuid-1");
  assert.deepEqual(mapper.resolve({ chatId: "c1", text: "/new" }), {
    sessionKey: "slack:chat=c1:s_uuid-1",
    command: "new",
    message: "",
  });
  assert.equal(mapper.resolve({ chatId: "c1", text: "hi" }).sessionKey, "slack:chat=c1:s_uuid-1");
});

test("ChatSessionMapper：/new 后带正文时正文经 message 回传（判断与提取合一）", () => {
  const mapper = new ChatSessionMapper("slack", undefined, () => "uuid-2");
  assert.deepEqual(mapper.resolve({ chatId: "c1", text: "/new 你好" }), {
    sessionKey: "slack:chat=c1:s_uuid-2",
    command: "new",
    message: "你好",
  });
});

test("ChatSessionMapper：状态按实例隔离（各渠道各自的默认实例互不共享）", () => {
  const a = new ChatSessionMapper("a", undefined, () => "u");
  const b = new ChatSessionMapper("b", undefined, () => "u");
  a.resolve({ chatId: "c1", text: "/new" });
  assert.equal(a.snapshot().activeByChatId.c1, "a:chat=c1:s_u");
  assert.deepEqual(b.snapshot(), { activeByChatId: {} });
});

test("ChatSessionMapper：snapshot 是副本，改动不影响内部状态", () => {
  const mapper = new ChatSessionMapper("slack", undefined, () => "u");
  mapper.resolve({ chatId: "c1", text: "/new" });
  const snapshot = mapper.snapshot();
  snapshot.activeByChatId.c1 = "tampered";
  assert.equal(mapper.resolve({ chatId: "c1", text: "hi" }).sessionKey, "slack:chat=c1:s_u");
});
