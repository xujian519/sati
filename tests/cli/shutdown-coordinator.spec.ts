import test from "node:test";
import assert from "node:assert/strict";
import { createShutdownAndExit } from "../../src/cli/shutdownCoordinator.js";

test("createShutdownAndExit runs stop once and exits with the max requested code", async () => {
  let stopCalls = 0;
  let exitCode: number | undefined;
  const shutdown = createShutdownAndExit(
    async () => {
      stopCalls += 1;
    },
    code => {
      exitCode = code;
    },
  );

  await Promise.all([shutdown(0), shutdown(2), shutdown(1)]);
  assert.equal(stopCalls, 1);
  assert.equal(exitCode, 2);
});

test("createShutdownAndExit shares one promise across callers", async () => {
  let stopCalls = 0;
  const shutdown = createShutdownAndExit(
    async () => {
      stopCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
    },
    () => {},
  );

  const first = shutdown(1);
  const second = shutdown(1);
  assert.equal(first, second); // same promise instance
  await Promise.all([first, second]);
  assert.equal(stopCalls, 1);
});

test("createShutdownAndExit keeps the first requested code when later codes are lower", async () => {
  let exitCode: number | undefined;
  const shutdown = createShutdownAndExit(
    async () => {},
    code => {
      exitCode = code;
    },
  );
  await shutdown(5);
  await shutdown(1);
  assert.equal(exitCode, 5);
});

test("createShutdownAndExit waits for stop to finish before exiting", async () => {
  const order: string[] = [];
  const shutdown = createShutdownAndExit(
    async () => {
      order.push("stop");
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push("stop-done");
    },
    () => {
      order.push("exit");
    },
  );
  await shutdown(0);
  assert.deepEqual(order, ["stop", "stop-done", "exit"]);
});
