/**
 * `sati server` — gateway + web 服务启动（P2.7 从 `cli/sati.ts` 的 `main` 的 server 分支搬出）。
 *
 * 本模块只保留**编排骨架**：启动顺序、门禁（proxy → 渠道 → 子系统 → gateway → server）与
 * 各分支的失败语义；四类可分离关注点已外移——渠道构造（`serverChannels.ts`）、
 * AlwaysOn/Cron 构造与热重载（`serverSubsystems.ts`）、适配器热重载
 * （`serverAdapterReload.ts`）、关闭与信号处理（`serverLifecycle.ts`）。
 *
 * 启动期可变绑定（alwaysOn / cron / server）经 `ServerRuntimeState` 传递：原实现是
 * `main` 闭包里的 `let`，热重载整体替换、其余调用点在事件发生时读取。
 *
 * **有意保留的顺序**：`configStore.subscribe` 之前必须先建好重载回调（原实现是函数声明，
 * 有提升，可写在后面）——工厂创建本身无副作用，故提前声明不改变可观测行为。
 */

import { resolve } from "node:path";
import { createApplyHandler, SessionConfigOverrides, createDiscoveryPlanService } from "../../always-on/index.js";
import { ChannelStatePersistence, loadEnabledChannels, setUpdateRestartHandler } from "../../adapters/index.js";
import { brandEnv, ENV_KEY } from "../../env.js";
import type { InProcessGateway } from "../../gateway/index.js";
import { loadPilotConfig, resolvePilotHome } from "../../pilot/index.js";
import { createTelemetryCollector, logger, plainLogger as out } from "../../telemetry/index.js";
import { createLocalGateway } from "../createLocalGateway.js";
import { createCoreDiscoveryPlanIo } from "../discoveryIo.js";
import { installGlobalProxy, reinstallGlobalProxy } from "../proxy.js";
import { startSatiServer } from "../satiServer.js";
import { createAdapterHotReload } from "./serverAdapterReload.js";
import { buildFeishuChannel, buildQqChannel, buildWeComChannel, buildWeixinChannel } from "./serverChannels.js";
import { installShutdownHandlers, createServerStop } from "./serverLifecycle.js";
import { createServerRuntimeState } from "./serverRuntimeState.js";
import { createSubsystemBuilders, createSubsystemReloader } from "./serverSubsystems.js";
import { readPort } from "./flagParsing.js";

