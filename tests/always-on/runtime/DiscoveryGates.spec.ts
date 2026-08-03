import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultAlwaysOnConfig } from "../../../src/always-on/config/parseAlwaysOnConfig.js";
import type { AlwaysOnChannelLease, AlwaysOnDiscoveryState } from "../../../src/always-on/protocol/types.js";
import type { DiscoveryGateInput } from "../../../src/always-on/runtime/DiscoveryGates.js";
import { evaluateAlwaysOnDiscoveryGates } from "../../../src/always-on/runtime/DiscoveryGates.js";

const NOW = new Date("2026-08-03T10:00:00Z");

function makeConfig(): ReturnType<typeof defaultAlwaysOnConfig> {
  const base = defaultAlwaysOnConfig();
  return {
    ...base,
    enabled: true,
    trigger: {
      ...base.trigger,
      enabled: true,
      cooldownMinutes: 60,
      dailyBudget: 4,
      recentUserMsgMinutes: 5,
      preferChannel: "web",
    },
    projects: { proj: { enabled: true } },
  };
}

function makeState(overrides: Partial<AlwaysOnDiscoveryState> = {}): AlwaysOnDiscoveryState {
  return {
    schemaVersion: 1,
    todayKey: "2026-08-03",
    todayRunCount: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function makeLease(overrides: Partial<AlwaysOnChannelLease> = {}): AlwaysOnChannelLease {
  return {
    schemaVersion: 1,
    channelKey: "web",
    writerId: "w1",
    projectKey: "proj",
    sessionKey: "s1",
    writtenAt: NOW.toISOString(),
    agentBusy: false,
    lastUserMsgAt: null,
    ...overrides,
  };
}

function evaluate(overrides: Partial<DiscoveryGateInput> = {}): ReturnType<typeof evaluateAlwaysOnDiscoveryGates> {
  return evaluateAlwaysOnDiscoveryGates({
    projectKey: "proj",
    config: makeConfig(),
    state: makeState(),
    leases: [],
    now: NOW,
    projectExists: true,
    lockHeld: false,
    ...overrides,
  });
}

describe("evaluateAlwaysOnDiscoveryGates", () => {
  it("全局禁用 → disabled", () => {
    const config = { ...makeConfig(), enabled: false };
    assert.deepEqual(evaluate({ config }), { ok: false, reason: "disabled" });
  });

  it("trigger 禁用 → disabled", () => {
    const config = { ...makeConfig(), trigger: { ...makeConfig().trigger, enabled: false } };
    assert.deepEqual(evaluate({ config }), { ok: false, reason: "disabled" });
  });

  it("project 未配置 → project_disabled", () => {
    const config = { ...makeConfig(), projects: {} };
    assert.deepEqual(evaluate({ config }), { ok: false, reason: "project_disabled" });
  });

  it("project 被禁用 → project_disabled", () => {
    const config = { ...makeConfig(), projects: { proj: { enabled: false } } };
    assert.deepEqual(evaluate({ config }), { ok: false, reason: "project_disabled" });
  });

  it("项目目录不存在 → project_missing", () => {
    assert.deepEqual(evaluate({ projectExists: false }), { ok: false, reason: "project_missing" });
  });

  it("休眠态 → dormant_no_signal", () => {
    const state = makeState({ dormant: { since: "2026-08-01T00:00:00Z", lastBaselineAt: "2026-08-01T00:00:00Z" } });
    assert.deepEqual(evaluate({ state }), { ok: false, reason: "dormant_no_signal" });
  });

  it("会话执行中 → agent_busy", () => {
    assert.deepEqual(evaluate({ sessionInFlight: true }), { ok: false, reason: "agent_busy" });
  });

  it("存在忙碌 lease → agent_busy", () => {
    const leases = [makeLease({ agentBusy: true })];
    assert.deepEqual(evaluate({ leases }), { ok: false, reason: "agent_busy" });
  });

  it("近期用户消息 → recent_user_msg", () => {
    const leases = [makeLease({ lastUserMsgAt: new Date(NOW.getTime() - 60_000).toISOString() })];
    assert.deepEqual(evaluate({ leases }), { ok: false, reason: "recent_user_msg" });
  });

  it("冷却期内 → cooldown", () => {
    const state = makeState({ lastFireCompletedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() });
    assert.deepEqual(evaluate({ state }), { ok: false, reason: "cooldown" });
  });

  it("今日预算用尽 → daily_budget", () => {
    const state = makeState({ todayRunCount: 4 });
    assert.deepEqual(evaluate({ state }), { ok: false, reason: "daily_budget" });
  });

  it("工作区锁被占用 → lock_busy", () => {
    assert.deepEqual(evaluate({ lockHeld: true }), { ok: false, reason: "lock_busy" });
  });

  it("全部通过且无 lease → ok，无目标 lease", () => {
    assert.deepEqual(evaluate(), { ok: true, lease: undefined });
  });

  it("全部通过时优先 preferChannel 对应的 lease", () => {
    const leases = [
      makeLease({ channelKey: "feishu", writerId: "w2", projectKey: "proj" }),
      makeLease({ channelKey: "web", writerId: "w1", projectKey: "proj" }),
    ];
    const result = evaluate({ leases });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.lease?.channelKey, "web");
    }
  });

  it("gate 顺序：agent_busy 优先于 recent_user_msg（忙碌先判）", () => {
    const leases = [makeLease({ agentBusy: true, lastUserMsgAt: NOW.toISOString() })];
    assert.deepEqual(evaluate({ leases }), { ok: false, reason: "agent_busy" });
  });

  it("仅统计当前 project 的 lease（其他 project 的 lease 不阻塞）", () => {
    const leases = [makeLease({ projectKey: "other", agentBusy: true })];
    assert.deepEqual(evaluate({ leases }), { ok: true, lease: undefined });
  });
});
