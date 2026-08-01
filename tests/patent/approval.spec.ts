import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryApprovalStore,
  PatentOutputGate,
  createApprovalRecord,
  type PendingPatentMessage,
} from "../../src/patent/index.js";

const APPROVAL_KEYWORDS = ["专利结论", "侵权判断", "有效性结论", "最终建议"];

/** 构造一条含审批词的 assistant 文本消息。 */
function approvalMessage(text: string): { role: "assistant"; content: { type: "text"; text: string }[] } {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** 挂起需同时配置 onPending 回调（PatentOutputGate 设计约束）。 */
const PENDING_HOOK = { onPending: () => {} };

test("PatentOutputGate + approvalStore：approve 写入 adopted 审计", () => {
  const store = new InMemoryApprovalStore();
  const gate = new PatentOutputGate({ approvalKeywords: APPROVAL_KEYWORDS, approvalStore: store, ...PENDING_HOOK });
  const res = gate.processMessage(approvalMessage("这是我的最终建议：应授权。"), { sessionId: "s1", turnId: "t1" });
  assert.equal(res.needsApproval, true);
  assert.ok(res.pendingIndex !== undefined);

  const pending = gate.approve(res.pendingIndex!, "s1");
  assert.ok(pending);
  const records = store.listRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.verdict, "adopted");
  assert.equal(records[0]?.sessionId, "s1");
  assert.equal(records[0]?.triggerKeyword, "最终建议");
  assert.match(records[0]?.originalOutputPreview ?? "", /应授权/);
});

test("PatentOutputGate + approvalStore：reject 写入 rejected 审计（含 feedback）", () => {
  const store = new InMemoryApprovalStore();
  const gate = new PatentOutputGate({ approvalKeywords: APPROVAL_KEYWORDS, approvalStore: store, ...PENDING_HOOK });
  const res = gate.processMessage(approvalMessage("侵权判断：构成侵权。"), { sessionId: "s1" });

  const ok = gate.reject(res.pendingIndex!, "s1", "证据不足，驳回该结论");
  assert.equal(ok, true);
  const records = store.listRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.verdict, "rejected");
  assert.equal(records[0]?.feedback, "证据不足，驳回该结论");
});

test("PatentOutputGate：无 approvalStore 时 approve/reject 不抛错（零开销降级）", () => {
  const gate = new PatentOutputGate({ approvalKeywords: APPROVAL_KEYWORDS, ...PENDING_HOOK });
  const res = gate.processMessage(approvalMessage("有效性结论：有效。"), {});
  assert.equal(res.needsApproval, true);
  assert.doesNotThrow(() => gate.approve(res.pendingIndex!));
});

test("PatentOutputGate：跨会话越权 approve/reject 被拒绝且不写审计", () => {
  const store = new InMemoryApprovalStore();
  const gate = new PatentOutputGate({ approvalKeywords: APPROVAL_KEYWORDS, approvalStore: store, ...PENDING_HOOK });
  const res = gate.processMessage(approvalMessage("专利结论：新颖。"), { sessionId: "s1" });

  assert.equal(gate.approve(res.pendingIndex!, "s2"), undefined); // 错误会话
  assert.equal(gate.reject(res.pendingIndex!, "s2"), false);
  assert.equal(store.listRecords().length, 0);
  // 正确会话仍可审批
  assert.ok(gate.approve(res.pendingIndex!, "s1"));
  assert.equal(store.listRecords().length, 1);
});

test("createApprovalRecord：字段默认与截断", () => {
  const record = createApprovalRecord({
    pendingIndex: 7,
    triggerKeyword: "侵权判断",
    originalOutputPreview: "x".repeat(2000),
    verdict: "modified",
    modifiedOutput: "修正版",
  });
  assert.equal(record.pendingIndex, 7);
  assert.equal(record.verdict, "modified");
  assert.equal(record.modifiedOutput, "修正版");
  assert.ok((record.originalOutputPreview?.length ?? 0) <= 500);
  assert.match(record.decidedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("InMemoryApprovalStore.stats：AdoptionRate 统计", () => {
  const store = new InMemoryApprovalStore();
  assert.equal(store.stats().adoptionRate, 0); // 空库不除零
  const base = {
    pendingIndex: 1,
    triggerKeyword: "专利结论",
    originalOutputPreview: "x",
    decidedAt: "2026-01-01T00:00:00.000Z",
  };
  store.saveRecord({ ...base, verdict: "adopted" as const });
  store.saveRecord({ ...base, pendingIndex: 2, verdict: "adopted" as const });
  store.saveRecord({ ...base, pendingIndex: 3, verdict: "rejected" as const });
  const stats = store.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.adopted, 2);
  assert.equal(stats.rejected, 1);
  assert.ok(Math.abs(stats.adoptionRate - 2 / 3) < 1e-9);
});

test("PatentOutputGate：审批词未命中不触发挂起", () => {
  const store = new InMemoryApprovalStore();
  const gate = new PatentOutputGate({ approvalKeywords: APPROVAL_KEYWORDS, approvalStore: store });
  const res = gate.processMessage(approvalMessage("普通回复，无审批词。"), {});
  assert.equal(res.needsApproval, false);
  assert.equal(gate.pendingCount(), 0);
  assert.equal(store.listRecords().length, 0);
});

// 类型层面验证：PendingPatentMessage 可被消费（防接口漂移）
export type _ApprovalCompat = PendingPatentMessage;