export async function runServerCommand(argv: string[]): Promise<void> {
  await installGlobalProxy();

  // 宿主拥有进程生命周期控制权：/update 渠道命令通过此 handler 触发
  // 退出，由进程管理器拉起（无管理器时用户手动重启）。
  setUpdateRestartHandler(() => process.exit(0));

  const projectRoot = process.cwd();
  const env = process.env;
  const pilotHome = resolvePilotHome(env);
  const snapshot = loadPilotConfig({ projectRoot, env });
  const telemetry = createTelemetryCollector({
    env,
    pilotHome,
    enabled: snapshot.config.telemetry?.enabled,
  });

  // Apply proxy from config (env-based proxy from top-level installGlobalProxy
  // takes precedence; this fills in when only sati.yaml has a proxy).
  if (snapshot.config.proxy?.url) {
    await installGlobalProxy(snapshot.config.proxy.url);
  }

  const state = createServerRuntimeState();
  const sessionOverrides = new SessionConfigOverrides();
  const subsystemBuilders = createSubsystemBuilders({ pilotHome, sessionOverrides, telemetry, state });
  const { cronLog } = subsystemBuilders;

  state.alwaysOn = subsystemBuilders.buildAlwaysOn(snapshot.config.alwaysOn);
  state.cron = subsystemBuilders.buildCron(snapshot.config.cron);

  const {
    gateway,
    configStore,
    dispose: disposeGateway,
    bindServer,
    isProjectBusy,
    updateSubsystems,
    sessionPresence,
    kanbanBoardManager,
  } = createLocalGateway({
    projectRoot,
    pilotHome,
    env,
    fallbackProjectRoot: pilotHome,
    extraTools: [...(state.alwaysOn?.getTools() ?? []), ...(state.cron?.getTools() ?? [])],
    sessionOverrides,
    cron: state.cron,
    telemetry,
  });

  const standaloneApply = createApplyHandler({
    gateway,
    pilotHome,
    sessionOverrides,
    alwaysOnConfig: snapshot.config.alwaysOn,
    telemetry,
    onTurnEvent: (sessionKey, channelKey, event) => {
      state.broadcast("always-on:turn-event", { sessionKey, channelKey, event });
    },
  });

  // Discovery-plan service wired into the gateway so the always_on_* protocol
  // methods (list plans / reports / cycles / archive / apply) are served from
  // the core instead of ui/server deep imports.
  const discoveryIo = createCoreDiscoveryPlanIo({ pilotHome });
  const discoveryPlanService = createDiscoveryPlanService({
    pilotHome,
    io: discoveryIo,
  });
  // Wire live session activity so plan execution status is real (the
  // gateway is the authoritative source for in-flight turns). The gateway
  // is an `InProcessGateway` at runtime; the protocol-level `Gateway` type
  // does not expose this host capability.
  const gatewayInstance = gateway as InProcessGateway;
  discoveryIo.isSessionActive = sessionId => gatewayInstance.isSessionActive(sessionId);

  if (state.alwaysOn) {
    state.alwaysOn.bindGateway(gateway, { isProjectBusy });
    await state.alwaysOn.start();
  }
  updateSubsystems({
    extraTools: [...(state.alwaysOn?.getTools() ?? []), ...(state.cron?.getTools() ?? [])],
    sessionOverrides,
    cron: state.cron,
    alwaysOnApply: state.alwaysOn ? input => state.alwaysOn!.applyCycle(input) : standaloneApply,
    alwaysOnRerunPlan: state.alwaysOn ? input => state.alwaysOn!.rerunPlan(input) : undefined,
    discoveryPlanService,
  });
  if (state.cron) {
    state.cron.bindGateway(gateway);
  }
  // cron 启动与后续 server 启动无依赖，并行执行以缩短启动时间。
  const cronStartPromise = state.cron ? state.cron.start() : Promise.resolve();

  // --- Subsystem hot-reload on config change ---

  let reloadChain = Promise.resolve();

  const channelStatePersistence = new ChannelStatePersistence({
    stateDir: resolve(pilotHome, "channels"),
  });
  const adapterHotReload = createAdapterHotReload({ state, persistence: channelStatePersistence });
  const subsystemReloader = createSubsystemReloader({
    pilotHome,
    sessionOverrides,
    telemetry,
    state,
    builders: subsystemBuilders,
    gateway: gatewayInstance,
    isProjectBusy,
    updateSubsystems,
    discoveryPlanService,
  });

  configStore.subscribe(event => {
    if (event.changedPaths.some(p => p.startsWith("telemetry.") || p === "telemetry")) {
      telemetry.setEnabled(event.nextSnapshot.config.telemetry?.enabled ?? false);
    }

    const aoChanged = event.changedPaths.some(p => p.startsWith("alwaysOn.") || p === "alwaysOn");
    const cronChanged = event.changedPaths.some(p => p.startsWith("cron.") || p === "cron");
    const proxyChanged = event.changedPaths.some(p => p.startsWith("proxy.") || p === "proxy");
    const adapterChanged = event.changedPaths.some(p => p.startsWith("adapters."));

    if (proxyChanged) {
      const proxyConfig = event.nextSnapshot.config.proxy;
      void reinstallGlobalProxy(proxyConfig?.url, proxyConfig?.noProxy);
    }

    if (adapterChanged) {
      reloadChain = reloadChain
        .then(() => adapterHotReload.handleAdapterHotReload(event.nextSnapshot.config))
        .catch(err => logger.warn(`adapter hot-reload failed: ${err instanceof Error ? err.message : String(err)}`));
    }

    if (!aoChanged && !cronChanged) return;

    reloadChain = reloadChain
      .then(() => subsystemReloader(aoChanged, cronChanged, event.nextSnapshot.config))
      .catch(err => logger.warn(`subsystem reload failed: ${err instanceof Error ? err.message : String(err)}`));
  });

  // --- Server startup ---

  const envPort = Number.parseInt(brandEnv(env, ENV_KEY.GATEWAY_PORT) ?? "", 10);
  const extraChannels = await loadEnabledChannels(snapshot.config.adapters);
  const feishuChannel = await buildFeishuChannel(snapshot.config.adapters, channelStatePersistence);
  const weixinChannel =
    snapshot.config.adapters?.weixin?.enabled === true ? await buildWeixinChannel(channelStatePersistence) : undefined;
  const qqChannel = await buildQqChannel(snapshot.config.adapters, channelStatePersistence);
  const wecomChannel = await buildWeComChannel(snapshot.config.adapters, channelStatePersistence);
  const allChannels = [...extraChannels, ...(wecomChannel ? [wecomChannel] : [])];
  // 与 cron 启动并行（两者互不依赖）。用 allSettled 而非 Promise.all：
  // 任一路失败时另一路的 rejection 已被消费（不产生 unhandled rejection），
  // 且各路错误独立记录，不会因先到者遮蔽后到者。
  const [serverResult, cronResult] = await Promise.allSettled([
    startSatiServer({
      gateway,
      port: readPort(argv) ?? (Number.isFinite(envPort) ? envPort : 19789),
      staticAssetsPath: resolve(projectRoot, "ui/dist"),
      presence: sessionPresence,
      kanban: kanbanBoardManager,
      feishu: feishuChannel,
      weixin: weixinChannel,
      qq: qqChannel,
      channels: allChannels,
      config: snapshot.config,
    }),
    cronStartPromise,
  ]);
  if (cronResult.status === "rejected") {
    cronLog.warn(
      `start failed: ${cronResult.reason instanceof Error ? cronResult.reason.message : String(cronResult.reason)}`,
    );
  }
  if (serverResult.status === "rejected") {
    throw serverResult.reason;
  }
  if (cronResult.status === "rejected") {
    // cron 失败但 server 已监听：关闭 server，避免退出后端口残留
    await serverResult.value.close().catch(() => {});
    throw cronResult.reason;
  }
  const server = serverResult.value;
  state.server = server;
  (
    gateway as {
      setPrepareWeixinLogin?: (
        handler: () => Promise<{ requested: boolean; requestedAt: string; reason?: "unsupported" }>,
      ) => void;
    }
  ).setPrepareWeixinLogin?.(async () => {
    const requestedAt = new Date().toISOString();
    if (!state.server) {
      return { requested: false, requestedAt, reason: "unsupported" };
    }
    // forceRelogin：UI「重新登录」按钮触发的 prepare_weixin_login 强制走扫码
    // 流程，不受残留（可能已失效）凭证影响，确保新二维码一定会生成。
    await adapterHotReload.hotStartWeixinChannel({ forceRelogin: true });
    return { requested: true, requestedAt };
  });
  bindServer(server);
  out.info(`Sati server listening: ${server.url}`);
  out.info(`WebSocket: ${server.wsUrl}`);
  if (server.tokenPath) {
    out.info(`Token: ${server.tokenPath}`);
  }
  installShutdownHandlers({
    telemetry,
    stop: createServerStop({ persistence: channelStatePersistence, telemetry, state, disposeGateway }),
  });
  await new Promise(() => undefined);
  return;
}
