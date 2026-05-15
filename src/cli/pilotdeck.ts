#!/usr/bin/env node
import { resolve } from "node:path";
import { createAlwaysOnManager, type AlwaysOnManager, type AlwaysOnConfig } from "../always-on/index.js";
import { createCronRuntime, type CronRuntime, type CronConfig } from "../cron/index.js";
import { connectRemoteGatewayIfAvailable, type Gateway, type GatewayEvent, type GatewaySubmitTurnInput } from "../gateway/index.js";
import { CliChannel, TuiChannel, FeishuChannel } from "../adapters/index.js";
import { loadPilotConfig, resolvePilotHome } from "../pilot/index.js";
import { createLocalGateway } from "./createLocalGateway.js";
import { startPilotDeckServer } from "./pilotdeckServer.js";
import { installGlobalProxy } from "./proxy.js";

installGlobalProxy();

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command === "server") {
    const projectRoot = process.cwd();
    const env = process.env;
    const pilotHome = resolvePilotHome(env);
    const snapshot = loadPilotConfig({ projectRoot, env });

    let alwaysOn: AlwaysOnManager | undefined;
    let cron: CronRuntime | undefined;
    let deferredBroadcast: ((name: string, payload?: unknown) => void) | undefined;

    const alwaysOnLogger = {
      info: (message: string, data?: Record<string, unknown>) =>
        console.log(`[always-on] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
      warn: (message: string, data?: Record<string, unknown>) =>
        console.warn(`[always-on] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
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
        logger: alwaysOnLogger,
        onWorktreeCreated: (runId, cwd) => {
          deferredBroadcast?.("worktree_created", { runId, cwd });
        },
        onWorktreeRemoved: (cwd) => {
          deferredBroadcast?.("worktree_removed", { cwd });
        },
        onTurnEvent: (sessionKey, channelKey, event) => {
          deferredBroadcast?.("always-on:turn-event", { sessionKey, channelKey, event });
        },
      });
    }

    function buildCron(config: CronConfig | undefined): CronRuntime | undefined {
      if (!config) return undefined;
      return createCronRuntime({
        config,
        pilotHome,
        projectKey: projectRoot,
        logger: cronLogger,
      });
    }

    alwaysOn = buildAlwaysOn(snapshot.config.alwaysOn);
    cron = buildCron(snapshot.config.cron);

    const {
      gateway, configStore, dispose: disposeGateway,
      bindServer, isProjectBusy, updateSubsystems,
    } = createLocalGateway({
      projectRoot,
      pilotHome,
      env,
      extraTools: [...(alwaysOn?.getTools() ?? []), ...(cron?.getTools() ?? [])],
      sessionOverrides: alwaysOn?.getSessionOverrides(),
      cron,
    });

    if (alwaysOn) {
      alwaysOn.bindGateway(gateway, { isProjectBusy });
      await alwaysOn.start();
      updateSubsystems({
        extraTools: [...(alwaysOn?.getTools() ?? []), ...(cron?.getTools() ?? [])],
        sessionOverrides: alwaysOn?.getSessionOverrides(),
        cron,
        alwaysOnApply: (input) => alwaysOn!.applyPlan(input),
      });
    }
    if (cron) {
      cron.bindGateway(gateway);
      await cron.start();
    }

    // --- Subsystem hot-reload on config change ---

    let reloadChain = Promise.resolve();

    configStore.subscribe((event) => {
      const aoChanged = event.changedPaths.some((p) => p.startsWith("alwaysOn."));
      const cronChanged = event.changedPaths.some((p) => p.startsWith("cron."));
      if (!aoChanged && !cronChanged) return;

      reloadChain = reloadChain
        .then(() => handleSubsystemReload(aoChanged, cronChanged, event.nextSnapshot.config))
        .catch((err) =>
          console.warn(
            `[pilotdeck] subsystem reload failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
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

      updateSubsystems({
        extraTools: [...(alwaysOn?.getTools() ?? []), ...(cron?.getTools() ?? [])],
        sessionOverrides: alwaysOn?.getSessionOverrides(),
        cron,
        alwaysOnApply: alwaysOn ? (input) => alwaysOn!.applyPlan(input) : undefined,
      });
      if (cronChanged && cron) {
        cron.bindGateway(gateway);
        await cron.start();
      }

      const parts: string[] = [];
      if (aoChanged) parts.push(`always-on=${alwaysOn ? "started" : "stopped"}`);
      if (cronChanged) parts.push(`cron=${cron ? "started" : "stopped"}`);
      console.log(`[pilotdeck] Subsystem hot-reload complete: ${parts.join(", ")}`);
    }

    // --- Server startup ---

    const envPort = Number.parseInt(env.PILOTDECK_GATEWAY_PORT ?? "", 10);
    const server = await startPilotDeckServer({
      gateway,
      port: readPort(argv) ?? (Number.isFinite(envPort) ? envPort : 18789),
      staticAssetsPath: resolve(projectRoot, "ui/dist"),
      feishu: new FeishuChannel(),
    });
    bindServer(server);
    deferredBroadcast = (name, payload) => server.broadcastNotification(name, payload);
    console.log(`PilotDeck server listening: ${server.url}`);
    console.log(`WebSocket: ${server.wsUrl}`);
    if (server.tokenPath) {
      console.log(`Token: ${server.tokenPath}`);
    }
    const stop = async () => {
      try {
        disposeGateway();
        await alwaysOn?.stop();
        await cron?.stop();
      } catch (error) {
        console.warn(`[runtime] stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    process.on("SIGINT", () => {
      void stop().finally(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      void stop().finally(() => process.exit(0));
    });
    await new Promise(() => undefined);
    return;
  }

  if (command === "cron") {
    await handleCronCommand(argv.slice(1));
    return;
  }

  if (command === "tui") {
    if (!process.stdin.isTTY) {
      console.error("pilotdeck tui requires an interactive terminal.");
      process.exitCode = 1;
      return;
    }
    const snapshot = loadPilotConfig({ projectRoot: process.cwd() });
    const gatewayPort = snapshot.config.gateway?.port ?? 18789;
    const probeUrl = `http://127.0.0.1:${gatewayPort}`;
    const fallbackGateway = createFallbackGateway();
    try {
      const { gateway: local } = createLocalGateway({ projectRoot: process.cwd() });
      await new TuiChannel({
        projectKey: process.cwd(),
        cwd: process.cwd(),
        model: "PilotDeck",
        probe: { url: probeUrl },
      }).start({ gateway: local });
    } catch (error) {
      await new TuiChannel({
        projectKey: process.cwd(),
        cwd: process.cwd(),
        model: "PilotDeck",
        probe: { url: probeUrl },
      }).start({ gateway: fallbackGateway });
    }
    return;
  }

  const { gateway: fallbackGateway } = createLocalGateway({ projectRoot: process.cwd() });
  await new CliChannel({ argv, projectKey: process.cwd() }).start({ gateway: fallbackGateway });
}

async function handleCronCommand(argv: string[]): Promise<void> {
  const gateway = await connectRemoteGatewayIfAvailable();
  if (!gateway) {
    console.error("pilotdeck cron requires a running pilotdeck server.");
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
      console.error("Usage: pilotdeck cron create --session <sessionKey> --message <text> (--once <iso> | --cron <expr>)");
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
      console.error("Usage: pilotdeck cron delete <taskId> [--stop-running]");
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
      console.error("Usage: pilotdeck cron stop <taskId> or pilotdeck cron stop --run <runId>");
      process.exitCode = 1;
      return;
    }
    const result = await gateway.cronStop({ taskId, runId });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.error("Usage: pilotdeck cron <list|create|delete|stop>");
  process.exitCode = 1;
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

function createFallbackGateway(): Gateway {
  async function* errorStream(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    yield {
      type: "error",
      code: "local_gateway_unavailable",
      message: `No PilotDeck server is available and local config could not start session ${input.sessionKey}.`,
      recoverable: false,
    };
  }
  return {
    submitTurn: errorStream,
    abortTurn: async () => undefined,
    listSessions: async () => ({ sessions: [] }),
    resumeSession: async (input) => input,
    newSession: async (input) => ({ sessionKey: `${input.channelKey}:project=${input.projectKey ?? process.cwd()}:s_local` }),
    closeSession: async () => undefined,
    describeServer: async () => ({ mode: "in_process" }),
    cronCreate: async () => {
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
    listProjects: async () => ({ projects: [] }),
    describeProject: async (input) => ({
      projectKey: input.projectKey,
      name: input.projectKey,
      fullPath: input.projectKey,
      sessionCount: 0,
    }),
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
