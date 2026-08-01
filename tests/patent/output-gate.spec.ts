import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalMessage } from "../../src/model/index.js";
import { extractMessageText, PatentOutputGate } from "../../src/patent/output-gate.js";

function assistantMessage(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

test("non-assistant and tool-call messages pass through untouched", () => {
  const gate = new PatentOutputGate({ onPending: () => {} });
  const user = { role: "user" as const, content: [{ type: "text" as const, text: "你好" }] };
  const r1 = gate.processMessage(user);
  assert.equal(r1.needsApproval, false);
  assert.equal(r1.message, user);

  const toolCall = {
    role: "assistant" as const,
    content: [{ type: "tool_call" as const, id: "t1", name: "grep", input: {} }],
  };
  const r2 = gate.processMessage(toolCall);
  assert.equal(r2.needsApproval, false);
  assert.equal(r2.message, toolCall);
});

test("plain assistant text without patent keywords passes through unchanged", () => {
  const gate = new PatentOutputGate();
  const msg = assistantMessage("今天天气不错。");
  const result = gate.processMessage(msg);
  assert.equal(result.needsApproval, false);
  assert.equal(result.message, msg);
  assert.equal(result.info.disclaimerInjected, false);
});

test("risk keywords inject disclaimer and message is persisted", () => {
  const gate = new PatentOutputGate();
  const msg = assistantMessage("经分析，该方案存在侵权风险。");
  const result = gate.processMessage(msg);
  assert.equal(result.needsApproval, false);
  assert.equal(result.info.riskKeywordsHit.includes("侵权"), true);
  assert.equal(result.info.disclaimerInjected, true);
  const text = extractMessageText(result.message);
  assert.match(text, /不构成正式法律意见/);
  // 原文只出现一次（防全文重复追加）
  assert.equal((text.match(/侵权风险/g) ?? []).length, 1);
});

test("negated risk keywords do not inject disclaimer", () => {
  const gate = new PatentOutputGate();
  const msg = assistantMessage("经分析，本方案不构成侵权。");
  const result = gate.processMessage(msg);
  assert.equal(result.info.riskKeywordsHit.includes("侵权"), false);
  assert.equal(result.info.disclaimerInjected, false);
});

test("approval keywords with onPending hold the message in the pending queue", () => {
  const pendings: unknown[] = [];
  const gate = new PatentOutputGate({
    onPending: pending => {
      pendings.push(pending);
    },
  });
  const msg = assistantMessage("专利结论：本方案具备新颖性。");
  const result = gate.processMessage(msg);
  assert.equal(result.needsApproval, true);
  assert.equal(result.pendingIndex, 0);
  assert.equal(gate.pendingCount(), 1);
  assert.equal(pendings.length, 1);
});

test("approval keywords without onPending still persist (no message loss)", () => {
  const gate = new PatentOutputGate();
  const msg = assistantMessage("专利结论：本方案具备新颖性。");
  const result = gate.processMessage(msg);
  assert.equal(result.needsApproval, false, "without onPending the message must not be held");
  assert.equal(gate.pendingCount(), 0);
});

test("approve removes pending; notifyCommitted fires onApproved; reject discards", () => {
  const approved: number[] = [];
  const rejected: number[] = [];
  const gate = new PatentOutputGate({
    onPending: () => {},
    onApproved: p => {
      approved.push(p.index);
    },
    onRejected: p => {
      rejected.push(p.index);
    },
  });
  const a = gate.processMessage(assistantMessage("专利结论：A。"));
  const b = gate.processMessage(assistantMessage("专利结论：B。"));
  assert.ok(a.pendingIndex !== undefined && b.pendingIndex !== undefined);

  // approve 只取出，不触发 onApproved（等写库成功后由 notifyCommitted 触发）
  const taken = gate.approve(a.pendingIndex);
  assert.ok(taken, "approve should return the pending message");
  assert.deepEqual(approved, [], "onApproved must fire only after commit");
  assert.equal(gate.pendingCount(), 1);
  gate.notifyCommitted(taken!);
  assert.deepEqual(approved, [a.pendingIndex]);

  assert.equal(gate.reject(b.pendingIndex), true);
  assert.deepEqual(rejected, [b.pendingIndex]);
  assert.equal(gate.pendingCount(), 0);

  assert.equal(gate.approve(a.pendingIndex), undefined, "already approved index returns undefined");
  assert.equal(gate.reject(b.pendingIndex), false, "already rejected index returns false");
});

test("maxPending overflow falls back to persist (no message loss)", () => {
  const gate = new PatentOutputGate({ onPending: () => {}, maxPending: 1 });
  const first = gate.processMessage(assistantMessage("专利结论：第一条。"));
  assert.equal(first.needsApproval, true);
  assert.equal(gate.pendingCount(), 1);
  // 队列已满：第二条不挂起、直接入库
  const second = gate.processMessage(assistantMessage("专利结论：第二条。"));
  assert.equal(second.needsApproval, false);
  assert.equal(gate.pendingCount(), 1);
});

test("pendingTtlMs prunes stale held messages", () => {
  const gate = new PatentOutputGate({ onPending: () => {}, pendingTtlMs: 50 });
  const first = gate.processMessage(assistantMessage("专利结论：X。"));
  assert.equal(first.needsApproval, true);
  assert.equal(gate.pendingCount(), 1);
  // TTL 过后处理下一条消息时触发清理
  return new Promise<void>(resolve => {
    setTimeout(() => {
      gate.processMessage(assistantMessage("普通消息。"));
      assert.equal(gate.pendingCount(), 0, "stale pending should be pruned");
      resolve();
    }, 80);
  });
});

test("approval keywords are not bypassed by negation context (security)", () => {
  const gate = new PatentOutputGate({ onPending: () => {} });
  // 单字否定词（"不"）在审批词前不得豁免：合规敏感结论必须人工审批
  const msg = assistantMessage("不，专利结论：本方案具备新颖性。");
  const result = gate.processMessage(msg);
  assert.equal(result.needsApproval, true, "approval keyword must not be negated by a single 不");
  assert.ok(result.info.approvalKeywordsHit.includes("专利结论"));
});

test("approve/reject reject cross-session indices (security)", () => {
  const gate = new PatentOutputGate({ onPending: () => {} });
  const msg = assistantMessage("专利结论：A。");
  const held = gate.processMessage(msg, { sessionId: "session-a" });
  assert.ok(held.pendingIndex !== undefined);

  // 其他会话越权审批：被拒
  assert.equal(gate.approve(held.pendingIndex, "session-b"), undefined, "cross-session approve must be rejected");
  assert.equal(gate.reject(held.pendingIndex, "session-b"), false, "cross-session reject must be rejected");
  assert.equal(gate.pendingCount(), 1, "pending must survive cross-session attempts");

  // 本会话审批：成功
  assert.ok(gate.approve(held.pendingIndex, "session-a"), "same-session approve must succeed");
  assert.equal(gate.pendingCount(), 0);
});

test("messages with thinking + text blocks are processed on the text part only", () => {
  const gate = new PatentOutputGate();
  const msg = {
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, text: "内部思考" },
      { type: "text" as const, text: "该方案存在侵权风险。" },
    ],
  };
  const result = gate.processMessage(msg);
  assert.equal(result.info.disclaimerInjected, true);
  const texts = result.message.content.filter(b => b.type === "text").map(b => (b as { text: string }).text);
  assert.equal(texts.length, 1, "text block should be replaced, not appended");
  assert.match(texts[0]!, /不构成正式法律意见/);
  assert.equal((texts[0]!.match(/侵权风险/g) ?? []).length, 1, "original text must appear exactly once");
});

test("pendingItems lists held messages for approval UI", () => {
  const gate = new PatentOutputGate({ onPending: () => {} });
  gate.processMessage(assistantMessage("专利结论：X。"));
  const items = gate.pendingItems();
  assert.equal(items.length, 1);
  assert.match(extractMessageText(items[0]!.processed), /专利结论/);
});
