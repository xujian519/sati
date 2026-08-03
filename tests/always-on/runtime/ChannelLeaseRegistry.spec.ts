import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChannelLeaseRegistry } from "../../../src/always-on/runtime/ChannelLeaseRegistry.js";

const NOW = new Date("2026-08-03T10:00:00Z");
const LATER = new Date("2026-08-03T10:05:00Z");

function makeRegistry(now: () => Date = () => NOW): ChannelLeaseRegistry {
  return new ChannelLeaseRegistry(now);
}

describe("ChannelLeaseRegistry", () => {
  it("set 写入 lease 并填充 schemaVersion / writtenAt", () => {
    const registry = makeRegistry();
    const lease = registry.set({
      channelKey: "web",
      writerId: "w1",
      projectKey: "proj",
      sessionKey: "s1",
      agentBusy: false,
    });
    assert.equal(lease.schemaVersion, 1);
    assert.equal(lease.writtenAt, NOW.toISOString());
    assert.equal(lease.lastUserMsgAt, null);
    assert.equal(registry.list().length, 1);
  });

  it("同 project+channel+writer 的 set 覆盖旧 lease", () => {
    const registry = makeRegistry();
    registry.set({ channelKey: "web", writerId: "w1", projectKey: "proj", sessionKey: "s1", agentBusy: false });
    registry.set({ channelKey: "web", writerId: "w1", projectKey: "proj", sessionKey: "s2", agentBusy: true });
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0]!.sessionKey, "s2");
  });

  it("markBusy 更新 agentBusy 与 writtenAt", () => {
    const registry = makeRegistry(() => LATER);
    registry.set({ channelKey: "web", writerId: "w1", projectKey: "proj", sessionKey: "s1", agentBusy: false });
    registry.markBusy({ projectKey: "proj", channelKey: "web", writerId: "w1" });
    const lease = registry.list()[0]!;
    assert.equal(lease.agentBusy, true);
    assert.equal(lease.writtenAt, LATER.toISOString());
  });

  it("markIdle 更新 agentBusy=false 并记录 lastUserMsgAt", () => {
    const registry = makeRegistry(() => LATER);
    registry.set({ channelKey: "web", writerId: "w1", projectKey: "proj", sessionKey: "s1", agentBusy: true });
    registry.markIdle({ projectKey: "proj", channelKey: "web", writerId: "w1" });
    const lease = registry.list()[0]!;
    assert.equal(lease.agentBusy, false);
    assert.equal(lease.lastUserMsgAt, LATER.toISOString());
  });

  it("markBusy / markIdle 对不存在的 lease 是 no-op", () => {
    const registry = makeRegistry();
    assert.doesNotThrow(() => registry.markBusy({ projectKey: "proj", channelKey: "web", writerId: "missing" }));
    assert.equal(registry.list().length, 0);
  });

  it("listFresh 只返回指定 project 且未过期的 lease", () => {
    const registry = makeRegistry();
    registry.set({ channelKey: "web", writerId: "w1", projectKey: "proj", sessionKey: "s1", agentBusy: false });
    registry.set({ channelKey: "feishu", writerId: "w2", projectKey: "other", sessionKey: "s2", agentBusy: false });
    registry.set({
      channelKey: "qq",
      writerId: "w3",
      projectKey: "proj",
      sessionKey: "s3",
      agentBusy: false,
      writtenAt: "2026-08-01T00:00:00Z",
    });

    const fresh = registry.listFresh({ projectKey: "proj", staleSeconds: 3600, now: NOW });
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0]!.channelKey, "web");
  });

  it("remove 删除指定 lease", () => {
    const registry = makeRegistry();
    registry.set({ channelKey: "web", writerId: "w1", projectKey: "proj", sessionKey: "s1", agentBusy: false });
    registry.remove({ projectKey: "proj", channelKey: "web", writerId: "w1" });
    assert.equal(registry.list().length, 0);
  });

  it("removeByWriter 删除该 writer 的所有 lease", () => {
    const registry = makeRegistry();
    registry.set({ channelKey: "web", writerId: "w1", projectKey: "proj", sessionKey: "s1", agentBusy: false });
    registry.set({ channelKey: "feishu", writerId: "w1", projectKey: "proj", sessionKey: "s2", agentBusy: false });
    registry.set({ channelKey: "qq", writerId: "w2", projectKey: "proj", sessionKey: "s3", agentBusy: false });
    registry.removeByWriter("w1");
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0]!.writerId, "w2");
  });
});
