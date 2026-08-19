import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import type { SessionRouter } from "../../src/gateway/SessionRouter.js";
import { sanitizeSessionIdForPath } from "../../src/session/index.js";

function makeGateway(): InProcessGateway {
  return new InProcessGateway({} as SessionRouter, {});
}

/**
 * 回归测试（聊天直连切默认后暴露的会话 ID 双编码 bug）：
 *
 * UI 直连 gateway 时，新会话由 `InProcessGateway.newSession` 创建。生成的
 * sessionKey 必须与磁盘 transcript 文件名（`sanitizeSessionIdForPath` 输出）
 * 及 REST 会话列表返回的 sessionId（从磁盘文件名读取）完全一致；否则同一
 * 会话出现两种编码（如 `web:project=/Users/xujian/.sati:s_x` 与
 * `web:project=-Users-xujian-.sati:s_x`），导致 resume 时 gateway
 * `getOrCreate` 用错 key 新建空会话、turn 事件 sid 与 selectedSession.id
 * 失配（`complete` 帧不复位 isLoading，追问被 UI 排队/静默丢弃）。
 */
describe("InProcessGateway.newSession sessionKey 与磁盘文件名一致", () => {
  it("路径型 projectKey 生成不含路径分隔符的 sessionKey（/ → -）", async () => {
    const gateway = makeGateway();
    const { sessionKey } = await gateway.newSession({ channelKey: "web", projectKey: "/Users/xujian/.sati" });

    // 不包含原始路径分隔符（磁盘文件名安全）
    assert.ok(!sessionKey.includes("/"));
    assert.ok(!sessionKey.includes("\\"));
    // 前缀保留 channel + project 标记，路径被替换为 -
    assert.match(sessionKey, /^web[: -]project=/);
    assert.ok(sessionKey.includes("-Users-xujian-.sati"));
    assert.match(sessionKey, /[: -]s_[0-9a-f-]+$/);
  });

  it("newSession 返回的 sessionKey 与磁盘文件名（sanitize 幂等）完全一致", async () => {
    const gateway = makeGateway();
    for (const projectKey of ["/Users/xujian/.sati", "/Users/xujian/知识库", "/Users/foo/work/repo"]) {
      const { sessionKey } = await gateway.newSession({ channelKey: "web", projectKey });
      // REST 会话列表的 sessionId = 磁盘文件名 = sanitize(sessionKey)；
      // sanitize 幂等意味着该 key 落盘后读回不变。
      assert.equal(sanitizeSessionIdForPath(sessionKey), sessionKey, `projectKey=${projectKey}`);
    }
  });

  it("无 projectKey 时保持旧格式 web:s_<uuid> 且 sanitize 不变（向后兼容）", async () => {
    const gateway = makeGateway();
    const { sessionKey } = await gateway.newSession({ channelKey: "web" });
    assert.match(sessionKey, /^web[: -]s_[0-9a-f-]+$/);
    assert.equal(sanitizeSessionIdForPath(sessionKey), sessionKey);
  });

  it("带路径的 sessionKey 与 UI 从会话列表拿到的 sessionId 同值（可直接 resume）", async () => {
    const gateway = makeGateway();
    const { sessionKey } = await gateway.newSession({ channelKey: "web", projectKey: "/Users/xujian/.sati" });
    // UI resume 提交的就是这个值；gateway getOrCreate 必须命中同一会话。
    const uiListedSessionId = sanitizeSessionIdForPath(sessionKey);
    assert.equal(uiListedSessionId, sessionKey);
    // 且该 key 可还原出清晰的 project 前缀，供诊断日志阅读
    assert.match(uiListedSessionId, /^web[: -]project=-Users-xujian-\.sati[: -]s_/);
  });
});
