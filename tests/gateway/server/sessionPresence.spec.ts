import assert from "node:assert/strict";
import test from "node:test";
import { SessionPresence, SESSION_PRESENCE_GRACE_MS } from "../../../src/gateway/server/sessionPresence.js";

test("SessionPresence：unknown 会话视为在线（容错默认）", () => {
  const p = new SessionPresence();
  assert.equal(p.isActive("cap-1", 0), true);
});

test("SessionPresence：连接活跃 → 在线；断开超宽限窗 → 离线", () => {
  const p = new SessionPresence();
  const now = 1_000_000;
  p.touch("cap-1", now);
  assert.equal(p.isActive("cap-1", now), true);
  p.close("cap-1", now);
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS - 1), true, "宽限窗内仍在线");
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS), false, "超宽限窗离线");
});

test("SessionPresence：重连 touch 复位离线判定", () => {
  const p = new SessionPresence();
  const now = 1_000_000;
  p.touch("cap-1", now);
  p.close("cap-1", now);
  p.touch("cap-1", now + SESSION_PRESENCE_GRACE_MS * 2);
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS * 2), true);
});

test("SessionPresence：activeSessions 快照（超窗剔除）与 clear 清空", () => {
  const p = new SessionPresence();
  const now = 1_000_000;
  p.touch("cap-1", now);
  p.touch("cap-2", now);
  p.close("cap-2", now);
  assert.deepEqual(p.activeSessions(now + SESSION_PRESENCE_GRACE_MS * 2), ["cap-1"]);
  p.clear();
  assert.deepEqual(p.activeSessions(now + SESSION_PRESENCE_GRACE_MS * 2), []);
});

test("SessionPresence：unknown key 直接 close → 宽限窗内在线，超窗离线", () => {
  const p = new SessionPresence();
  const now = 1_000_000;
  p.close("cap-1", now);
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS - 1), true);
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS), false);
});

test("SessionPresence：重复 close 幂等，超窗判定以首次 close 计", () => {
  const p = new SessionPresence();
  const now = 1_000_000;
  p.touch("cap-1", now);
  p.close("cap-1", now);
  p.close("cap-1", now + SESSION_PRESENCE_GRACE_MS / 2);
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS), false);
});

test("SessionPresence：activeSessions 含宽限窗内关闭会话，超窗剔除", () => {
  const p = new SessionPresence();
  const now = 1_000_000;
  p.touch("cap-1", now);
  p.touch("cap-2", now);
  p.close("cap-1", now);
  assert.deepEqual(p.activeSessions(now + SESSION_PRESENCE_GRACE_MS / 2), ["cap-1", "cap-2"]);
  assert.deepEqual(p.activeSessions(now + SESSION_PRESENCE_GRACE_MS), ["cap-2"]);
});

test("SessionPresence：known-offline 持续，超窗离线后再次查询仍离线（防振荡回归）", () => {
  const p = new SessionPresence();
  const now = 1_000_000;
  p.touch("cap-1", now);
  p.close("cap-1", now);
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS), false);
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS * 2), false, "known-offline 持久，不翻回在线");
  p.touch("cap-1", now + SESSION_PRESENCE_GRACE_MS * 2);
  assert.equal(p.isActive("cap-1", now + SESSION_PRESENCE_GRACE_MS * 2), true, "touch 复位后恢复在线");
});
