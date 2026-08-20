import assert from "node:assert/strict";
import test from "node:test";
import { withTeamLock } from "../../../../src/agent/team/index.js";

test("withTeamLock：并发调用严格串行（前一个 operation 完成后才执行下一个）", async () => {
  const order: string[] = [];
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  await Promise.all([
    withTeamLock("k", async () => {
      order.push("a-start");
      await delay(30);
      order.push("a-end");
    }),
    withTeamLock("k", async () => {
      order.push("b-start");
      order.push("b-end");
    }),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("withTeamLock：operation 抛错后锁释放，下一个排队者仍可执行", async () => {
  await assert.rejects(
    withTeamLock("k", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  let ran = false;
  await withTeamLock("k", async () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("withTeamLock：并发排队时前一个 operation 抛错，队列不毒化（后续排队者与失败后的新调用者均可执行）", async () => {
  const order: string[] = [];
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  // 失败注入：A 先进入并排队等待，B 紧随其后排队；A 的 operation 抛错后锁经 finally 释放，
  // B（正在排队的调用者）照常执行，之后 C（失败后的新调用者）也正常执行。
  const results = await Promise.allSettled([
    withTeamLock("k", async () => {
      order.push("a-start");
      await delay(30);
      order.push("a-end");
      throw new Error("boom-a");
    }),
    withTeamLock("k", async () => {
      order.push("b-start");
      order.push("b-end");
    }),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  let ranC = false;
  await withTeamLock("k", async () => {
    ranC = true;
  });
  assert.equal(ranC, true);
  // 串行顺序保持：a 完成后（抛错）b 才执行
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("withTeamLock：不同 key 互不阻塞", async () => {
  const order: string[] = [];
  const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
  await Promise.all([
    withTeamLock("a", async () => {
      await delay(30);
      order.push("a");
    }),
    withTeamLock("b", async () => {
      order.push("b");
    }),
  ]);
  assert.deepEqual(order, ["b", "a"]);
});
