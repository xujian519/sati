/**
 * `sati server` 的关闭与致命信号处理（P2.7 从 `cli/sati.ts` 的 `main` 内嵌闭包原样搬出）。
 *
 * `stop` 是幂等收尾（flush 渠道状态 → 落 shutdown 遥测快照 → 释放 gateway → 停子系统 →
 * flush 遥测），内部 try/catch 兜底：**任一步失败也要让进程退出**，故只 warn 不抛。
 * 四个信号/异常入口都经 `createShutdownAndExit` 单次化（重复触发复用同一 promise，取最大退出码）。
 */

import type { ChannelStatePersistence } from "../../adapters/index.js";
import { createLogger, type TelemetryClient } from "../../telemetry/index.js";
import { createShutdownAndExit, type ShutdownAndExit } from "../shutdownCoordinator.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";

export function createServerStop(deps: {
  persistence: ChannelStatePersistence;
  telemetry: TelemetryClient;
  state: ServerRuntimeState;
  disposeGateway: () => void;
}): () => Promise<void> {
  return async () => {
    try {
      await deps.persistence.flush();
      createLogger("telemetry").info(`shutdown snapshot ${JSON.stringify(deps.telemetry.snapshot())}`);
      deps.disposeGateway();
      await deps.state.alwaysOn?.stop();
      await deps.state.cron?.stop();
      await deps.telemetry.shutdown();
    } catch (error) {
      createLogger("runtime").warn(`stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** 建 `stop` + `shutdownAndExit` 对并挂上 uncaughtException / unhandledRejection / SIGINT / SIGTERM。 */
export function installShutdownHandlers(deps: {
  telemetry: TelemetryClient;
  stop: () => Promise<void>;
}): ShutdownAndExit {
  const shutdownAndExit = createShutdownAndExit(deps.stop, exitCode => process.exit(exitCode));
  process.on("uncaughtException", error => {
    deps.telemetry.trackError(error, { module: "runtime", metadata: { source: "uncaughtException" } });
    void shutdownAndExit(1);
  });
  process.on("unhandledRejection", reason => {
    deps.telemetry.trackError(reason, { module: "runtime", metadata: { source: "unhandledRejection" } });
    void shutdownAndExit(1);
  });
  process.on("SIGINT", () => {
    void shutdownAndExit(0);
  });
  process.on("SIGTERM", () => {
    void shutdownAndExit(0);
  });
  return shutdownAndExit;
}
