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
  // D1：onPending 延迟到转录写入确认（flushPending）后触发
  assert.equal(pendings.length, 0, "onPending must not fire before flushPending");
  gate.flushPending(result.pendingIndex!);
  assert.equal(pendings.length, 1, "onPending fires after flushPending");
});

test("D1: cancelPending revokes a pending entry when transcript write fails", () => {
  const pendings: unknown[] = [];
  const gate = new PatentOutputGate({
    onPending: p => {
      pendings.push(p);
    },
  });
  const result = gate.processMessage(assistantMessage("专利结论：X。"));
  assert.ok(result.pendingIndex !== undefined);
  assert.equal(gate.pendingCount(), 1);
  gate.cancelPending(result.pendingIndex);
  assert.equal(gate.pendingCount(), 0, "failed write must not leave a dangling pending entry");
  gate.flushPending(result.pendingIndex);
  assert.equal(pendings.length, 0, "cancelled entry must never fire onPending");
});

test("D1: flushPending on an unknown index is a no-op", () => {
  const pendings: unknown[] = [];
  const gate = new PatentOutputGate({
    onPending: p => {
      pendings.push(p);
    },
  });
  gate.flushPending(99);
  gate.cancelPending(99);
  assert.equal(pendings.length, 0);
  assert.equal(gate.pendingCount(), 0);
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

test("D4: bare approve/reject without sessionId is refused for session-bound entries (fail-closed)", () => {
  const gate = new PatentOutputGate({ onPending: () => {} });
  const held = gate.processMessage(assistantMessage("专利结论：A。"), { sessionId: "session-a" });
  assert.ok(held.pendingIndex !== undefined);
  // 不传 sessionId 的裸审批调用（如绕过会话绑定的网关入口）→ 拒绝
  assert.equal(gate.approve(held.pendingIndex), undefined, "bare approve must be refused");
  assert.equal(gate.reject(held.pendingIndex), false, "bare reject must be refused");
  assert.equal(gate.pendingCount(), 1, "pending must survive bare attempts");
});

test("D4: legacy entries without sessionId stay approvable (backward compat)", () => {
  const gate = new PatentOutputGate({ onPending: () => {} });
  const held = gate.processMessage(assistantMessage("专利结论：A。")); // 未传 context
  assert.ok(held.pendingIndex !== undefined);
  assert.ok(gate.approve(held.pendingIndex, "any-session"), "legacy entry without sessionId must be approvable");
});

test("D4: TTL-expired entries cannot be approved or rejected", () => {
  let now = 1_000_000;
  const gate = new PatentOutputGate({ onPending: () => {}, pendingTtlMs: 100, now: () => now });
  const held = gate.processMessage(assistantMessage("专利结论：X。"));
  assert.ok(held.pendingIndex !== undefined);
  now += 101; // 越过 TTL；无新消息触发 pruneExpired，approve 应兜底拒绝
  assert.equal(gate.approve(held.pendingIndex), undefined, "expired entry must be refused on approve");
  assert.equal(gate.reject(held.pendingIndex), false, "expired entry must be refused on reject");
  assert.equal(gate.pendingCount(), 0, "expired entry is cleaned up");
});

test("D4: injectable clock drives createdAt and TTL", () => {
  let now = 500;
  const gate = new PatentOutputGate({ onPending: () => {}, pendingTtlMs: 10, now: () => now });
  const held = gate.processMessage(assistantMessage("专利结论：X。"));
  assert.ok(held.pendingIndex !== undefined);
  assert.equal(held.pendingIndex, 0);
  now += 5;
  assert.ok(gate.approve(held.pendingIndex), "within TTL must be approvable");
});

test("skipApproval context suppresses hanging but keeps quality processing", () => {
  let pendingFired = 0;
  const gate = new PatentOutputGate({
    onPending: () => {
      pendingFired += 1;
    },
  });
  // 审批词 + 风险词：skipApproval 下不挂起，但免责声明照常注入
  const result = gate.processMessage(assistantMessage("该方案存在侵权风险，专利结论：具备新颖性。"), {
    sessionId: "session-a",
    skipApproval: true,
  });
  assert.equal(result.needsApproval, false, "skipApproval must not hold the message");
  assert.equal(gate.pendingCount(), 0);
  assert.equal(pendingFired, 0);
  assert.equal(result.info.disclaimerInjected, true, "quality processing still applies");
  assert.match(extractMessageText(result.message), /不构成正式法律意见/);
});

test("restore re-queues a lost pending entry; onPending fires after flushPending", () => {
  const pendings: number[] = [];
  const gate = new PatentOutputGate({
    onPending: p => {
      pendings.push(p.index);
    },
  });
  const result = gate.processMessage(assistantMessage("专利结论：X。"));
  assert.ok(result.pendingIndex !== undefined);
  // 模拟：条目丢失（cancel 后 restore 恢复）
  const lost = gate.pendingItems()[0]!;
  gate.cancelPending(lost.index);
  assert.equal(gate.pendingCount(), 0);
  gate.restore(lost);
  assert.equal(gate.pendingCount(), 1, "restore must re-queue the entry");
  // restore 不直接触发 onPending（与 D1 协议一致）；宿主确认写入后 flushPending 触发
  assert.deepEqual(pendings, []);
  gate.flushPending(lost.index);
  assert.deepEqual(pendings, [lost.index]);
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
