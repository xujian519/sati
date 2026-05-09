import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  defaultAlwaysOnConfig,
  type AlwaysOnConfig,
} from "../../src/always-on/config/parseAlwaysOnConfig.js";
import { evaluateAlwaysOnDiscoveryGates } from "../../src/always-on/runtime/DiscoveryGates.js";
import { defaultDiscoveryState } from "../../src/always-on/storage/DiscoveryStateStore.js";
import type { AlwaysOnChannelLease } from "../../src/always-on/protocol/types.js";

const projectRoot = resolve("/tmp/projects/sample");
const NOW = new Date("2026-05-08T12:00:00Z");

function buildConfig(overrides: Partial<AlwaysOnConfig> = {}): AlwaysOnConfig {
  const base = defaultAlwaysOnConfig();
  return {
    ...base,
    enabled: true,
    trigger: { ...base.trigger, enabled: true },
    projects: { [projectRoot]: { enabled: true } },
    ...overrides,
  };
}

function freshLease(overrides: Partial<AlwaysOnChannelLease> = {}): AlwaysOnChannelLease {
  return {
    schemaVersion: 1,
    channelKey: "web",
    writerId: "writer",
    projectKey: projectRoot,
    sessionKey: "session",
    writtenAt: NOW.toISOString(),
    agentBusy: false,
    lastUserMsgAt: null,
    ...overrides,
  };
}

test("disabled gate fires when alwaysOn.enabled is false", () => {
  const config = buildConfig({ enabled: false });
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state: defaultDiscoveryState(NOW),
    leases: [freshLease()],
    now: NOW,
    projectExists: true,
    lockHeld: false,
  });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "disabled");
});

test("project_disabled fires when project flag is missing", () => {
  const config = buildConfig({ projects: { [projectRoot]: { enabled: false } } });
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state: defaultDiscoveryState(NOW),
    leases: [freshLease()],
    now: NOW,
    projectExists: true,
    lockHeld: false,
  });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "project_disabled");
});

test("dormant_no_signal fires when state.dormant exists and dormancy.enabled is true", () => {
  const config = buildConfig();
  const state = {
    ...defaultDiscoveryState(NOW),
    dormant: { since: NOW.toISOString(), lastBaselineAt: NOW.toISOString() },
  };
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state,
    leases: [freshLease()],
    now: NOW,
    projectExists: true,
    lockHeld: false,
  });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "dormant_no_signal");
});

test("agent_busy fires when any lease is busy", () => {
  const config = buildConfig();
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state: defaultDiscoveryState(NOW),
    leases: [freshLease({ agentBusy: true })],
    now: NOW,
    projectExists: true,
    lockHeld: false,
  });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "agent_busy");
});

test("agent_busy is skipped when lease list is empty", () => {
  const config = buildConfig();
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state: defaultDiscoveryState(NOW),
    leases: [],
    now: NOW,
    projectExists: true,
    lockHeld: false,
  });
  assert.equal(result.ok, true);
  assert.equal((result as { ok: true; lease?: AlwaysOnChannelLease }).lease, undefined);
});

test("recent_user_msg fires when last user msg is within window", () => {
  const config = buildConfig();
  const lastMsg = new Date(NOW.getTime() - 60_000).toISOString();
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state: defaultDiscoveryState(NOW),
    leases: [freshLease({ lastUserMsgAt: lastMsg })],
    now: NOW,
    projectExists: true,
    lockHeld: false,
  });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "recent_user_msg");
});

test("recent_user_msg is skipped when lease list is empty", () => {
  const config = buildConfig();
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state: defaultDiscoveryState(NOW),
    leases: [],
    now: NOW,
    projectExists: true,
    lockHeld: false,
  });
  assert.equal(result.ok, true);
});

test("cooldown fires when last fire completed within cooldownMinutes", () => {
  const config = buildConfig();
  const state = {
    ...defaultDiscoveryState(NOW),
    lastFireCompletedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
  };
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state,
    leases: [freshLease()],
    now: NOW,
    projectExists: true,
    lockHeld: false,
  });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "cooldown");
});

test("daily_budget fires when todayRunCount has reached the budget", () => {
  const config = buildConfig({
    trigger: { ...buildConfig().trigger, dailyBudget: 2, cooldownMinutes: 0 },
  });
  const state = {
    ...defaultDiscoveryState(NOW),
    todayRunCount: 2,
  };
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state,
    leases: [freshLease()],
    now: NOW,
    projectExists: true,
    lockHeld: false,
  });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "daily_budget");
});

test("lock_busy fires after every other gate passes", () => {
  const config = buildConfig();
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state: defaultDiscoveryState(NOW),
    leases: [freshLease()],
    now: NOW,
    projectExists: true,
    lockHeld: true,
  });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "lock_busy");
});

test("ok returns the preferred-channel lease when one exists", () => {
  const config = buildConfig();
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state: defaultDiscoveryState(NOW),
    leases: [freshLease({ channelKey: "tui" }), freshLease({ channelKey: "web" })],
    now: NOW,
    projectExists: true,
    lockHeld: false,
  });
  assert.equal(result.ok, true);
  assert.equal((result as { ok: true; lease: AlwaysOnChannelLease }).lease.channelKey, "web");
});

test("ok with empty lease list when all other gates pass", () => {
  const config = buildConfig();
  const result = evaluateAlwaysOnDiscoveryGates({
    projectKey: projectRoot,
    config,
    state: defaultDiscoveryState(NOW),
    leases: [],
    now: NOW,
    projectExists: true,
    lockHeld: false,
  });
  assert.equal(result.ok, true);
  assert.equal((result as { ok: true; lease?: AlwaysOnChannelLease }).lease, undefined);
});
