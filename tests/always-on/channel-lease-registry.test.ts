import assert from "node:assert/strict";
import test from "node:test";
import { ChannelLeaseRegistry } from "../../src/always-on/runtime/ChannelLeaseRegistry.js";

const project = "/tmp/projects/sample";

test("ChannelLeaseRegistry.set creates and overwrites lease entries", () => {
  const now = new Date("2026-05-08T12:00:00Z");
  const registry = new ChannelLeaseRegistry(() => now);
  registry.set({
    channelKey: "web",
    writerId: "writer-1",
    projectKey: project,
    sessionKey: "session-1",
    agentBusy: false,
  });
  registry.set({
    channelKey: "web",
    writerId: "writer-1",
    projectKey: project,
    sessionKey: "session-1",
    agentBusy: true,
  });
  const leases = registry.list();
  assert.equal(leases.length, 1);
  assert.equal(leases[0].agentBusy, true);
});

test("ChannelLeaseRegistry.listFresh filters by project and stale window", () => {
  const now = new Date("2026-05-08T12:00:00Z");
  const registry = new ChannelLeaseRegistry(() => now);
  registry.set({
    channelKey: "web",
    writerId: "writer-1",
    projectKey: project,
    sessionKey: "session-1",
    agentBusy: false,
    writtenAt: new Date(now.getTime() - 60_000).toISOString(),
  });
  registry.set({
    channelKey: "tui",
    writerId: "writer-2",
    projectKey: project,
    sessionKey: "session-2",
    agentBusy: false,
    writtenAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
  });
  registry.set({
    channelKey: "web",
    writerId: "writer-3",
    projectKey: "/tmp/other",
    sessionKey: "session-3",
    agentBusy: false,
  });

  const fresh = registry.listFresh({ projectKey: project, staleSeconds: 90, now });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].channelKey, "web");
});

test("ChannelLeaseRegistry.markBusy / markIdle update lease state", () => {
  const now = new Date("2026-05-08T12:00:00Z");
  const registry = new ChannelLeaseRegistry(() => now);
  registry.set({
    channelKey: "web",
    writerId: "writer-1",
    projectKey: project,
    sessionKey: "session-1",
    agentBusy: false,
  });

  registry.markBusy({ projectKey: project, channelKey: "web", writerId: "writer-1" });
  assert.equal(registry.list()[0].agentBusy, true);

  registry.markIdle({ projectKey: project, channelKey: "web", writerId: "writer-1" });
  const lease = registry.list()[0];
  assert.equal(lease.agentBusy, false);
  assert.equal(lease.lastUserMsgAt, now.toISOString());
});
