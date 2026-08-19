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
