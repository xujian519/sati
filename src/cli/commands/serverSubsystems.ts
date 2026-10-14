/**
 * AlwaysOn / Cron 子系统的构造与配置热重载（P2.7 从 `cli/sati.ts` 的 `main` 内嵌闭包搬出）。
 *
 * 两段职责：`createSubsystemBuilders` 造管理器（stdout 日志经注入 logger 透传），
 * `createSubsystemReloader` 在 `sati.yaml` 变更时按 `alwaysOn.` / `cron.` 前缀停旧起新并回写
 * `updateSubsystems`。拆出的**关键约束**：两者都经 `state` 读写同一份可变绑定（热重载整体
 * 替换、其他调用点按事件发生时读取），故不能用值传参。
 */

import {
  type AlwaysOnConfig,
  type AlwaysOnManager,
  createAlwaysOnManager,
  createApplyHandler,
  type SessionConfigOverrides,
} from "../../always-on/index.js";
import { type CronConfig, type CronManager, createCronManager } from "../../cron/index.js";
import type { InProcessGateway } from "../../gateway/index.js";
import type { PilotConfig } from "../../pilot/index.js";
import { createLogger, logger, type TelemetryClient } from "../../telemetry/index.js";
import type { SubsystemUpdate } from "../createLocalGateway.js";
import type { ServerRuntimeState } from "./serverRuntimeState.js";

export type SubsystemBuilders = {
  buildAlwaysOn(config: AlwaysOnConfig | undefined): AlwaysOnManager | undefined;
  buildCron(config: CronConfig | undefined): CronManager | undefined;
  /** cron 命名空间 logger：server 启动路径也要用它记失败，故一并交出。 */
  cronLog: ReturnType<typeof createLogger>;
};

export type SubsystemBuilderDeps = {
  pilotHome: string;
  sessionOverrides: SessionConfigOverrides;
  telemetry: TelemetryClient;
  state: ServerRuntimeState;
};

export function createSubsystemBuilders(deps: SubsystemBuilderDeps): SubsystemBuilders {
  const { state } = deps;
  const alwaysOnLog = createLogger("always-on");
  const cronLog = createLogger("cron");
  const alwaysOnLogger = {
    info: (message: string, data?: Record<string, unknown>) =>
      alwaysOnLog.info(`${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
    warn: (message: string, data?: Record<string, unknown>) =>
      alwaysOnLog.warn(`${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
    debug: (message: string, data?: Record<string, unknown>) =>
      alwaysOnLog.debug(`${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
  };
  const cronLogger = {
    info: (message: string, data?: Record<string, unknown>) =>
      cronLog.info(`${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
    warn: (message: string, data?: Record<string, unknown>) =>
      cronLog.warn(`${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
  };

  function buildAlwaysOn(config: AlwaysOnConfig | undefined): AlwaysOnManager | undefined {
    if (!config?.enabled) return undefined;
    return createAlwaysOnManager({
      config,
      pilotHome: deps.pilotHome,
      sessionOverrides: deps.sessionOverrides,
      logger: alwaysOnLogger,
      telemetry: deps.telemetry,
      onWorktreeCreated: (runId, cwd) => {
        state.broadcast("worktree_created", { runId, cwd });
      },
      onWorktreeRemoved: cwd => {
        state.broadcast("worktree_removed", { cwd });
      },
      onTurnEvent: (sessionKey, channelKey, event) => {
        state.broadcast("always-on:turn-event", { sessionKey, channelKey, event });
      },
    });
  }

  function buildCron(config: CronConfig | undefined): CronManager | undefined {
    if (!config) return undefined;
    return createCronManager({
      config,
      pilotHome: deps.pilotHome,
      sessionOverrides: deps.sessionOverrides,
      logger: cronLogger,
      telemetry: deps.telemetry,
      onTurnEvent: (sessionKey, channelKey, event) => {
        state.broadcast("cron:turn-event", { sessionKey, channelKey, event });
      },
      onResultDelivery: delivery => {
        void state.server
          ?.deliverCronResult(delivery)
          .then(delivered => {
            if (!delivered) {
              cronLog.warn(`result delivery was not handled task=${delivery.taskId} run=${delivery.runId}`);
            }
          })
          .catch((error: unknown) => {
            cronLog.warn(`result delivery failed ${error instanceof Error ? error.message : String(error)}`);
          });
      },
    });
  }

  return { buildAlwaysOn, buildCron, cronLog };
}

export type SubsystemReloaderDeps = SubsystemBuilderDeps & {
  builders: SubsystemBuilders;
  gateway: InProcessGateway;
  isProjectBusy: (projectKey: string) => boolean;
  updateSubsystems: (update: SubsystemUpdate) => void;
  discoveryPlanService: SubsystemUpdate["discoveryPlanService"];
};

/**
 * 配置热重载入口（`configStore.subscribe` 的 `alwaysOn.` / `cron.` 分支）。
 * 先停旧（置 undefined）再按需重建，`updateSubsystems` 以**当时**的绑定重算工具表；
 * 未改动的子系统保持原实例不动（cron 不变则不重启）。
 */
export function createSubsystemReloader(
  deps: SubsystemReloaderDeps,
): (aoChanged: boolean, cronChanged: boolean, config: PilotConfig) => Promise<void> {
  const { state, builders } = deps;
  return async (aoChanged, cronChanged, config) => {
    if (aoChanged) {
      await state.alwaysOn?.stop();
      state.alwaysOn = undefined;
    }
    if (cronChanged) {
      await state.cron?.stop();
      state.cron = undefined;
    }

    if (aoChanged) state.alwaysOn = builders.buildAlwaysOn(config.alwaysOn);
    if (cronChanged) state.cron = builders.buildCron(config.cron);

    if (aoChanged && state.alwaysOn) {
      state.alwaysOn.bindGateway(deps.gateway, { isProjectBusy: deps.isProjectBusy });
      await state.alwaysOn.start();
    }

    const fallbackApply = createApplyHandler({
      gateway: deps.gateway,
      pilotHome: deps.pilotHome,
      sessionOverrides: deps.sessionOverrides,
      alwaysOnConfig: config.alwaysOn,
      telemetry: deps.telemetry,
      onTurnEvent: (sessionKey, channelKey, event) => {
        state.broadcast("always-on:turn-event", { sessionKey, channelKey, event });
      },
    });

    deps.updateSubsystems({
      extraTools: [...(state.alwaysOn?.getTools() ?? []), ...(state.cron?.getTools() ?? [])],
      sessionOverrides: deps.sessionOverrides,
      cron: state.cron,
      alwaysOnApply: state.alwaysOn ? input => state.alwaysOn!.applyCycle(input) : fallbackApply,
      alwaysOnRerunPlan: state.alwaysOn ? input => state.alwaysOn!.rerunPlan(input) : undefined,
      discoveryPlanService: deps.discoveryPlanService,
    });
    if (cronChanged && state.cron) {
      state.cron.bindGateway(deps.gateway);
      await state.cron.start();
    }

    const parts: string[] = [];
    if (aoChanged) parts.push(`always-on=${state.alwaysOn ? "started" : "stopped"}`);
    if (cronChanged) parts.push(`cron=${state.cron ? "started" : "stopped"}`);
    logger.info(`Subsystem hot-reload complete: ${parts.join(", ")}`);
  };
}
