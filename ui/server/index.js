#!/usr/bin/env node
// Load environment variables before other imports execute
import { assertRequiredSatiEnv } from "./load-env.js";
// Install global fetch proxy (SATI_PROXY / HTTPS_PROXY) before any network calls
import { installGlobalProxy } from "./utils/proxy.js";
installGlobalProxy();

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const installMode = fs.existsSync(path.join(__dirname, "..", "..", ".git")) ? "git" : "npm";

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

assertRequiredSatiEnv();
console.log("SERVER_PORT from runtime config:", process.env.SERVER_PORT);

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import bcrypt from "bcrypt";
import crypto from "crypto";
import os from "os";
import http from "http";
import cors from "cors";
import { promises as fsPromises } from "fs";
import { spawn } from "child_process";
// Uses the global fetch (Node >= 22); the node-fetch dependency was removed.
import mime from "mime-types";
import JSZip from "jszip";
import { getOpenUrlSpawnCommand } from "./utils/processSpawn.js";

import { extractProjectDirectory } from "./projects.js";
import { approvalListPendingViaGateway, getSessionTokenBudget } from "./sati-bridge.js";
import gitRoutes from "./routes/git.js";
import authRoutes from "./routes/auth.js";
import mcpRoutes from "./routes/mcp.js";
import taskmasterRoutes from "./routes/taskmaster.js";
import memoryRoutes from "./routes/memory.js";
import mcpUtilsRoutes from "./routes/mcp-utils.js";
import commandsRoutes from "./routes/commands.js";
import skillsRoutes from "./routes/skills.js";
import settingsRoutes from "./routes/settings.js";
import configRoutes from "./routes/config.js";
import gatewayRoutes from "./routes/gateway.js";
import { startSatiConfigWatcher, stopSatiConfigWatcher } from "./services/satiConfigWatcher.js";
import agentRoutes from "./routes/agent.js";
import updateRoutes from "./routes/update.js";
import projectsRoutes, { WORKSPACES_ROOT, validateWorkspacePath } from "./routes/projects.js";
import userRoutes from "./routes/user.js";
import pluginsRoutes from "./routes/plugins.js";
import messagesRoutes from "./routes/messages.js";
import {
  addDirectoryToZip,
  getSafeZipFilename,
  permToRwx,
  setPreviewContentType,
  validateFilename,
} from "./services/filesystem.js";
import projectPreviewRoutes from "./routes/project-preview.js";
import projectUploadsRoutes from "./routes/project-uploads.js";
import projectFilesRoutes from "./routes/project-files.js";
import projectSessionsRoutes from "./routes/project-sessions.js";
import systemRoutes from "./routes/system.js";
import { closeMemoryServices, startMemoryScheduler, stopMemoryScheduler } from "./services/memoryService.js";
import { startEnabledPluginServers, stopAllPlugins, getPluginPort } from "./utils/plugin-process-manager.js";
import { initializeDatabase, userDb } from "./database/db.js";
import { configureWebPush } from "./services/vapid-keys.js";

import { runServerStartupBeforeListen, startServerAfterStartup } from "./services/server-startup.js";
import { validateApiKey, authenticateToken } from "./middleware/auth.js";
import { DISABLE_LOCAL_AUTH, IS_PLATFORM } from "./constants/config.js";
import { getConnectableHost } from "../shared/networkHosts.js";
import { contentDispositionAttachment } from "./utils/downloadHeaders.js";
import { setupProjectsWatcher } from "./services/projects-watcher.js";
import { handleShellConnection } from "./websocket/shell.js";
import { createChatWebSocketServer } from "./websocket/chat.js";

// Sati-only mode: chat execution always goes through src/gateway via
// cursor-cli, openai-codex, gemini-cli) has been removed.

const app = express();
const server = http.createServer(app);

// Single WebSocket server that handles both paths（wss 创建见 ./websocket/chat.js）
const wss = createChatWebSocketServer(server);
app.locals.wss = wss;

app.use(cors({ exposedHeaders: ["X-Refreshed-Token"] }));
app.use(
  express.json({
    limit: "50mb",
    type: req => {
      // Skip multipart/form-data requests (for file uploads like images)
      const contentType = req.headers["content-type"] || "";
      if (contentType.includes("multipart/form-data")) {
        return false;
      }
      return contentType.includes("json");
    },
  }),
);
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Public health check endpoint (no authentication required)
// Optional API key validation (if configured)
app.use("/api", validateApiKey);

// Authentication routes (public)
app.use("/api/auth", authRoutes);

// Projects API Routes (protected)
app.use("/api/projects", authenticateToken, projectsRoutes);

