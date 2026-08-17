#!/usr/bin/env node
import { debugLog } from "../shared/debug.js";
import { APP_VERSION } from "../version.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../gateway/index.js";
import type { InProcessGateway } from "../gateway/client/InProcessGateway.js";
import type { AlwaysOnManager, AlwaysOnConfig } from "../always-on/index.js";
import type { CronManager, CronConfig } from "../cron/index.js";
import type {
  FeishuSessionMapperState,
  WeixinSessionMapperState,
  QQSessionMapperState,
  WeComSessionMapperState,
} from "../adapters/index.js";
import type {
  SkillMigrationConflictMode,
  SkillMigrationItem,
  SkillMigrationReport,
  SkillMigrationSourceKind,
} from "../extension/skills/index.js";

function printUsage(): void {
  console.log(`sati v${APP_VERSION} — AI agent runtime · CLI · TUI · Web · Feishu

Usage: sati [command] [options]

Commands:
  (none)                        Interactive CLI chat (default)
  tui                           Interactive terminal UI (requires a TTY)
  server                        Start the sati server (gateway + web)
  gateway setup <channel>       Set up an IM channel (feishu|weixin|wecom)
  config set <key.path> <value> Set a nested config value in sati.yaml
  config delete <key.path>      Delete a nested config value from sati.yaml
  cron <list|create|delete|stop> Manage cron tasks (requires a running server)
  chat                          Search chat history
  browsers [--doctor] [--json]  Probe browser backends (ego lite / BrowserOS neo / browser-use / @playwright/mcp)
  skills migrate                Migrate skills from other agents
  update [--check|--restart]    Update sati from the git remote

Options:
  -v, --version                 Print the application version
  -h, --help                    Show this help message`);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command === "--version" || command === "-v") {
    console.log(APP_VERSION);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return;
  }
  if (command === "server") {
    const { resolve } = await import("node:path");
    const { brandEnv, ENV_KEY } = await import("../env.js");
    const { createAlwaysOnManager, createApplyHandler, SessionConfigOverrides, createDiscoveryPlanService } =
      await import("../always-on/index.js");
    const { createCronManager } = await import("../cron/index.js");
    const {
      FeishuChannel,
      WeixinChannel,
      QQChannel,
      WeComChannel,
      loadEnabledChannels,
      ChannelStatePersistence,
      FeishuSessionMapper,
      WeixinSessionMapper,
      QQSessionMapper,
      WeComSessionMapper,
      setUpdateRestartHandler,
    } = await import("../adapters/index.js");
    const { loadPilotConfig, resolvePilotHome } = await import("../pilot/index.js");
    const { createTelemetryCollector } = await import("../telemetry/index.js");
    const { createLocalGateway } = await import("./createLocalGateway.js");
    const { createCoreDiscoveryPlanIo } = await import("./discoveryIo.js");
    const { startSatiServer } = await import("./satiServer.js");
    const { installGlobalProxy, reinstallGlobalProxy } = await import("./proxy.js");
    const { createShutdownAndExit } = await import("./shutdownCoordinator.js");
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

    let alwaysOn: AlwaysOnManager | undefined;
    let cron: CronManager | undefined;
    // eslint-disable-next-line prefer-const -- assigned once later; closures above reference the binding before assignment
    let deferredBroadcast: ((name: string, payload?: unknown) => void) | undefined;
    const sessionOverrides = new SessionConfigOverrides();

    const alwaysOnLogger = {
      info: (message: string, data?: Record<string, unknown>) =>
        console.log(`[always-on] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
      warn: (message: string, data?: Record<string, unknown>) =>
        console.warn(`[always-on] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
      debug: (message: string, data?: Record<string, unknown>) =>
        debugLog(`[always-on] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
    };
    const cronLogger = {
      info: (message: string, data?: Record<string, unknown>) =>
        console.log(`[cron] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
      warn: (message: string, data?: Record<string, unknown>) =>
        console.warn(`[cron] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
    };

    function buildAlwaysOn(config: AlwaysOnConfig | undefined): AlwaysOnManager | undefined {
      if (!config?.enabled) return undefined;
      return createAlwaysOnManager({
        config,
        pilotHome,
        sessionOverrides,
        logger: alwaysOnLogger,
        telemetry,
        onWorktreeCreated: (runId, cwd) => {
          deferredBroadcast?.("worktree_created", { runId, cwd });
        },
        onWorktreeRemoved: cwd => {
          deferredBroadcast?.("worktree_removed", { cwd });
        },
        onTurnEvent: (sessionKey, channelKey, event) => {
          deferredBroadcast?.("always-on:turn-event", { sessionKey, channelKey, event });
        },
      });
    }

    function buildCron(config: CronConfig | undefined): CronManager | undefined {
      if (!config) return undefined;
      return createCronManager({
        config,
        pilotHome,
        sessionOverrides,
        logger: cronLogger,
        telemetry,
        onTurnEvent: (sessionKey, channelKey, event) => {
          deferredBroadcast?.("cron:turn-event", { sessionKey, channelKey, event });
        },
        onResultDelivery: delivery => {
          void serverRef
            ?.deliverCronResult(delivery)
            .then(delivered => {
              if (!delivered) {
                console.warn(`[cron] result delivery was not handled task=${delivery.taskId} run=${delivery.runId}`);
              }
            })
            .catch((error: unknown) => {
              console.warn(`[cron] result delivery failed ${error instanceof Error ? error.message : String(error)}`);
            });
        },
      });
    }

    alwaysOn = buildAlwaysOn(snapshot.config.alwaysOn);
    cron = buildCron(snapshot.config.cron);

    const {
      gateway,
      configStore,
      dispose: disposeGateway,
      bindServer,
      isProjectBusy,
      updateSubsystems,
    } = createLocalGateway({
      projectRoot,
      pilotHome,
      env,
      fallbackProjectRoot: pilotHome,
      extraTools: [...(alwaysOn?.getTools() ?? []), ...(cron?.getTools() ?? [])],
      sessionOverrides,
      cron,
      telemetry,
    });

    const standaloneApply = createApplyHandler({
      gateway,
      pilotHome,
      sessionOverrides,
      alwaysOnConfig: snapshot.config.alwaysOn,
      telemetry,
      onTurnEvent: (sessionKey, channelKey, event) => {
        deferredBroadcast?.("always-on:turn-event", { sessionKey, channelKey, event });
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

    if (alwaysOn) {
      alwaysOn.bindGateway(gateway, { isProjectBusy });
      await alwaysOn.start();
    }
    updateSubsystems({
      extraTools: [...(alwaysOn?.getTools() ?? []), ...(cron?.getTools() ?? [])],
      sessionOverrides,
      cron,
      alwaysOnApply: alwaysOn ? input => alwaysOn!.applyCycle(input) : standaloneApply,
      alwaysOnRerunPlan: alwaysOn ? input => alwaysOn!.rerunPlan(input) : undefined,
      discoveryPlanService,
    });
    if (cron) {
      cron.bindGateway(gateway);
    }
    // cron 启动与后续 server 启动无依赖，并行执行以缩短启动时间。
    const cronStartPromise = cron ? cron.start() : Promise.resolve();

    // --- Subsystem hot-reload on config change ---

    let reloadChain = Promise.resolve();

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
          .then(() => handleAdapterHotReload(event.nextSnapshot.config))
          .catch(err =>
            console.warn(`[sati] adapter hot-reload failed: ${err instanceof Error ? err.message : String(err)}`),
          );
      }

      if (!aoChanged && !cronChanged) return;

      reloadChain = reloadChain
        .then(() => handleSubsystemReload(aoChanged, cronChanged, event.nextSnapshot.config))
        .catch(err =>
          console.warn(`[sati] subsystem reload failed: ${err instanceof Error ? err.message : String(err)}`),
        );
    });

    async function handleSubsystemReload(
      aoChanged: boolean,
      cronChanged: boolean,
      config: (typeof snapshot)["config"],
    ): Promise<void> {
      if (aoChanged) {
        await alwaysOn?.stop();
        alwaysOn = undefined;
      }
      if (cronChanged) {
        await cron?.stop();
        cron = undefined;
      }

      if (aoChanged) alwaysOn = buildAlwaysOn(config.alwaysOn);
      if (cronChanged) cron = buildCron(config.cron);

      if (aoChanged && alwaysOn) {
        alwaysOn.bindGateway(gateway, { isProjectBusy });
        await alwaysOn.start();
      }

      const fallbackApply = createApplyHandler({
        gateway,
        pilotHome,
        sessionOverrides,
        alwaysOnConfig: config.alwaysOn,
        telemetry,
        onTurnEvent: (sessionKey, channelKey, event) => {
          deferredBroadcast?.("always-on:turn-event", { sessionKey, channelKey, event });
        },
      });

      updateSubsystems({
        extraTools: [...(alwaysOn?.getTools() ?? []), ...(cron?.getTools() ?? [])],
        sessionOverrides,
        cron,
        alwaysOnApply: alwaysOn ? input => alwaysOn!.applyCycle(input) : fallbackApply,
        alwaysOnRerunPlan: alwaysOn ? input => alwaysOn!.rerunPlan(input) : undefined,
        discoveryPlanService,
      });
      if (cronChanged && cron) {
        cron.bindGateway(gateway);
        await cron.start();
      }

      const parts: string[] = [];
      if (aoChanged) parts.push(`always-on=${alwaysOn ? "started" : "stopped"}`);
      if (cronChanged) parts.push(`cron=${cron ? "started" : "stopped"}`);
      console.log(`[sati] Subsystem hot-reload complete: ${parts.join(", ")}`);
    }

    // --- Channel state persistence ---

    const channelStatePersistence = new ChannelStatePersistence({
      stateDir: resolve(pilotHome, "channels"),
    });

    // --- Adapter hot-reload ---

    // eslint-disable-next-line prefer-const -- assigned once later; closures above reference the binding before assignment
    let serverRef: Awaited<ReturnType<typeof startSatiServer>> | undefined;

    async function hotStartWeixinChannel(options: { forceRelogin?: boolean } = {}): Promise<void> {
      if (!serverRef) return;
      const savedWeixin = await channelStatePersistence.load<WeixinSessionMapperState>("weixin");
      await serverRef.hotStartChannel(
        new WeixinChannel({
          forceRelogin: options.forceRelogin ?? false,
          mapper: savedWeixin ? new WeixinSessionMapper(savedWeixin) : undefined,
          onStateChange: state => channelStatePersistence.save("weixin", state),
        }),
      );
    }

    async function handleAdapterHotReload(config: (typeof snapshot)["config"]): Promise<void> {
      if (!serverRef) return;
      const parts: string[] = [];

      const fCfg = config.adapters?.feishu;
      if (fCfg?.enabled === true) {
        const savedFeishu = await channelStatePersistence.load<FeishuSessionMapperState>("feishu");
        const ch = new FeishuChannel({
          appId: fCfg.appId,
          appSecret: fCfg.appSecret,
          encryptKey: fCfg.encryptKey,
          verifyToken: fCfg.verifyToken,
          connectionMode: fCfg.connectionMode,
          domainName: fCfg.domainName,
          mapper: savedFeishu ? new FeishuSessionMapper(savedFeishu) : undefined,
          onStateChange: state => channelStatePersistence.save("feishu", state),
        });
        await serverRef.hotStartChannel(ch);
        parts.push("feishu=started");
      }

      const wCfg = config.adapters?.weixin;
      if (wCfg?.enabled === true) {
        await hotStartWeixinChannel();
        parts.push("weixin=started");
      }

      const qqCfg = config.adapters?.qq;
      if (qqCfg?.enabled === true) {
        const savedQQ = await channelStatePersistence.load<QQSessionMapperState>("qq");
        await serverRef.hotStartChannel(
          new QQChannel({
            appId: qqCfg.appId,
            clientSecret: qqCfg.clientSecret,
            allowGroups: qqCfg.allowGroups,
            triggerPrefixes: qqCfg.triggerPrefixes,
            maxMessageLength: qqCfg.maxMessageLength,
            mapper: savedQQ ? new QQSessionMapper(savedQQ) : undefined,
            onStateChange: state => channelStatePersistence.save("qq", state),
          }),
        );
        parts.push("qq=started");
      }

      const wcCfg = config.adapters?.wecom;
      if (wcCfg?.enabled === true) {
        const savedWeCom = await channelStatePersistence.load<WeComSessionMapperState>("wecom");
        await serverRef.hotStartChannel(
          new WeComChannel({
            botKey: wcCfg.token,
            extra: wcCfg.extra,
            mapper: savedWeCom ? new WeComSessionMapper(savedWeCom) : undefined,
            onStateChange: state => channelStatePersistence.save("wecom", state),
          }),
        );
        parts.push("wecom=started");
      }

      const extraChannels = await loadEnabledChannels(config.adapters);
      for (const ch of extraChannels) {
        await serverRef.hotStartChannel(ch);
        parts.push(`${ch.channelKey}=started`);
      }

      if (parts.length) {
        console.log(`[sati] Adapter hot-reload complete: ${parts.join(", ")}`);
      }
    }

    // --- Server startup ---

    const envPort = Number.parseInt(brandEnv(env, ENV_KEY.GATEWAY_PORT) ?? "", 10);
    const extraChannels = await loadEnabledChannels(snapshot.config.adapters);
    const feishuCfg = snapshot.config.adapters?.feishu;
    const savedFeishuState = await channelStatePersistence.load<FeishuSessionMapperState>("feishu");
    const feishuChannel =
      feishuCfg?.enabled === true
        ? new FeishuChannel({
            appId: feishuCfg.appId,
            appSecret: feishuCfg.appSecret,
            encryptKey: feishuCfg.encryptKey,
            verifyToken: feishuCfg.verifyToken,
            connectionMode: feishuCfg.connectionMode,
            domainName: feishuCfg.domainName,
            mapper: savedFeishuState ? new FeishuSessionMapper(savedFeishuState) : undefined,
            onStateChange: state => channelStatePersistence.save("feishu", state),
          })
        : undefined;
    const weixinCfg = snapshot.config.adapters?.weixin;
    const savedWeixinState = await channelStatePersistence.load<WeixinSessionMapperState>("weixin");
    const weixinChannel =
      weixinCfg?.enabled === true
        ? new WeixinChannel({
            mapper: savedWeixinState ? new WeixinSessionMapper(savedWeixinState) : undefined,
            onStateChange: state => channelStatePersistence.save("weixin", state),
          })
        : undefined;
    const qqCfg = snapshot.config.adapters?.qq;
    const savedQQState = await channelStatePersistence.load<QQSessionMapperState>("qq");
    const qqChannel =
      qqCfg?.enabled === true
        ? new QQChannel({
            appId: qqCfg.appId,
            clientSecret: qqCfg.clientSecret,
            allowGroups: qqCfg.allowGroups,
            triggerPrefixes: qqCfg.triggerPrefixes,
            maxMessageLength: qqCfg.maxMessageLength,
            mapper: savedQQState ? new QQSessionMapper(savedQQState) : undefined,
            onStateChange: state => channelStatePersistence.save("qq", state),
          })
        : undefined;
    const wecomCfg = snapshot.config.adapters?.wecom;
    const savedWeComState = await channelStatePersistence.load<WeComSessionMapperState>("wecom");
    const wecomChannel =
      wecomCfg?.enabled === true
        ? new WeComChannel({
            botKey: wecomCfg.token,
            extra: wecomCfg.extra,
            mapper: savedWeComState ? new WeComSessionMapper(savedWeComState) : undefined,
            onStateChange: state => channelStatePersistence.save("wecom", state),
          })
        : undefined;
    const allChannels = [...extraChannels, ...(wecomChannel ? [wecomChannel] : [])];
    // 与 cron 启动并行（两者互不依赖）。用 allSettled 而非 Promise.all：
    // 任一路失败时另一路的 rejection 已被消费（不产生 unhandled rejection），
    // 且各路错误独立记录，不会因先到者遮蔽后到者。
    const [serverResult, cronResult] = await Promise.allSettled([
      startSatiServer({
        gateway,
        port: readPort(argv) ?? (Number.isFinite(envPort) ? envPort : 19789),
        staticAssetsPath: resolve(projectRoot, "ui/dist"),
        feishu: feishuChannel,
        weixin: weixinChannel,
        qq: qqChannel,
        channels: allChannels,
        config: snapshot.config,
      }),
      cronStartPromise,
    ]);
    if (cronResult.status === "rejected") {
      console.warn(
        `[cron] start failed: ${cronResult.reason instanceof Error ? cronResult.reason.message : String(cronResult.reason)}`,
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
    serverRef = server;
    (
      gateway as {
        setPrepareWeixinLogin?: (
          handler: () => Promise<{ requested: boolean; requestedAt: string; reason?: "unsupported" }>,
        ) => void;
      }
    ).setPrepareWeixinLogin?.(async () => {
      const requestedAt = new Date().toISOString();
      if (!serverRef) {
        return { requested: false, requestedAt, reason: "unsupported" };
      }
      // forceRelogin：UI「重新登录」按钮触发的 prepare_weixin_login 强制走扫码
      // 流程，不受残留（可能已失效）凭证影响，确保新二维码一定会生成。
      await hotStartWeixinChannel({ forceRelogin: true });
      return { requested: true, requestedAt };
    });
    bindServer(server);
    deferredBroadcast = (name, payload) => server.broadcastNotification(name, payload);
    console.log(`Sati server listening: ${server.url}`);
    console.log(`WebSocket: ${server.wsUrl}`);
    if (server.tokenPath) {
      console.log(`Token: ${server.tokenPath}`);
    }
    const stop = async () => {
      try {
        await channelStatePersistence.flush();
        console.log(`[telemetry] shutdown snapshot ${JSON.stringify(telemetry.snapshot())}`);
        disposeGateway();
        await alwaysOn?.stop();
        await cron?.stop();
        await telemetry.shutdown();
      } catch (error) {
        console.warn(`[runtime] stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const shutdownAndExit = createShutdownAndExit(stop, exitCode => process.exit(exitCode));
    process.on("uncaughtException", error => {
      telemetry.trackError(error, { module: "runtime", metadata: { source: "uncaughtException" } });
      void shutdownAndExit(1);
    });
    process.on("unhandledRejection", reason => {
      telemetry.trackError(reason, { module: "runtime", metadata: { source: "unhandledRejection" } });
      void shutdownAndExit(1);
    });
    process.on("SIGINT", () => {
      void shutdownAndExit(0);
    });
    process.on("SIGTERM", () => {
      void shutdownAndExit(0);
    });
    await new Promise(() => undefined);
    return;
  }

  if (command === "gateway") {
    const sub = argv[1];
    if (sub === "setup") {
      const { runGatewaySetup } = await import("./commands/gatewaySetup.js");
      await runGatewaySetup(argv.slice(2));
      return;
    }
    console.error("Usage: sati gateway setup [feishu|weixin|wecom]");
    process.exitCode = 1;
    return;
  }

  if (command === "config") {
    const { runConfigCommand } = await import("./commands/configSet.js");
    await runConfigCommand(argv.slice(1));
    return;
  }

  if (command === "cron") {
    await handleCronCommand(argv.slice(1));
    return;
  }

  if (command === "update") {
    await handleUpdateCommand(argv.slice(1));
    return;
  }

  if (command === "skills") {
    await handleSkillsCommand(argv.slice(1));
    return;
  }

  if (command === "browsers") {
    const { runBrowserBackendProbes, formatBrowserBackendMatrix } = await import("./commands/browserBackends.js");
    const probes = await runBrowserBackendProbes({
      doctorCheck: argv.includes("--doctor"),
    });
    if (argv.includes("--json")) {
      console.log(JSON.stringify(probes, null, 2));
      return;
    }
    console.log(formatBrowserBackendMatrix(probes));
    return;
  }

  if (command === "chat") {
    const { runChatSearchCli } = await import("./commands/chatSearch.js");
    await runChatSearchCli(argv.slice(1));
    return;
  }

  if (command === "patent-search") {
    const { main: runPatentSearchCli } = await import("./commands/patentSearch.js");
    process.exitCode = await runPatentSearchCli(argv.slice(1));
    return;
  }

  if (command === "tui") {
    if (!process.stdin.isTTY) {
      console.error("sati tui requires an interactive terminal.");
      process.exitCode = 1;
      return;
    }
    const { loadPilotConfig } = await import("../pilot/index.js");
    const { connectRemoteGatewayIfAvailable } = await import("../gateway/client/index.js");
    const { TuiChannel } = await import("../adapters/channel/tui/TuiChannel.js");
    const { sanitizeSessionIdForPath } = await import("../session/index.js");
    const { installGlobalProxy } = await import("./proxy.js");

    // 读取 gateway 端口以探测运行中的 server；本地配置不完整（如模型
    // provider 未配置）不应阻止 TUI 连接远端 server，故此处容错回退默认端口。
    let gatewayPort = 19789;
    try {
      const snapshot = loadPilotConfig({ projectRoot: process.cwd() });
      gatewayPort = snapshot.config.gateway?.port ?? 19789;
    } catch (error) {
      console.warn(
        `[sati] 读取 gateway 端口失败，回退默认 ${gatewayPort}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const probeUrl = `http://127.0.0.1:${gatewayPort}`;
    // 先探测已运行的 sati server；命中时无需在当前进程构建完整本地 gateway。
    const remote = await connectRemoteGatewayIfAvailable({ url: probeUrl });
    if (remote) {
      try {
        await new TuiChannel({
          projectKey: process.cwd(),
          cwd: process.cwd(),
          model: "Sati",
          mode: "remote",
          serverUrl: probeUrl,
        }).start({ gateway: remote });
        return;
      } catch (error) {
        // 远端启动失败（如握手后崩溃）：回退本地 gateway，恢复自动探测的兜底语义。
        console.warn(
          `[sati] 连接远端 server 失败，回退本地 gateway: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await installGlobalProxy();
    const fallbackGateway = createFallbackGateway(sanitizeSessionIdForPath);
    try {
      const { createLocalGateway } = await import("./createLocalGateway.js");
      const { gateway: local } = createLocalGateway({ projectRoot: process.cwd() });
      await new TuiChannel({
        projectKey: process.cwd(),
        cwd: process.cwd(),
        model: "Sati",
        mode: "in_process",
      }).start({ gateway: local });
    } catch {
      await new TuiChannel({
        projectKey: process.cwd(),
        cwd: process.cwd(),
        model: "Sati",
        mode: "in_process",
      }).start({ gateway: fallbackGateway });
    }
    return;
  }

  const { createLocalGateway } = await import("./createLocalGateway.js");
  const { CliChannel } = await import("../adapters/channel/cli/CliChannel.js");
  const { installGlobalProxy } = await import("./proxy.js");
  await installGlobalProxy();
  const { gateway: fallbackGateway } = createLocalGateway({ projectRoot: process.cwd() });
  await new CliChannel({ argv, projectKey: process.cwd() }).start({ gateway: fallbackGateway });
}

async function handleUpdateCommand(argv: string[]): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const { resolve: resolvePath, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const __filename = fileURLToPath(import.meta.url);
  const projectRoot = resolvePath(dirname(__filename), "..", "..", "..");
  const scriptPath = resolvePath(projectRoot, "scripts", "update.sh");

  const doRestart = argv.includes("--restart");
  const checkOnly = argv.includes("--check");

  if (checkOnly) {
    try {
      const branch =
        execFileSync("git", ["branch", "--show-current"], { cwd: projectRoot, encoding: "utf-8" }).trim() || "main";
      execFileSync("git", ["fetch", "origin", branch], { cwd: projectRoot, encoding: "utf-8", stdio: "pipe" });
      const local = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf-8" }).trim();
      const remote = execFileSync("git", ["rev-parse", `origin/${branch}`], {
        cwd: projectRoot,
        encoding: "utf-8",
      }).trim();

      if (local === remote) {
        console.log(`Already up-to-date (${local.slice(0, 8)}) on branch ${branch}`);
      } else {
        const countStr = execFileSync("git", ["rev-list", "--count", `HEAD..origin/${branch}`], {
          cwd: projectRoot,
          encoding: "utf-8",
        }).trim();
        console.log(`Update available: ${countStr} new commit(s) on branch ${branch}`);
        console.log(`  local:  ${local.slice(0, 8)}`);
        console.log(`  remote: ${remote.slice(0, 8)}`);
        const log = execFileSync("git", ["log", "--oneline", `HEAD..origin/${branch}`, "-5"], {
          cwd: projectRoot,
          encoding: "utf-8",
        }).trim();
        if (log) {
          console.log("\nRecent commits:");
          console.log(log);
        }
      }
    } catch (e: unknown) {
      console.error(`Failed to check for updates: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
    return;
  }

  const args = doRestart ? [scriptPath, "--restart"] : [scriptPath];

  try {
    execFileSync("bash", args, {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, FORCE_COLOR: "1" },
    });
  } catch (e: unknown) {
    const err = e as { status?: number };
    if (err.status === 2) {
      // Already up-to-date — not an error
      return;
    }
    console.error(`Update failed with exit code ${err.status ?? "unknown"}`);
    process.exitCode = 1;
  }
}

async function handleCronCommand(argv: string[]): Promise<void> {
  const { connectRemoteGatewayIfAvailable } = await import("../gateway/client/index.js");
  const gateway = await connectRemoteGatewayIfAvailable();
  if (!gateway) {
    console.error("sati cron requires a running sati server.");
    process.exitCode = 1;
    return;
  }
  const command = argv[0];
  if (command === "list") {
    const result = await gateway.cronList({
      includeHistory: argv.includes("--history"),
      limit: readNumberFlag(argv, "--limit"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "create") {
    const message = readStringFlag(argv, "--message");
    const sessionKey = readStringFlag(argv, "--session");
    const once = readStringFlag(argv, "--once");
    const cron = readStringFlag(argv, "--cron");
    if (!message || !sessionKey || (!once && !cron)) {
      console.error("Usage: sati cron create --session <sessionKey> --message <text> (--once <iso> | --cron <expr>)");
      process.exitCode = 1;
      return;
    }
    const result = await gateway.cronCreate({
      message,
      sessionKey,
      channelKey: readStringFlag(argv, "--channel") ?? inferChannelKey(sessionKey),
      projectKey: readStringFlag(argv, "--project") ?? process.cwd(),
      schedule: once ? { type: "once", runAt: once } : { type: "cron", expression: cron! },
      timezone: readStringFlag(argv, "--timezone"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "delete") {
    const taskId = argv[1] ?? readStringFlag(argv, "--task");
    if (!taskId) {
      console.error("Usage: sati cron delete <taskId> [--stop-running]");
      process.exitCode = 1;
      return;
    }
    const result = await gateway.cronDelete({ taskId, stopRunning: argv.includes("--stop-running") });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "stop") {
    const taskId = argv[1] ?? readStringFlag(argv, "--task");
    const runId = readStringFlag(argv, "--run");
    if (!taskId && !runId) {
      console.error("Usage: sati cron stop <taskId> or sati cron stop --run <runId>");
      process.exitCode = 1;
      return;
    }
    const result = await gateway.cronStop({ taskId, runId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.error("Usage: sati cron <list|create|delete|stop>");
  process.exitCode = 1;
}

async function handleSkillsCommand(argv: string[]): Promise<void> {
  const { migrateSkillsToSati } = await import("../extension/skills/index.js");
  const { resolvePilotHome } = await import("../pilot/index.js");
  const command = argv[0];
  if (command !== "migrate") {
    console.error(
      "Usage: sati skills migrate [--execute] [--from cc,openclaw,hermes] [--source <dir>] [--overwrite|--rename]",
    );
    process.exitCode = 1;
    return;
  }

  const from = parseSkillMigrationSources(readStringFlag(argv, "--from"));
  const conflictMode: SkillMigrationConflictMode = argv.includes("--overwrite")
    ? "overwrite"
    : argv.includes("--rename")
      ? "rename"
      : "skip";
  const projectRoot = readStringFlag(argv, "--project") ?? process.cwd();
  const pilotHome = readStringFlag(argv, "--pilot-home") ?? resolvePilotHome(process.env);
  const report = await migrateSkillsToSati({
    pilotHome,
    projectRoot,
    include: from,
    customSources: readRepeatedStringFlag(argv, "--source"),
    execute: argv.includes("--execute"),
    conflictMode,
  });

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printSkillMigrationReport(report);
  if (report.summary.error > 0) {
    process.exitCode = 1;
  }
}

function parseSkillMigrationSources(
  value: string | undefined,
): Array<Exclude<SkillMigrationSourceKind, "custom">> | undefined {
  if (!value) return undefined;
  const sources: Array<Exclude<SkillMigrationSourceKind, "custom">> = [];
  for (const raw of value.split(",")) {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized === "cc" || normalized === "claude" || normalized === "claude-code") {
      sources.push("claude-code");
    } else if (normalized === "openclaw") {
      sources.push("openclaw");
    } else if (normalized === "hermes") {
      sources.push("hermes");
    } else if (normalized === "all") {
      sources.push("claude-code", "openclaw", "hermes");
    } else {
      throw new Error(`Unknown skills source "${raw}". Use cc, openclaw, hermes, or all.`);
    }
  }
  return sources.length > 0 ? [...new Set(sources)] : undefined;
}

function printSkillMigrationReport(report: SkillMigrationReport): void {
  const mode = report.mode === "execute" ? "EXECUTED" : "DRY RUN";
  console.log(`Sati skills migration (${mode})`);
  console.log(`Target: ${report.targetRoot}`);
  console.log(
    `Summary: migrated=${report.summary.migrated} would_migrate=${report.summary.would_migrate} ` +
      `conflict=${report.summary.conflict} skipped=${report.summary.skipped} error=${report.summary.error}`,
  );

  const actionable = report.items.filter(item => item.status !== "skipped");
  if (actionable.length > 0) {
    console.log("");
    for (const item of actionable) {
      console.log(`${formatSkillMigrationStatus(item)} ${item.sourceLabel}: ${item.slug || "(n/a)"}`);
      console.log(`  ${item.sourcePath}`);
      if (item.destinationPath) console.log(`  -> ${item.destinationPath}`);
      if (item.reason) console.log(`  ${item.reason}`);
    }
  }

  if (report.mode === "dry-run") {
    console.log("");
    console.log("This was a dry run. Add --execute to copy skills.");
  }
}

function formatSkillMigrationStatus(item: SkillMigrationItem): string {
  if (item.status === "migrated") return "+";
  if (item.status === "would_migrate") return "?";
  if (item.status === "conflict") return "!";
  if (item.status === "error") return "x";
  return "-";
}

function readPort(argv: string[]): number | undefined {
  const index = argv.indexOf("--port");
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  const port = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(port) ? port : undefined;
}

function readStringFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readRepeatedStringFlag(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) values.push(value);
  }
  return values;
}

function readNumberFlag(argv: string[], flag: string): number | undefined {
  const value = readStringFlag(argv, flag);
  if (!value) {
    return undefined;
  }
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : undefined;
}

function inferChannelKey(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator > 0 ? sessionKey.slice(0, separator) : "cli";
}

function createFallbackGateway(sanitizeSessionIdForPath: (sessionId: string) => string): Gateway {
  async function* errorStream(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    yield {
      type: "error",
      code: "local_gateway_unavailable",
      message: `No Sati server is available and local config could not start session ${input.sessionKey}.`,
      recoverable: false,
    };
  }
  return {
    submitTurn: errorStream,
    abortTurn: async () => undefined,
    listSessions: async () => ({ sessions: [] }),
    resumeSession: async input => input,
    newSession: async input => ({
      // 与磁盘 transcript 文件名一致（sanitize 幂等），避免会话列表
      // sessionId（磁盘文件名）与 gateway sessionKey 双编码失配。
      sessionKey: sanitizeSessionIdForPath(`${input.channelKey}:project=${input.projectKey ?? process.cwd()}:s_local`),
    }),
    closeSession: async () => undefined,
    describeServer: async () => ({ mode: "in_process" }),
    cronCreate: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronUpdate: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronList: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronDelete: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronStop: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    cronRunNow: async () => {
      throw new Error("Cron runtime is not configured.");
    },
    respondElicitation: async () => ({ delivered: false }),
    permissionDecide: async () => ({ delivered: false }),
    grantSessionPermission: async () => ({ granted: false }),
    readSessionMessages: async () => {
      throw new Error("read_session_messages is not configured.");
    },
    readSubagentMessages: async () => {
      throw new Error("read_subagent_messages is not configured.");
    },
    forkSession: async () => {
      throw new Error("fork_session is not configured.");
    },
    listProjects: async () => ({ projects: [] }),
    describeProject: async input => ({
      projectKey: input.projectKey,
      name: input.projectKey,
      fullPath: input.projectKey,
      sessionCount: 0,
    }),
  };
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
