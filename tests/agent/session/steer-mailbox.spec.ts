/**
 * SteerMailbox 语义测试（协议 1.6 mid-turn steering）。
 *
 * 覆盖：start 开启/enqueue 拒绝、drain 取走即消费、cancel 墓碑防复活、
 * drainOrClose 同步关闭（关闭后 enqueue 失败）、pending 快照不消费、
 * 队列上限。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SteerMailbox } from "../../../src/agent/session/SteerMailbox.js";

test("未 start 时 enqueue 失败（无活动 turn）", () => {
  const mailbox = new SteerMailbox();
  assert.equal(mailbox.isOpen(), false);
  assert.equal(mailbox.enqueue("hello"), undefined);
});

test("start 后 enqueue 成功且 drain 取走即消费", () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  const item = mailbox.enqueue("先别写文件，改用只读方式确认");
  assert.ok(item);
  assert.equal(item.text, "先别写文件，改用只读方式确认");
  assert.deepEqual(
    mailbox.pending().map(pending => pending.steerId),
    [item.steerId],
  );

  const drained = mailbox.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0]?.steerId, item.steerId);
  // 取走即消费：再次 drain 为空
  assert.equal(mailbox.drain().length, 0);
  assert.equal(mailbox.pending().length, 0);
});

test("cancel 撤回排队项，墓碑防复活", () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  const item = mailbox.enqueue("插话");
  assert.ok(item);
  assert.equal(mailbox.cancel(item.steerId), true);
  // 已撤回：drain 不得返回
  assert.equal(mailbox.drain().length, 0);
  // 未知/已消费 id 再 cancel 失败
  assert.equal(mailbox.cancel(item.steerId), false);
  assert.equal(mailbox.cancel("unknown"), false);
});

test("drainOrClose 取走剩余并同步关闭，此后 enqueue 失败", () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  mailbox.enqueue("a");
  const leftover = mailbox.enqueue("b");
  assert.ok(leftover);
  const drained = mailbox.drainOrClose();
  assert.equal(drained.length, 2);
  assert.equal(mailbox.isOpen(), false);
  assert.equal(mailbox.enqueue("late"), undefined);
  // 重复 drainOrClose 幂等
  assert.equal(mailbox.drainOrClose().length, 0);
});

test("下一 turn 的 start 清空上一 turn 残留", () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  mailbox.enqueue("stale");
  mailbox.drainOrClose();
  mailbox.start("turn-2");
  assert.equal(mailbox.turnId(), "turn-2");
  assert.equal(mailbox.pending().length, 0);
  const fresh = mailbox.enqueue("fresh");
  assert.ok(fresh);
});

test("队列上限 16：超限 enqueue 返回 undefined", () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  for (let index = 0; index < 16; index += 1) {
    assert.ok(mailbox.enqueue(`item-${index}`));
  }
  assert.equal(mailbox.enqueue("overflow"), undefined);
  assert.equal(mailbox.pending().length, 16);
  // drain 后腾出空间
  mailbox.drain();
  assert.ok(mailbox.enqueue("after-drain"));
});