// Git API Routes (protected)
app.use("/api/git", authenticateToken, gitRoutes);

// MCP API Routes (protected)
app.use("/api/mcp", authenticateToken, mcpRoutes);

// TaskMaster API Routes (protected)
app.use("/api/taskmaster", authenticateToken, taskmasterRoutes);

// Memory API Routes (protected)
app.use("/api/memory", authenticateToken, memoryRoutes);

// MCP utilities
app.use("/api/mcp-utils", authenticateToken, mcpUtilsRoutes);

// Commands API Routes (protected)
app.use("/api/commands", authenticateToken, commandsRoutes);

// Skills API Routes (protected) — list/edit/install skills surfaced in the
// top-right Skills tab. Backed by bundled skills, ~/.sati/skills/, and
// project-level .sati/skills/ via Sati plugin runtime.
app.use("/api/skills", authenticateToken, skillsRoutes);

// Settings API Routes (protected)
app.use("/api/settings", authenticateToken, settingsRoutes);

// Sati unified YAML config routes (protected)
app.use("/api/config", authenticateToken, configRoutes);

// Gateway IM channel setup routes (protected)
app.use("/api/gateway", authenticateToken, gatewayRoutes);

// User API Routes (protected)
app.use("/api/user", authenticateToken, userRoutes);

// Plugins API Routes (protected)
app.use("/api/plugins", authenticateToken, pluginsRoutes);

// Unified session messages route (protected) — Sati-only.
app.use("/api/sessions", authenticateToken, messagesRoutes);

// Agent API Routes (uses API key authentication)
app.use("/api/agent", agentRoutes);

// Self-update API Routes (protected)
app.use("/api/update", authenticateToken, updateRoutes);

// The runtime model is read from ~/.sati/sati.yaml. Enumerate every
// configured provider/model pair so the chat composer can render real
// model options instead of a hardcoded stub. On a fresh install (no
// sati.yaml yet) the lists come back empty and the UI shows the
// "configure a model first" state rather than a fake model name.
// Sati routing dashboard. The `/api/ccr/*` URL family was kept for
// frontend back-compat (Dashboard tab + useRouterSettings) but the data
// now comes from `src/router/stats/TokenStatsCollector` via the

// 系统路由（health/ccr/always-on/memory-dashboard，见 ./routes/system.js）
app.use(systemRoutes);
// Serve public files (like api-docs.html)
app.use(express.static(path.join(__dirname, "../public")));

// Static files served after API routes
// Add cache control: HTML files should not be cached, but assets can be cached
app.use(
  express.static(path.join(__dirname, "../dist"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        // Prevent HTML caching to avoid service worker issues after builds
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
        // Cache static assets for 1 year (they have hashed names)
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }),
);

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs.
// /api/system/update was the V1 "Update available" banner backend; the
// VersionUpgradeModal that consumed it was removed during the V1 cleanup.

