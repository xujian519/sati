import assert from "node:assert/strict";
import test from "node:test";
import { createShutdownAndExit } from "../../src/cli/shutdownCoordinator.js";

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("shutdownAndExit stops once and exits with zero for a normal signal", async () => {
  let stopCalls = 0;
  const exitCodes: number[] = [];
  const shutdownAndExit = createShutdownAndExit(
    async () => {
      stopCalls += 1;
    },
    (exitCode) => exitCodes.push(exitCode),
  );

  await shutdownAndExit(0);

  assert.equal(stopCalls, 1);
  assert.deepEqual(exitCodes, [0]);
});

test("shutdownAndExit stops once and exits with one for a fatal error", async () => {
  let stopCalls = 0;
  const exitCodes: number[] = [];
  const shutdownAndExit = createShutdownAndExit(
    async () => {
      stopCalls += 1;
    },
    (exitCode) => exitCodes.push(exitCode),
  );

  await shutdownAndExit(1);

  assert.equal(stopCalls, 1);
  assert.deepEqual(exitCodes, [1]);
});

test("shutdownAndExit does not repeat cleanup for repeated fatal errors", async () => {
  const deferred = createDeferred();
  let stopCalls = 0;
  const exitCodes: number[] = [];
  const shutdownAndExit = createShutdownAndExit(
    async () => {
      stopCalls += 1;
      await deferred.promise;
    },
    (exitCode) => exitCodes.push(exitCode),
  );

  const first = shutdownAndExit(1);
  const second = shutdownAndExit(1);
  deferred.resolve();
  await Promise.all([first, second]);

  assert.equal(stopCalls, 1);
  assert.deepEqual(exitCodes, [1]);
});

test("shutdownAndExit promotes the exit code when a fatal error occurs during cleanup", async () => {
  const deferred = createDeferred();
  let stopCalls = 0;
  const exitCodes: number[] = [];
  const shutdownAndExit = createShutdownAndExit(
    async () => {
      stopCalls += 1;
      await deferred.promise;
    },
    (exitCode) => exitCodes.push(exitCode),
  );

  const signalShutdown = shutdownAndExit(0);
  const fatalShutdown = shutdownAndExit(1);
  deferred.resolve();
  await Promise.all([signalShutdown, fatalShutdown]);

  assert.equal(stopCalls, 1);
  assert.deepEqual(exitCodes, [1]);
});
