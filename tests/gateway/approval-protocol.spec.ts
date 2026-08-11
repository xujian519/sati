import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession } from "../../src/agent/index.js";
import { GatewayApprovalBus } from "../../src/gateway/approval/GatewayApprovalBus.js";
import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

function mockSession(
  overrides: Partial<Pick<AgentSession, "approvePendingOutput" | "rejectPendingOutput">>,
): AgentSession {
  return {
    approvePendingOutput: () => true,
    rejectPendingOutput: () => true,
    ...overrides,
  } as unknown as AgentSession;
}

describe("GatewayApprovalBus", () => {
  it("register/remove/list/hasPending/pendingCount", () => {
    const bus = new GatewayApprovalBus();
    bus.register({ sessionKey: "s1", pendingIndex: 0, textPreview: "p", triggerKeyword: "k", createdAt: 1 });
    bus.register({ sessionKey: "s1", pendingIndex: 1, textPreview: "q", triggerKeyword: "k", createdAt: 2 });
    bus.register({ sessionKey: "s2", pendingIndex: 0, textPreview: "r", triggerKeyword: "k", createdAt: 3 });

    assert.equal(bus.pendingCount(), 3);
    assert.equal(bus.pendingCount("s1"), 2);
    assert.equal(bus.hasPending("s1", 0), true);
    assert.equal(bus.hasPending("s1", 9), false);
    assert.equal(bus.list("s1").length, 2);
    assert.equal(bus.list().length, 3);

    assert.equal(bus.remove("s1", 0), true);
    assert.equal(bus.remove("s1", 0), false, "重复移除幂等返回 false");
    assert.equal(bus.hasPending("s1", 0), false);
    assert.equal(bus.pendingCount("s1"), 1);
  });
});

describe("InProcessGateway 输出门禁 HITL 审批方法", () => {
  it("approvalListPending 列出总线条目（对外不暴露 sessionKey）", async () => {
    const router = new SessionRouter({ createSession: async () => mockSession({}) });
    const gateway = new InProcessGateway(router, {});
    const bus = gateway.getApprovalBus();
    await router.getOrCreate({ sessionKey: "s1", channelKey: "test" });
    bus.register({ sessionKey: "s1", pendingIndex: 0, textPreview: "专利结论…", triggerKeyword: "无效", createdAt: 1 });

    const result = await gateway.approvalListPending({ sessionKey: "s1" });
    assert.equal(result.pending.length, 1);
    assert.equal(result.pending[0]!.pendingIndex, 0);
    assert.equal(result.pending[0]!.textPreview, "专利结论…");
    assert.equal(result.pending[0]!.triggerKeyword, "无效");
    assert.equal("sessionKey" in result.pending[0]!, false, "DTO 不应泄露内部 sessionKey");
  });

  it("approvalDecide adopted → 调用 session.approvePendingOutput 并从总线移除", async () => {
    const approved: number[] = [];
    const router = new SessionRouter({
      createSession: async () => mockSession({ approvePendingOutput: i => (approved.push(i), true) }),
    });
    const gateway = new InProcessGateway(router, {});
    const bus = gateway.getApprovalBus();
    await router.getOrCreate({ sessionKey: "s1", channelKey: "test" });
    bus.register({ sessionKey: "s1", pendingIndex: 3, textPreview: "x", triggerKeyword: "k", createdAt: 1 });

    const result = await gateway.approvalDecide({ sessionKey: "s1", pendingIndex: 3, verdict: "adopted" });
    assert.equal(result.delivered, true);
    assert.deepEqual(approved, [3]);
    assert.equal(bus.hasPending("s1", 3), false);
  });

  it("approvalDecide rejected → 调用 session.rejectPendingOutput 并携带 feedback", async () => {
    const rejected: Array<[number, string | undefined]> = [];
    const router = new SessionRouter({
      createSession: async () =>
        mockSession({
          rejectPendingOutput: (i, f) => (rejected.push([i, f]), true),
        }),
    });
    const gateway = new InProcessGateway(router, {});
    const bus = gateway.getApprovalBus();
    await router.getOrCreate({ sessionKey: "s1", channelKey: "test" });
    bus.register({ sessionKey: "s1", pendingIndex: 7, textPreview: "x", triggerKeyword: "k", createdAt: 1 });

    const result = await gateway.approvalDecide({
      sessionKey: "s1",
      pendingIndex: 7,
      verdict: "rejected",
      feedback: "结论依据不足",
    });
    assert.equal(result.delivered, true);
    assert.deepEqual(rejected, [[7, "结论依据不足"]]);
    assert.equal(bus.hasPending("s1", 7), false);
  });

  it("approvalDecide 会话不存在或条目不存在 → delivered false（fail-closed）", async () => {
    const router = new SessionRouter({ createSession: async () => mockSession({}) });
    const gateway = new InProcessGateway(router, {});

    // 会话从未创建（不自动创建）。
    assert.equal(
      (await gateway.approvalDecide({ sessionKey: "ghost", pendingIndex: 0, verdict: "adopted" })).delivered,
      false,
    );
    assert.equal(router.get("ghost"), undefined, "审批不应创建新会话");

    // 会话存在但挂起条目不存在。
    await router.getOrCreate({ sessionKey: "s1", channelKey: "test" });
    assert.equal(
      (await gateway.approvalDecide({ sessionKey: "s1", pendingIndex: 99, verdict: "adopted" })).delivered,
      false,
    );
  });

  it("session 审批返回 false（跨会话守卫拒绝）→ delivered false 且条目保留", async () => {
    const router = new SessionRouter({
      createSession: async () => mockSession({ approvePendingOutput: () => false }),
    });
    const gateway = new InProcessGateway(router, {});
    const bus = gateway.getApprovalBus();
    await router.getOrCreate({ sessionKey: "s1", channelKey: "test" });
    bus.register({ sessionKey: "s1", pendingIndex: 5, textPreview: "x", triggerKeyword: "k", createdAt: 1 });

    const result = await gateway.approvalDecide({ sessionKey: "s1", pendingIndex: 5, verdict: "adopted" });
    assert.equal(result.delivered, false);
    assert.equal(bus.hasPending("s1", 5), true, "审批未生效时条目不应被移除");
  });
});
