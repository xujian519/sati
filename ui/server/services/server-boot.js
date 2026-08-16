/**
 * ui/server 启动引导（B6 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：端口常量/回退监听/
 * 本地用户引导/startServer 编排/优雅关闭。
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { spawn } from "child_process";
import { getConnectableHost } from "../../shared/networkHosts.js";
import { getOpenUrlSpawnCommand } from "../utils/processSpawn.js";
import { initializeDatabase, userDb } from "../database/db.js";
import { configureWebPush } from "./vapid-keys.js";
import { runServerStartupBeforeListen, startServerAfterStartup } from "./server-startup.js";
import { setupProjectsWatcher } from "./projects-watcher.js";
import { closeMemoryServices, startMemoryScheduler, stopMemoryScheduler } from "./memoryService.js";
import { startEnabledPluginServers, stopAllPlugins } from "../utils/plugin-process-manager.js";
import { startSatiConfigWatcher, stopSatiConfigWatcher } from "./satiConfigWatcher.js";
import { DISABLE_LOCAL_AUTH } from "../constants/config.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// ANSI color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  dim: "\x1b[2m",
};

const c = {
  info: text => `${colors.cyan}${text}${colors.reset}`,
  ok: text => `${colors.green}${text}${colors.reset}`,
  warn: text => `${colors.yellow}${text}${colors.reset}`,
  tip: text => `${colors.blue}${text}${colors.reset}`,
  bright: text => `${colors.bright}${text}${colors.reset}`,
  dim: text => `${colors.dim}${text}${colors.reset}`,
};

// Helper function to convert permissions to rwx format
const SERVER_PORT = process.env.SERVER_PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;

const PORT_FALLBACK_ATTEMPTS = 5;

// Pick a random high port in the 20000–59999 range. Random (rather than the
// preferred port + 1) because adjacent ports are frequently held by the same
// multi-port app that already took the preferred one.
function pickRandomHighPort() {
  return 20000 + Math.floor(Math.random() * 40000);
}

// Listen on `preferredPort`; on EADDRINUSE retry on random high ports up to
// PORT_FALLBACK_ATTEMPTS times. Resolves with the actually-bound port, or null
// if every attempt was in use. Non-EADDRINUSE errors reject — real failures
// (bad host, permissions) must not be silently retried.
function listenWithPortFallback(srv, preferredPort, host) {
  let port = preferredPort;
  let attempt = 0;
  return new Promise((resolve, reject) => {
    const tryListen = () => {
      attempt += 1;
      const onError = err => {
        srv.removeListener("listening", onListening);
        if (err && err.code === "EADDRINUSE") {
          if (attempt >= PORT_FALLBACK_ATTEMPTS) {
            resolve(null);
            return;
          }
          const nextPort = pickRandomHighPort();
          console.log(
            `${c.warn("[WARN]")} Port ${port} is in use; retrying on random port ${nextPort} (attempt ${attempt}/${PORT_FALLBACK_ATTEMPTS})...`,
          );
          port = nextPort;
          setImmediate(tryListen);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        srv.removeListener("error", onError);
        resolve(srv.address().port);
      };
      srv.once("error", onError);
      srv.once("listening", onListening);
      srv.listen(port, host);
    };
    tryListen();
  });
}

async function ensureLocalUserWhenAuthDisabled() {
  if (!DISABLE_LOCAL_AUTH || userDb.hasUsers()) {
    return;
  }
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
  userDb.createUser("local", passwordHash);
  console.log(
    `${c.info("[INFO]")} Web UI login is disabled (default). Using built-in user. Set SATI_DISABLE_LOCAL_AUTH=0 to require username/password.`,
  );
}

// Initialize database and start server
async function startServer(server) {
  try {
    await startServerAfterStartup({
      startupFn: async () => {
        await runServerStartupBeforeListen({
          initializeDatabaseFn: initializeDatabase,
          ensureLocalUserWhenAuthDisabledFn: ensureLocalUserWhenAuthDisabled,
          configureWebPushFn: configureWebPush,
        });
      },
      listenFn: async () => {
        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(__dirname, "../dist/index.html");
        const isProduction = fs.existsSync(distIndexPath);

        console.log(`${c.info("[INFO]")} Chat execution routed through Sati gateway (src/gateway).`);
        console.log("");

        if (isProduction) {
          console.log(`${c.info("[INFO]")} Starting in production mode...`);
        } else {
          console.log(
            `${c.info("[INFO]")} No production frontend build found; development mode expects Vite at http://${DISPLAY_HOST}:${VITE_PORT}`,
          );
        }

        const boundPort = await listenWithPortFallback(server, Number(SERVER_PORT), HOST);
        if (boundPort === null) {
          console.error(
            `${c.warn("[ERROR]")} Could not bind a port after ${PORT_FALLBACK_ATTEMPTS} attempts (preferred ${SERVER_PORT}). All tried ports were in use. Set SERVER_PORT to a free port and retry.`,
          );
          process.exit(1);
        }
        // Sync the actually-bound port back to the env so other modules
        // that self-reference SERVER_PORT (e.g. routes/taskmaster.js) hit
        // the right port after a fallback.
        process.env.SERVER_PORT = String(boundPort);
        {
          const appInstallPath = path.join(__dirname, "..");

          console.log("");
          console.log(c.dim("═".repeat(63)));
          console.log(`  ${c.bright("Sati Server - Ready")}`);
          console.log(c.dim("═".repeat(63)));
          console.log("");
          console.log(`${c.info("[INFO]")} Server URL:  ${c.bright("http://" + DISPLAY_HOST + ":" + boundPort)}`);
          console.log(`${c.info("[INFO]")} Installed at: ${c.dim(appInstallPath)}`);
          console.log(`${c.tip("[TIP]")}  Run "sati status" for full configuration details`);
          console.log("");

          // Desktop shell loads the UI inside Electron; CLI/dev can opt in to
          // auto-open. SATI_DESKTOP=1 is set by apps/desktop server-manager.
          const skipAutoOpen = process.env.SATI_DESKTOP === "1" || process.env.SATI_SKIP_BROWSER_OPEN === "1";
          if (!skipAutoOpen) {
            const serverUrl = `http://${DISPLAY_HOST === "0.0.0.0" ? "localhost" : DISPLAY_HOST}:${boundPort}`;
            const { command, args } = getOpenUrlSpawnCommand(serverUrl);
            const opener = spawn(command, args, {
              stdio: "ignore",
              detached: process.platform !== "win32",
              windowsHide: process.platform === "win32",
            });
            opener.on("error", () => {});
            opener.unref();
          }

          // Start watching the projects folder for changes
          await setupProjectsWatcher();

          // Start background memory scheduler for auto index/dream.
          startMemoryScheduler();

          // Start server-side plugin processes for enabled plugins
          startEnabledPluginServers().catch(err => {
            console.error("[Plugins] Error during startup:", err.message);
          });

          // Hot-reload watcher: external edits to ~/.sati/sati.yaml
          // (vim, Cursor, another process) trigger a validate+reload and push
          // a "config:reloaded" event to every connected WebSocket client.
          await startSatiConfigWatcher({
            onEvent: payload => {
              process.emit("sati:config-broadcast", payload);
            },
          });
        }
      },
    });

    let shutdownPromise = null;
    const gracefulShutdown = async () => {
      if (shutdownPromise) {
        return shutdownPromise;
      }

      shutdownPromise = (async () => {
        try {
          stopMemoryScheduler();
          closeMemoryServices();
          stopSatiConfigWatcher();
          await stopAllPlugins();
          // helpers were retired with the four-provider runtime.
          try {
            const { shutdownGlobalChrome, stopChromeHealthCheck } = await import("./utils/globalChrome.js");
            stopChromeHealthCheck();
            shutdownGlobalChrome();
          } catch {
            /* Chrome may not have been started */
          }
          // Sati cron is owned by `sati server` and shuts
          // down with it; ui/server never spawns its own daemon.
        } finally {
          process.exit(0);
        }
      })();

      return shutdownPromise;
    };
    process.on("SIGTERM", () => void gracefulShutdown());
    process.on("SIGINT", () => void gracefulShutdown());
  } catch (error) {
    console.error("[ERROR] Failed to start server:", error);
    process.exit(1);
  }
}

startServer();

export { startServer };