app.use(projectSessionsRoutes);
app.use(projectFilesRoutes);
app.use(projectPreviewRoutes);
app.use(projectUploadsRoutes);
app.get("/api/projects/:projectName/sessions/:sessionId/token-usage", authenticateToken, async (req, res) => {
  try {
    const { projectName, sessionId } = req.params;
    const { provider = "sati" } = req.query;
    const homeDir = os.homedir();

    // Sati sessions use `web:s_<uuid>` keys; Windows-safe sessions
    // may use `web-s_<uuid>` because ':' is illegal in Windows filenames.
    if (provider === "sati" || /^web[:_-]s_/.test(sessionId)) {
      return res.json(getSessionTokenBudget(sessionId));
    }

    // Allow only safe characters in sessionId
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safeSessionId || safeSessionId !== String(sessionId)) {
      return res.status(400).json({ error: "Invalid sessionId" });
    }

    // Handle Cursor sessions - they use SQLite and don't have token usage info
    if (provider === "cursor") {
      return res.json({
        used: 0,
        total: 0,
        breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
        unsupported: true,
        message: "Token usage tracking not available for Cursor sessions",
      });
    }

    // Handle Gemini sessions - they are raw logs in our current setup
    if (provider === "gemini") {
      return res.json({
        used: 0,
        total: 0,
        breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
        unsupported: true,
        message: "Token usage tracking not available for Gemini sessions",
      });
    }

    // Handle Codex sessions
    if (provider === "codex") {
      const codexSessionsDir = path.join(homeDir, ".codex", "sessions");

      // Find the session file by searching for the session ID
      const findSessionFile = async dir => {
        try {
          const entries = await fsPromises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const found = await findSessionFile(fullPath);
              if (found) return found;
            } else if (entry.name.includes(safeSessionId) && entry.name.endsWith(".jsonl")) {
              return fullPath;
            }
          }
        } catch (error) {
          // Skip directories we can't read
        }
        return null;
      };

      const sessionFilePath = await findSessionFile(codexSessionsDir);

      if (!sessionFilePath) {
        return res.status(404).json({ error: "Codex session file not found", sessionId: safeSessionId });
      }

      // Read and parse the Codex JSONL file
      let fileContent;
      try {
        fileContent = await fsPromises.readFile(sessionFilePath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          return res.status(404).json({ error: "Session file not found", path: sessionFilePath });
        }
        throw error;
      }
      const lines = fileContent.trim().split("\n");
      let totalTokens = 0;
      let contextWindow = 200000; // Default for Codex/OpenAI

      // Find the latest token_count event with info (scan from end)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);

          // Codex stores token info in event_msg with type: "token_count"
          if (entry.type === "event_msg" && entry.payload?.type === "token_count" && entry.payload?.info) {
            const tokenInfo = entry.payload.info;
            if (tokenInfo.total_token_usage) {
              totalTokens = tokenInfo.total_token_usage.total_tokens || 0;
            }
            if (tokenInfo.model_context_window) {
              contextWindow = tokenInfo.model_context_window;
            }
            break; // Stop after finding the latest token count
          }
        } catch (parseError) {
          // Skip lines that can't be parsed
          continue;
        }
      }

      return res.json({
        used: totalTokens,
        total: contextWindow,
      });
    }

    // Extract actual project path
    let projectPath;
    try {
      projectPath = await extractProjectDirectory(projectName);
    } catch (error) {
      console.error("Error extracting project directory:", error);
      return res.status(500).json({ error: "Failed to determine project path" });
    }

    const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, "-");
    const projectDir = path.join(homeDir, ".sati", "projects", encodedPath);

    const jsonlPath = path.join(projectDir, `${safeSessionId}.jsonl`);

    // Constrain to projectDir
    const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return res.status(400).json({ error: "Invalid path" });
    }

    // Read and parse the JSONL file
    let fileContent;
    try {
      fileContent = await fsPromises.readFile(jsonlPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return res.status(404).json({ error: "Session file not found", path: jsonlPath });
      }
      throw error; // Re-throw other errors to be caught by outer try-catch
    }
    const lines = fileContent.trim().split("\n");

    const parsedContextWindow = parseInt(process.env.CONTEXT_WINDOW, 10);
    const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160000;
    let inputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    // Find the latest assistant message with usage data (scan from end)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);

        // Only count assistant messages which have usage data
        if (entry.type === "assistant" && entry.message?.usage) {
          const usage = entry.message.usage;

          // Use token counts from latest assistant message only
          inputTokens = usage.input_tokens || 0;
          cacheCreationTokens = usage.cache_creation_input_tokens || 0;
          cacheReadTokens = usage.cache_read_input_tokens || 0;

          break; // Stop after finding the latest assistant message
        }
      } catch (parseError) {
        // Skip lines that can't be parsed
        continue;
      }
    }

    // Calculate total context usage (excluding output_tokens, as per ccusage)
    const totalUsed = inputTokens + cacheCreationTokens + cacheReadTokens;

    res.json({
      used: totalUsed,
      total: contextWindow,
      breakdown: {
        input: inputTokens,
        cacheCreation: cacheCreationTokens,
        cacheRead: cacheReadTokens,
      },
    });
  } catch (error) {
    console.error("Error reading session token usage:", error);
    res.status(500).json({ error: "Failed to read session token usage" });
  }
});

// Serve React app for all other routes (excluding static files)
app.get("/{*splat}", (req, res) => {
  // Skip requests for actual static asset extensions only
  const ext = path.extname(req.path);
  if (ext && /^\.(js|css|map|json|ico|png|jpg|jpeg|gif|svg|webp|woff2?|ttf|eot|mp4|webm)$/.test(ext)) {
    return res.status(404).send("Not found");
  }

  // Only serve index.html for HTML routes, not for static assets
  // Static assets should already be handled by express.static middleware above
  const indexPath = path.join(__dirname, "../dist/index.html");

  // Check if dist/index.html exists (production build available)
  if (fs.existsSync(indexPath)) {
    // Set no-cache headers for HTML to prevent service worker issues
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(indexPath);
  } else {
    // In development, redirect to Vite dev server only if dist doesn't exist
    const redirectHost = getConnectableHost(req.hostname);
    res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
  }
});

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
async function startServer() {
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
