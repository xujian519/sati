import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ChannelStatePersistence } from "../../src/adapters/channel/protocol/ChannelStatePersistence.js";

describe("ChannelStatePersistence", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "channel-state-test-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("load returns undefined for non-existent state", async () => {
    const persistence = new ChannelStatePersistence({ stateDir });
    const result = await persistence.load("wecom");
    assert.equal(result, undefined);
  });

  it("flush writes pending state to disk", async () => {
    const persistence = new ChannelStatePersistence({ stateDir, debounceMs: 60000 });
    const state = { activeByChatId: { "user1": "wecom:dm=user1:s_abc" }, projectByScopeKey: {} };

    persistence.save("wecom", state);
    await persistence.flush();

    const raw = await readFile(join(stateDir, "wecom.state.json"), "utf8");
    const loaded = JSON.parse(raw);
    assert.deepEqual(loaded, state);
  });

  it("load reads previously flushed state", async () => {
    const persistence = new ChannelStatePersistence({ stateDir, debounceMs: 60000 });
    const state = {
      activeByChatId: { "chat1": "feishu:chat=chat1:s_xyz" },
      projectByChatId: { "chat1": "/home/user/project" },
    };

    persistence.save("feishu", state);
    await persistence.flush();

    const loaded = await persistence.load<typeof state>("feishu");
    assert.deepEqual(loaded, state);
  });

  it("debounced save writes after delay", async () => {
    const persistence = new ChannelStatePersistence({ stateDir, debounceMs: 50 });
    const state = { activeByChatId: { "u1": "telegram:chat=u1:general" } };

    persistence.save("telegram", state);

    const immediate = await persistence.load("telegram");
    assert.equal(immediate, undefined);

    await new Promise((resolve) => setTimeout(resolve, 120));

    const afterDelay = await persistence.load<typeof state>("telegram");
    assert.deepEqual(afterDelay, state);
  });

  it("multiple saves within debounce window only write the last state", async () => {
    const persistence = new ChannelStatePersistence({ stateDir, debounceMs: 80 });

    persistence.save("wecom", { activeByChatId: { "u1": "session-1" } });
    persistence.save("wecom", { activeByChatId: { "u1": "session-2" } });
    persistence.save("wecom", { activeByChatId: { "u1": "session-3" } });

    await persistence.flush();

    const loaded = await persistence.load<{ activeByChatId: Record<string, string> }>("wecom");
    assert.deepEqual(loaded, { activeByChatId: { "u1": "session-3" } });
  });

  it("flush clears pending timers and writes all dirty channels", async () => {
    const persistence = new ChannelStatePersistence({ stateDir, debounceMs: 60000 });

    persistence.save("feishu", { activeByChatId: { "c1": "s1" } });
    persistence.save("wecom", { activeByChatId: { "c2": "s2" } });

    await persistence.flush();

    const files = await readdir(stateDir);
    assert.ok(files.includes("feishu.state.json"));
    assert.ok(files.includes("wecom.state.json"));
  });

  it("atomic write does not leave temp files on success", async () => {
    const persistence = new ChannelStatePersistence({ stateDir, debounceMs: 0 });

    persistence.save("weixin", { activeByChatId: {} });
    await persistence.flush();

    const files = await readdir(stateDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    assert.equal(tmpFiles.length, 0);
    assert.ok(files.includes("weixin.state.json"));
  });

  it("creates stateDir if it does not exist", async () => {
    const nestedDir = join(stateDir, "nested", "deep");
    const persistence = new ChannelStatePersistence({ stateDir: nestedDir, debounceMs: 0 });

    persistence.save("slack", { activeByChatId: {} });
    await persistence.flush();

    const loaded = await persistence.load<{ activeByChatId: Record<string, string> }>("slack");
    assert.deepEqual(loaded, { activeByChatId: {} });
  });
});
