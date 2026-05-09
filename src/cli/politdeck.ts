#!/usr/bin/env node
import { resolve } from "node:path";
import { createAlwaysOnRuntime, type AlwaysOnRuntime } from "../always-on/index.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../gateway/index.js";
import { CliChannel, TuiChannel, FeishuChannel } from "../adapters/index.js";
import { loadPolitConfig, resolvePolitHome } from "../polit/index.js";
import { createLocalGateway } from "./createLocalGateway.js";
import { startPolitDeckServer } from "./politdeckServer.js";

async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command === "server") {
    const projectRoot = process.cwd();
    const env = process.env;
    const politHome = resolvePolitHome(env);
    const snapshot = loadPolitConfig({ projectRoot, env });

    let alwaysOn: AlwaysOnRuntime | undefined;
    if (snapshot.config.alwaysOn) {
      alwaysOn = createAlwaysOnRuntime({
        config: snapshot.config.alwaysOn,
        politHome,
        projectKey: projectRoot,
        logger: {
          info: (message, data) =>
            console.log(`[always-on] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
          warn: (message, data) =>
            console.warn(`[always-on] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`),
        },
      });
    }

    const gateway = createLocalGateway({
      projectRoot,
      politHome,
      env,
      extraTools: alwaysOn?.getTools(),
      sessionOverrides: alwaysOn?.getSessionOverrides(),
    });

    if (alwaysOn) {
      alwaysOn.bindGateway(gateway);
      await alwaysOn.start();
    }

    const server = await startPolitDeckServer({
      gateway,
      port: readPort(argv) ?? 18789,
      staticAssetsPath: resolve(projectRoot, "ui/dist"),
      feishu: new FeishuChannel(),
    });
    console.log(`PolitDeck server listening: ${server.url}`);
    console.log(`WebSocket: ${server.wsUrl}`);
    if (server.tokenPath) {
      console.log(`Token: ${server.tokenPath}`);
    }
    const stop = async () => {
      try {
        await alwaysOn?.stop();
      } catch (error) {
        console.warn(`[always-on] stop failed: ${error instanceof Error ? error.message : String(error)}`);
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

  if (command === "tui") {
    if (!process.stdin.isTTY) {
      console.error("politdeck tui requires an interactive terminal.");
      process.exitCode = 1;
      return;
    }
    const fallbackGateway = createFallbackGateway();
    try {
      const local = createLocalGateway({ projectRoot: process.cwd() });
      await new TuiChannel({
        projectKey: process.cwd(),
        cwd: process.cwd(),
        model: "PolitDeck",
      }).start({ gateway: local });
    } catch (error) {
      await new TuiChannel({
        projectKey: process.cwd(),
        cwd: process.cwd(),
        model: "PolitDeck",
      }).start({ gateway: fallbackGateway });
    }
    return;
  }

  const fallbackGateway = createLocalGateway({ projectRoot: process.cwd() });
  await new CliChannel({ argv, projectKey: process.cwd() }).start({ gateway: fallbackGateway });
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

function createFallbackGateway(): Gateway {
  async function* errorStream(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    yield {
      type: "error",
      code: "local_gateway_unavailable",
      message: `No PolitDeck server is available and local config could not start session ${input.sessionKey}.`,
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
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
