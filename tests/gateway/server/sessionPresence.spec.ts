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

test("panelTouch：面板心跳使直连关闭会话保持在线；心跳停超宽限窗判离线（M4 Web 下线判定）", () => {
  const p = new SessionPresence();
  const t0 = 1_000_000;
  p.touch("web-1", t0); // 浏览器经 relay 的直连帧（转发时 touch 到浏览器会话 key）
  p.close("web-1", t0 + 5_000);
  // 直连关闭 5s 后（宽限窗 60s 内）仍在线
  assert.equal(p.isActive("web-1", t0 + 6_000), true);
  // 面板心跳刷新：超过宽限窗后仍在线
  p.panelTouch("web-1", t0 + 100_000);
  assert.equal(p.isActive("web-1", t0 + 150_000), true, "心跳在宽限窗内保持在线");
  // 心跳停止：最后心跳 + 宽限窗后离线（known-offline 持久）
  assert.equal(p.isActive("web-1", t0 + 100_000 + SESSION_PRESENCE_GRACE_MS + 1), false);
  assert.equal(p.isActive("web-1", t0 + 999_999_999), false, "持久离线直到下次 touch/panelTouch 复位");
  // 从未见过的会话仍视为在线（unknown → true，容错优先不变）
  assert.equal(p.isActive("never-seen"), true);
  // 面板心跳复位
  p.panelTouch("web-1", t0 + 999_999_999);
  assert.equal(p.isActive("web-1", t0 + 999_999_999 + SESSION_PRESENCE_GRACE_MS - 1), true);
});

test("panelTouch：面板信号对 web 会话是权威下线信号（直连宽限窗不掩盖面板停更）", () => {
  const p = new SessionPresence();
  const t0 = 1_000_000;
  // 未 touch 过的 key 直接面板心跳：注册为面板维度活跃（unknown → panel-only）
  p.panelTouch("panel-only", t0);
  assert.equal(p.isActive("panel-only", t0 + SESSION_PRESENCE_GRACE_MS - 1), true, "面板心跳宽限窗内在线");
  assert.equal(p.isActive("panel-only", t0 + SESSION_PRESENCE_GRACE_MS + 1), false, "面板心跳停更超窗离线");
  // 直连宽限窗未满但面板停更超窗 → 离线：web 经 relay 会话 closedAt 恒 undefined
  //（共享连接永不关闭），直连"宽限窗"形同虚设——面板信号才是真实在线信号（M3 I1 修复点）
  const p3 = new SessionPresence();
  p3.touch("web-3", t0); // 最后一条 relay 帧（touch 直连维度）
  p3.panelTouch("web-3", t0); // 最后一次面板心跳
  p3.close("web-3", t0 + 5_000); // 直连关闭（真实 web 路径不触发；此处验证优先级）
  assert.equal(p3.isActive("web-3", t0 + 30_000), true, "直连宽限窗内且面板心跳新鲜 → 在线");
  assert.equal(p3.isActive("web-3", t0 + 60_500), false, "直连宽限窗未满但面板停更超窗 → 离线");
  // panelTouch 不清 closedAt（面板心跳不是直连）：直连维度仍以 close 为准；
  // 直连超窗后仅靠面板心跳维持在线
  const p2 = new SessionPresence();
  p2.touch("web-2", t0);
  p2.panelTouch("web-2", t0 + 10_000);
  p2.close("web-2", t0 + 20_000);
  p2.panelTouch("web-2", t0 + 50_000); // 面板心跳继续（浏览器打开中）
  assert.equal(p2.isActive("web-2", t0 + 20_000 + SESSION_PRESENCE_GRACE_MS - 1), true, "直连宽限窗内在线");
  p2.panelTouch("web-2", t0 + 20_000 + SESSION_PRESENCE_GRACE_MS + 10_000); // 直连已超窗，面板仍在心跳
  assert.equal(
    p2.isActive("web-2", t0 + 20_000 + SESSION_PRESENCE_GRACE_MS + 10_000 + SESSION_PRESENCE_GRACE_MS - 1),
    true,
    "直连超窗后仅靠面板心跳维持在线",
  );
  assert.equal(
    p2.isActive("web-2", t0 + 20_000 + SESSION_PRESENCE_GRACE_MS * 2 + 10_000 + 1),
    false,
    "面板心跳停更 → 离线",
  );
});
