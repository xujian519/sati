/**
 * `sati server` 的运行时状态与关闭收尾（P2.7 从 `cli/sati.ts` 搬出）。
 *
 * 两条契约：
 *   1. 启动完成前的广播是 no-op（原 `deferredBroadcast?.()` 语义），server 就绪后转投
 *      `broadcastNotification`；
 *   2. `stop` 幂等且**永不抛出**——任一步失败只 warn（铁律 11：降级不静默），否则
 *      `shutdownAndExit` 会卡在 stop 上，进程退不出去。
 *
 * 类型断言说明：这里只用到被断言对象的一两个方法（`broadcastNotification` /
 * `flush` / `snapshot`），构造完整宿主对象没有意义。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ChannelStatePersistence } from "../../src/adapters/index.js";
import { createServerStop } from "../../src/cli/commands/serverLifecycle.js";
import { createServerRuntimeState, type SatiServerHandle } from "../../src/cli/commands/serverRuntimeState.js";
import type { TelemetryClient } from "../../src/telemetry/index.js";

/** 临时接住 console.log/warn，返回恢复函数。 */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
    },
  };
}

test("server 未就绪时 broadcast 是 no-op，就绪后转发 broadcastNotification", () => {
  const calls: Array<[string, unknown]> = [];
  const state = createServerRuntimeState();

  state.broadcast("worktree_created", { runId: "r1" });
  assert.equal(calls.length, 0, "server 未就绪时不得转发");

  state.server = {
    broadcastNotification(name: string, payload?: unknown) {
      calls.push([name, payload]);
    },
  } as unknown as SatiServerHandle;

  state.broadcast("worktree_created", { runId: "r1" });
  state.broadcast("cron:turn-event");
  assert.deepEqual(calls, [
    ["worktree_created", { runId: "r1" }],
    ["cron:turn-event", undefined],
  ]);
});

test("stop 依次 flush 渠道状态 / 落快照 / 释放 gateway / 停子系统 / shutdown 遥测", async () => {
  const order: string[] = [];
  const state = createServerRuntimeState();
  state.alwaysOn = { stop: async () => void order.push("alwaysOn.stop") } as unknown as NonNullable<
    typeof state.alwaysOn
  >;
  state.cron = { stop: async () => void order.push("cron.stop") } as unknown as NonNullable<typeof state.cron>;
  const captured = captureConsole();

  try {
    const stop = createServerStop({
      persistence: { flush: async () => void order.push("flush") } as unknown as ChannelStatePersistence,
      telemetry: {
        snapshot: () => ({ tracked: true }),
        shutdown: async () => void order.push("telemetry.shutdown"),
      } as unknown as TelemetryClient,
      state,
      disposeGateway: () => void order.push("disposeGateway"),
    });

    await stop();
    assert.deepEqual(order, ["flush", "disposeGateway", "alwaysOn.stop", "cron.stop", "telemetry.shutdown"]);
    assert.ok(
      captured.lines.some(line => line.includes("shutdown snapshot")),
      `应落 shutdown 快照，实得：${JSON.stringify(captured.lines)}`,
    );
  } finally {
    captured.restore();
  }
});

test("stop 任一步失败也不抛出，且失败可见（warn 不静默）", async () => {
  const captured = captureConsole();
  try {
    const stop = createServerStop({
      persistence: {
        flush: async () => {
          throw new Error("flush boom");
        },
      } as unknown as ChannelStatePersistence,
      telemetry: {
        snapshot: () => ({}),
        shutdown: async () => {},
      } as unknown as TelemetryClient,
      state: createServerRuntimeState(),
      disposeGateway: () => {
        throw new Error("dispose boom");
      },
    });

    await stop();
    assert.ok(
      captured.lines.some(line => line.includes("stop failed:") && line.includes("flush boom")),
      `失败原因应可见，实得：${JSON.stringify(captured.lines)}`,
    );
  } finally {
    captured.restore();
  }
});
