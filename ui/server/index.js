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
import pty from "node-pty";
// Uses the global fetch (Node >= 22); the node-fetch dependency was removed.
import mime from "mime-types";
import JSZip from "jszip";
import { readPermissionSettings } from "./services/permissionSettings.js";
import { getSplatPath } from "./utils/splatPath.js";
import { getDefaultPtyShell } from "./utils/defaultShell.js";
import { getOpenUrlSpawnCommand } from "./utils/processSpawn.js";

import {
  getProjects,
  getProjectCronJobsOverview,
  getSessions,
  renameProject,
  deleteSession,
  deleteProject,
  addProjectManually,
  extractProjectDirectory,
  clearProjectDirectoryCache,
  searchConversations,
} from "./projects.js";
import {
  runChatViaGateway,
  abortViaGateway,
  decidePermissionViaGateway,
  approvalDecideViaGateway,
  approvalListPendingViaGateway,
  grantSessionPermissionViaGateway,
  getSessionActivityViaGateway,
  getActiveSessionIdsViaGateway,
  elicitationRespondViaGateway,
  getRouterDashboardData,
  getRouterSessionStats,
  getRouterStatsSummary,
  getSatiGateway,
  getSessionTokenBudget,
} from "./sati-bridge.js";
import sessionManager from "./sessionManager.js";
import gitRoutes from "./routes/git.js";
import authRoutes from "./routes/auth.js";
import mcpRoutes from "./routes/mcp.js";
import taskmasterRoutes from "./routes/taskmaster.js";
import memoryRoutes, { MEMORY_DASHBOARD_DIR } from "./routes/memory.js";
import mcpUtilsRoutes from "./routes/mcp-utils.js";
import commandsRoutes from "./routes/commands.js";
import skillsRoutes from "./routes/skills.js";
import settingsRoutes from "./routes/settings.js";
import configRoutes from "./routes/config.js";
import gatewayRoutes from "./routes/gateway.js";
import {
  OFFICE_PREVIEW_SERVICE_BUILTIN,
  OFFICE_PREVIEW_SERVICE_LIBREOFFICE,
  convertOfficeDocumentToPdf,
  getConfiguredOfficePreviewService,
  getLibreOfficeCandidateStatuses,
  getLibreOfficeStatus,
} from "./services/officePreview.js";
import {
  SPREADSHEET_PREVIEW_EXTENSIONS,
  getSpreadsheetInteractivePreview,
  getSpreadsheetPreviewManifest,
  getSpreadsheetSheetPreviewPdf,
} from "./services/spreadsheetPreview.js";
import { startSatiConfigWatcher, stopSatiConfigWatcher } from "./services/satiConfigWatcher.js";
import { readSatiConfigFile } from "./services/satiConfig.js";
import { getAlwaysOnDashboardEvents } from "./services/always-on-events.js";
import agentRoutes from "./routes/agent.js";
import updateRoutes from "./routes/update.js";
import projectsRoutes, { WORKSPACES_ROOT, validateWorkspacePath } from "./routes/projects.js";
import userRoutes from "./routes/user.js";
import pluginsRoutes from "./routes/plugins.js";
import messagesRoutes from "./routes/messages.js";
import {
  OFFICE_PDF_PREVIEW_EXTENSIONS,
  addDirectoryToZip,
  expandWorkspacePath,
  getFileExtension,
  getFileTree,
  getSafeZipFilename,
  getWindowsDriveSuggestions,
  isWindowsDriveBrowserRoot,
  permToRwx,
  resolvePathInProject,
  setPreviewContentType,
  sha256File,
  streamFileWithRange,
  validateFilename,
  validatePathInProject,
} from "./services/filesystem.js";
import { uploadFilesHandler } from "./services/uploads.js";
import { officePreviewPdfRateLimiter, officePreviewStatusRateLimiter } from "./services/rate-limit.js";
import {
  broadcastChatFrame,
  broadcastConfigReloaded,
  broadcastProgress,
  broadcastToSessionWatchers,
  connectedClients,
  normalizeSessionId,
  sessionWatchRegistry,
} from "./websocket/broadcast.js";
import {
  closeMemoryServices,
  resolveManagedMemoryFile,
  startMemoryScheduler,
  stopMemoryScheduler,
} from "./services/memoryService.js";
import { createNormalizedMessage } from "./sati-message.js";
import { startEnabledPluginServers, stopAllPlugins, getPluginPort } from "./utils/plugin-process-manager.js";
import { initializeDatabase, sessionNamesDb, applyCustomSessionNames, userDb } from "./database/db.js";
import { configureWebPush } from "./services/vapid-keys.js";

import { runServerStartupBeforeListen, startServerAfterStartup } from "./services/server-startup.js";
import { validateApiKey, authenticateToken, authenticateWebSocket } from "./middleware/auth.js";
import { DISABLE_LOCAL_AUTH, IS_PLATFORM } from "./constants/config.js";
import { getConnectableHost } from "../shared/networkHosts.js";
import { contentDispositionAttachment } from "./utils/downloadHeaders.js";
import { setupProjectsWatcher } from "./services/projects-watcher.js";

// Sati-only mode: chat execution always goes through src/gateway via
// cursor-cli, openai-codex, gemini-cli) has been removed.
const VALID_PROVIDERS = ["sati"];

const app = express();
const server = http.createServer(app);

const ptySessionsMap = new Map();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
const ANSI_ESCAPE_SEQUENCE_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
const TRAILING_URL_PUNCTUATION_REGEX = /[)\]}>.,;:!?]+$/;

function stripAnsiSequences(value = "") {
  return value.replace(ANSI_ESCAPE_SEQUENCE_REGEX, "");
}

function normalizeDetectedUrl(url) {
  if (!url || typeof url !== "string") return null;

  const cleaned = url.trim().replace(TRAILING_URL_PUNCTUATION_REGEX, "");
  if (!cleaned) return null;

  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function extractUrlsFromText(value = "") {
  const directMatches = value.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/gi) || [];

  // Handle wrapped terminal URLs split across lines by terminal width.
  const wrappedMatches = [];
  const continuationRegex = /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/;
  const lines = value.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const startMatch = line.match(/https?:\/\/[^\s<>"'`\\\x1b\x07]+/i);
    if (!startMatch) continue;

    let combined = startMatch[0];
    let j = i + 1;
    while (j < lines.length) {
      const continuation = lines[j].trim();
      if (!continuation) break;
      if (!continuationRegex.test(continuation)) break;
      combined += continuation;
      j++;
    }

    wrappedMatches.push(combined.replace(/\r?\n\s*/g, ""));
  }

  return Array.from(new Set([...directMatches, ...wrappedMatches]));
}

function shouldAutoOpenUrlFromOutput(value = "") {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("browser didn't open") ||
    normalized.includes("open this url") ||
    normalized.includes("continue in your browser") ||
    normalized.includes("press enter to open") ||
    normalized.includes("open_url:")
  );
}

// Single WebSocket server that handles both paths
const wss = new WebSocketServer({
  server,
  verifyClient: info => {
    console.log("WebSocket connection attempt to:", info.req.url);

    // Platform / no-login mode: allow connection without token
    if (IS_PLATFORM || DISABLE_LOCAL_AUTH) {
      const user = authenticateWebSocket(null); // Returns first DB user
      if (!user) {
        console.log("[WARN] WebSocket auth bypass: No user found in database");
        return false;
      }
      info.req.user = user;
      console.log("[OK] WebSocket authenticated (bypass) for user:", user.username);
      return true;
    }

    // Normal mode: verify token
    // Extract token from query parameters or headers
    const url = new URL(info.req.url, "http://localhost");
    const token = url.searchParams.get("token") || info.req.headers.authorization?.split(" ")[1];

    // Verify token
    const user = authenticateWebSocket(token);
    if (!user) {
      console.log("[WARN] WebSocket authentication failed");
      return false;
    }

    // Store user info in the request for later use
    info.req.user = user;
    console.log("[OK] WebSocket authenticated for user:", user.username);
    return true;
  },
});

// Make WebSocket server available to routes
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
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    installMode,
  });
});

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
app.get("/api/agents/runtime-config", authenticateToken, (_req, res) => {
  const permSettings = readPermissionSettings();
  const permissions = {
    skipPermissions: permSettings.skipPermissions,
    effectiveMode: permSettings.skipPermissions ? "bypassPermissions" : "default",
  };
  // readSatiConfigFile can throw synchronously (EACCES on the config file,
  // a directory at the config path, …). Degrade to an empty model list
  // instead of 500-ing and dropping the permissions payload the composer
  // also needs.
  let availableModels = [];
  let defaultModel = "";
  try {
    const record = readSatiConfigFile();
    const providers = record.config?.model?.providers;
    if (providers && typeof providers === "object") {
      for (const [pid, prov] of Object.entries(providers)) {
        if (!prov || typeof prov !== "object") continue;
        // models must be a record (id → model config); a YAML array has no
        // usable model refs and Object.keys on it would yield indices.
        if (!prov.models || typeof prov.models !== "object" || Array.isArray(prov.models)) continue;
        for (const mid of Object.keys(prov.models)) {
          availableModels.push({ value: `${pid}/${mid}`, label: `${pid}/${mid}` });
        }
      }
    }
    defaultModel = typeof record.config?.agent?.model === "string" ? record.config.agent.model.trim() : "";
  } catch (error) {
    console.error("[runtime-config] failed to read sati.yaml:", error instanceof Error ? error.message : error);
  }
  res.json({
    sati: {
      provider: "sati",
      defaultModel,
      availableModels,
    },
    permissions,
  });
});

// Provider-specific endpoints removed by the Sati-only migration.
// Returning a structured error keeps any stragglers in the UI from
// hanging on an unanswered fetch.
const PROVIDER_REMOVED_PATHS = ["/api/cursor", "/api/codex", "/api/gemini", "/api/cli"];
for (const removedPrefix of PROVIDER_REMOVED_PATHS) {
  app.use(removedPrefix, (_req, res) => {
    res.status(410).json({
      error: "endpoint_removed",
      message: `Provider endpoint ${removedPrefix} was removed during the Sati-only migration.`,
    });
  });
}

// Sati routing dashboard. The `/api/ccr/*` URL family was kept for
// frontend back-compat (Dashboard tab + useRouterSettings) but the data
// now comes from `src/router/stats/TokenStatsCollector` via the

app.get("/api/ccr/dashboard", authenticateToken, (_req, res) => {
  try {
    res.json(getRouterDashboardData());
  } catch (error) {
    console.error("[router-dashboard] failed:", error);
    res.status(500).json({ error: error?.message || "router-dashboard failed" });
  }
});

app.get("/api/always-on/events", authenticateToken, async (req, res) => {
  try {
    const limit = Number.parseInt(req.query?.limit || "", 10);
    const since = req.query?.since || undefined;
    const result = await getAlwaysOnDashboardEvents({
      limit: Number.isFinite(limit) ? limit : 200,
      since: typeof since === "string" ? since : undefined,
    });
    res.json(result);
  } catch (error) {
    console.error("[always-on-events] failed:", error);
    res.status(500).json({ error: error?.message || "always-on-events failed" });
  }
});

app.get("/api/always-on/cron-jobs", authenticateToken, async (_req, res) => {
  try {
    const result = await getProjectCronJobsOverview();
    res.json(result);
  } catch (error) {
    console.error("[always-on-cron-jobs] failed:", error);
    res.status(500).json({ error: error?.message || "always-on-cron-jobs failed" });
  }
});

app.post("/api/always-on/cron-jobs", authenticateToken, async (req, res) => {
  try {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const projectKey = typeof req.body?.projectKey === "string" ? req.body.projectKey : "";
    const schedule = req.body?.schedule;
    const timezone =
      typeof req.body?.timezone === "string" && req.body.timezone.trim() ? req.body.timezone.trim() : undefined;

    if (!message) {
      res.status(400).json({ error: "Cron message is required." });
      return;
    }
    if (!projectKey) {
      res.status(400).json({ error: "Cron projectKey is required." });
      return;
    }
    if (!schedule || typeof schedule !== "object") {
      res.status(400).json({ error: "Cron schedule is required." });
      return;
    }

    const gateway = await getSatiGateway();
    const result = await gateway.cronCreate({
      message,
      projectKey,
      schedule,
      timezone,
      channelKey: "web",
    });
    res.json(result);
  } catch (error) {
    console.error("[always-on-cron-create] failed:", error);
    res.status(500).json({ error: error?.message || "cron create failed" });
  }
});

app.put("/api/always-on/cron-jobs/:taskId", authenticateToken, async (req, res) => {
  try {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const schedule = req.body?.schedule;
    const timezone =
      typeof req.body?.timezone === "string" && req.body.timezone.trim() ? req.body.timezone.trim() : undefined;

    if (!message) {
      res.status(400).json({ error: "Cron message is required." });
      return;
    }
    if (!schedule || typeof schedule !== "object") {
      res.status(400).json({ error: "Cron schedule is required." });
      return;
    }

    const gateway = await getSatiGateway();
    const result = await gateway.cronUpdate({
      taskId: req.params.taskId,
      message,
      schedule,
      timezone,
      projectKey: req.body?.projectKey || req.query?.projectKey || undefined,
      expectedRevision: req.body?.expectedRevision,
    });
    if (result && result.updated === false) {
      res.status(409).json({ error: `Cron task update rejected: ${result.reason}`, reason: result.reason });
      return;
    }
    res.json(result);
  } catch (error) {
    console.error("[always-on-cron-update] failed:", error);
    res.status(500).json({ error: error?.message || "cron update failed" });
  }
});

app.post("/api/always-on/cron-jobs/:taskId/run-now", authenticateToken, async (req, res) => {
  try {
    const gateway = await getSatiGateway();
    const result = await gateway.cronRunNow({
      taskId: req.params.taskId,
      projectKey: req.body?.projectKey || req.query?.projectKey || undefined,
    });
    res.json(result);
  } catch (error) {
    console.error("[always-on-cron-run-now] failed:", error);
    res.status(500).json({ error: error?.message || "cron run-now failed" });
  }
});

app.post("/api/always-on/cron-jobs/:taskId/stop", authenticateToken, async (req, res) => {
  try {
    const gateway = await getSatiGateway();
    const result = await gateway.cronStop({
      taskId: req.params.taskId,
      projectKey: req.body?.projectKey || req.query?.projectKey || undefined,
    });
    res.json(result);
  } catch (error) {
    console.error("[always-on-cron-stop] failed:", error);
    res.status(500).json({ error: error?.message || "cron stop failed" });
  }
});

app.delete("/api/always-on/cron-jobs/:taskId", authenticateToken, async (req, res) => {
  try {
    const gateway = await getSatiGateway();
    const result = await gateway.cronDelete({
      taskId: req.params.taskId,
      projectKey: req.body?.projectKey || req.query?.projectKey || undefined,
      stopRunning: true,
    });
    res.json(result);
  } catch (error) {
    console.error("[always-on-cron-delete] failed:", error);
    res.status(500).json({ error: error?.message || "cron delete failed" });
  }
});

app.get("/api/ccr/health", authenticateToken, (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    port: null,
    embedded: true,
    backend: "sati-router",
  });
});

app.get("/api/ccr/config", authenticateToken, (_req, res) => {
  // The legacy CCR YAML schema is no longer the source of truth for
  // model routing — that lives in Sati config now. Return null so
  // the legacy useRouterSettings hook simply renders the "no config"
  // empty state instead of a config editor.
  res.json(null);
});

app.get("/api/ccr/stats/summary", authenticateToken, (_req, res) => {
  try {
    res.json(getRouterStatsSummary());
  } catch (error) {
    res.status(500).json({ error: error?.message || "router-stats-summary failed" });
  }
});

app.get("/api/ccr/stats/sessions/:sessionId", authenticateToken, (req, res) => {
  try {
    const stats = getRouterSessionStats(req.params.sessionId);
    if (!stats) {
      return res.status(404).json({ error: "session_not_found" });
    }
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error?.message || "router-stats-session failed" });
  }
});

app.post("/api/ccr/stats/reset", authenticateToken, (_req, res) => {
  // Reset would require reaching into per-project TokenStatsCollector
  // instances; that is not exposed today. Surface a clear hint instead
  // of silently no-oping.
  res.status(501).json({
    error: "not_implemented",
    message: "Per-project router stats reset is not exposed yet; restart the Sati server to clear in-memory state.",
  });
});

app.put("/api/ccr/config", authenticateToken, (_req, res) => {
  res.status(501).json({
    error: "not_implemented",
    message: "Routing configuration is owned by Sati config (~/.sati/sati.yaml). Edit it directly via /api/config.",
  });
});

app.get("/memory-dashboard", authenticateToken, (req, res) => {
  const indexPath = path.join(MEMORY_DASHBOARD_DIR, "index.html");
  if (!fs.existsSync(indexPath)) {
    res.status(404).type("text/plain").send("Memory dashboard assets not bundled.");
    return;
  }
  res.sendFile(indexPath);
});

app.use(
  "/memory-dashboard",
  authenticateToken,
  express.static(MEMORY_DASHBOARD_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  }),
);

// Hard 404 boundary: anything still asking for /memory-dashboard/* after the
// static middleware is a missing asset. Without this, the request would fall
// through to the SPA wildcard below and return the Sati shell index.html,
// which the MemoryPanel iframe then renders — recursively nesting the entire
// app inside itself (see bug: "嵌套显示 + general memory 多次出现").
app.use("/memory-dashboard", (_req, res) => {
  res.status(404).type("text/plain").send("Not found in memory-dashboard.");
});

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

app.get("/api/projects", authenticateToken, async (req, res) => {
  try {
    const projects = await getProjects(broadcastProgress);
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/projects/:projectName/sessions", authenticateToken, async (req, res) => {
  try {
    const { limit = 5, offset = 0 } = req.query;
    const result = await getSessions(req.params.projectName, parseInt(limit), parseInt(offset));
    applyCustomSessionNames(result.sessions, "sati");
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rename project endpoint
app.put("/api/projects/:projectName/rename", authenticateToken, async (req, res) => {
  try {
    const { displayName } = req.body;
    await renameProject(req.params.projectName, displayName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete session endpoint
app.delete("/api/projects/:projectName/sessions/:sessionId", authenticateToken, async (req, res) => {
  try {
    const { projectName, sessionId } = req.params;
    console.log(`[API] Deleting session: ${sessionId} from project: ${projectName}`);
    await deleteSession(projectName, sessionId, {
      sessionKind: req.query.sessionKind || null,
      parentSessionId: req.query.parentSessionId || null,
      relativeTranscriptPath: req.query.relativeTranscriptPath || null,
    });
    sessionNamesDb.deleteName(sessionId, "sati");
    console.log(`[API] Session ${sessionId} deleted successfully`);
    res.json({ success: true });
  } catch (error) {
    console.error(`[API] Error deleting session ${req.params.sessionId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Rename session endpoint
app.put("/api/sessions/:sessionId/rename", authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safeSessionId || safeSessionId !== String(sessionId)) {
      return res.status(400).json({ error: "Invalid sessionId" });
    }
    const { summary, provider } = req.body;
    if (!summary || typeof summary !== "string" || summary.trim() === "") {
      return res.status(400).json({ error: "Summary is required" });
    }
    if (summary.trim().length > 500) {
      return res.status(400).json({ error: "Summary must not exceed 500 characters" });
    }
    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `Provider must be one of: ${VALID_PROVIDERS.join(", ")}` });
    }
    sessionNamesDb.setName(safeSessionId, provider, summary.trim());
    res.json({ success: true });
  } catch (error) {
    console.error(`[API] Error renaming session ${req.params.sessionId}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Delete project endpoint (force=true to delete with sessions)
app.delete("/api/projects/:projectName", authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    const force = req.query.force === "true";
    await deleteProject(projectName, force);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create project endpoint
app.post("/api/projects/create", authenticateToken, async (req, res) => {
  try {
    const { path: projectPath } = req.body;

    if (!projectPath || !projectPath.trim()) {
      return res.status(400).json({ error: "Project path is required" });
    }

    const project = await addProjectManually(projectPath.trim());
    res.json({ success: true, project });
  } catch (error) {
    console.error("Error creating project:", error);
    res.status(500).json({ error: error.message });
  }
});

// Search conversations content (SSE streaming)
app.get("/api/search/conversations", authenticateToken, async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const parsedLimit = Number.parseInt(String(req.query.limit), 10);
  const limit = Number.isNaN(parsedLimit) ? 50 : Math.max(1, Math.min(parsedLimit, 100));

  if (query.length < 2) {
    return res.status(400).json({ error: "Query must be at least 2 characters" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  let closed = false;
  const abortController = new AbortController();
  req.on("close", () => {
    closed = true;
    abortController.abort();
  });

  try {
    await searchConversations(
      query,
      limit,
      ({ projectResult, totalMatches, scannedProjects, totalProjects }) => {
        if (closed) return;
        if (projectResult) {
          res.write(
            `event: result\ndata: ${JSON.stringify({ projectResult, totalMatches, scannedProjects, totalProjects })}\n\n`,
          );
        } else {
          res.write(`event: progress\ndata: ${JSON.stringify({ totalMatches, scannedProjects, totalProjects })}\n\n`);
        }
      },
      abortController.signal,
    );
    if (!closed) {
      res.write(`event: done\ndata: {}\n\n`);
    }
  } catch (error) {
    console.error("Error searching conversations:", error);
    if (!closed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Search failed" })}\n\n`);
    }
  } finally {
    if (!closed) {
      res.end();
    }
  }
});

app.get("/api/browse-filesystem", authenticateToken, async (req, res) => {
  try {
    const { path: dirPath } = req.query;

    console.log("[API] Browse filesystem request for path:", dirPath);
    console.log("[API] WORKSPACES_ROOT is:", WORKSPACES_ROOT);
    // Default to home directory if no path provided
    const defaultRoot = WORKSPACES_ROOT;

    if (isWindowsDriveBrowserRoot(dirPath)) {
      const suggestions = await getWindowsDriveSuggestions();
      return res.json({
        path: "/",
        suggestions,
      });
    }

    let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

    // Resolve and normalize the path
    targetPath = path.resolve(targetPath);

    // Browsing a directory is read-only — we only list its children.
    // The actual workspace-selection validation happens in the
    // create-workspace / clone-progress endpoints, so we don't gate
    // browsing with validateWorkspacePath (which would block navigating
    // through forbidden directories like "/" to reach valid children).
    const resolvedPath = targetPath;

    // Security check - ensure path is accessible
    try {
      await fs.promises.access(resolvedPath);
      const stats = await fs.promises.stat(resolvedPath);

      if (!stats.isDirectory()) {
        return res.status(400).json({ error: "Path is not a directory" });
      }
    } catch (err) {
      return res.status(404).json({ error: "Directory not accessible" });
    }

    // Use existing getFileTree function with shallow depth (only direct children)
    const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

    // Filter only directories and format for suggestions
    const directories = fileTree
      .filter(item => item.type === "directory")
      .map(item => ({
        path: item.path,
        name: item.name,
        type: "directory",
      }))
      .sort((a, b) => {
        const aHidden = a.name.startsWith(".");
        const bHidden = b.name.startsWith(".");
        if (aHidden && !bHidden) return 1;
        if (!aHidden && bHidden) return -1;
        return a.name.localeCompare(b.name);
      });

    // Add common directories if browsing home directory
    const suggestions = [];
    let resolvedWorkspaceRoot = defaultRoot;
    try {
      resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
    } catch (error) {
      // Use default root as-is if realpath fails
    }
    if (resolvedPath === resolvedWorkspaceRoot) {
      const commonDirs = ["Desktop", "Documents", "Projects", "Development", "Dev", "Code", "workspace"];
      const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
      const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

      suggestions.push(...existingCommon, ...otherDirs);
    } else {
      suggestions.push(...directories);
    }

    res.json({
      path: resolvedPath,
      suggestions: suggestions,
    });
  } catch (error) {
    console.error("Error browsing filesystem:", error);
    res.status(500).json({ error: "Failed to browse filesystem" });
  }
});

app.post("/api/create-folder", authenticateToken, async (req, res) => {
  try {
    const { path: folderPath } = req.body;
    if (!folderPath) {
      return res.status(400).json({ error: "Path is required" });
    }
    const expandedPath = expandWorkspacePath(folderPath);
    const resolvedInput = path.resolve(expandedPath);
    const validation = await validateWorkspacePath(resolvedInput);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error });
    }
    const targetPath = validation.resolvedPath || resolvedInput;
    const parentDir = path.dirname(targetPath);
    try {
      await fs.promises.access(parentDir);
    } catch (err) {
      return res.status(404).json({ error: "Parent directory does not exist" });
    }
    try {
      await fs.promises.access(targetPath);
      return res.status(409).json({ error: "Folder already exists" });
    } catch (err) {
      // Folder doesn't exist, which is what we want
    }
    try {
      await fs.promises.mkdir(targetPath, { recursive: false });
      res.json({ success: true, path: targetPath });
    } catch (mkdirError) {
      if (mkdirError.code === "EEXIST") {
        return res.status(409).json({ error: "Folder already exists" });
      }
      throw mkdirError;
    }
  } catch (error) {
    console.error("Error creating folder:", error);
    res.status(500).json({ error: "Failed to create folder" });
  }
});

// Read file content endpoint
app.get("/api/projects/:projectName/file", authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    const { filePath } = req.query;

    // Security: ensure the requested path is inside the project root
    if (!filePath) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
    if (!projectRoot) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Handle both absolute and relative paths
    const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath);
    const normalizedRoot = path.resolve(projectRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot)) {
      return res.status(403).json({ error: "Path must be under project root" });
    }

    // Memory-managed files (e.g. MEMORY.md) live under the memory store
    // (memory/workspaces/<hash>/memory/...) rather than the project root.
    // Try the managed location first so chat file references open the real
    // memory file, then fall back to the project-root path as before.
    const memoryCandidate = resolveManagedMemoryFile(projectRoot, path.relative(projectRoot, resolved));
    const readTargets = memoryCandidate ? [memoryCandidate, resolved] : [resolved];

    let content = null;
    let readPath = null;
    let firstError = null;
    for (const target of readTargets) {
      try {
        content = await fsPromises.readFile(target, "utf8");
        readPath = target;
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!firstError) firstError = error;
      }
    }
    if (content === null) {
      throw firstError;
    }
    res.json({ content, path: readPath });
  } catch (error) {
    console.error("Error reading file:", error);
    if (error.code === "ENOENT") {
      res.status(404).json({ error: "File not found" });
    } else if (error.code === "EACCES") {
      res.status(403).json({ error: "Permission denied" });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Serve raw file bytes for previews and downloads.
app.get("/api/projects/:projectName/files/content", authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    const { path: filePath } = req.query;

    // Security: ensure the requested path is inside the project root
    if (!filePath) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
    if (!projectRoot) {
      return res.status(404).json({ error: "Project not found" });
    }

    const resolvedResult = resolvePathInProject(projectRoot, filePath);
    if (!resolvedResult.valid) {
      return res.status(403).json({ error: resolvedResult.error });
    }

    const resolved = resolvedResult.resolved;
    const stats = await fsPromises.stat(resolved).catch(() => null);
    if (!stats?.isFile()) {
      return res.status(404).json({ error: "File not found" });
    }

    const mimeType = mime.lookup(resolved) || "application/octet-stream";
    if (req.method === "HEAD" && (req.query.sha256 === "1" || req.query.sha256 === "true")) {
      res.setHeader("X-Sati-Content-SHA256", await sha256File(resolved));
    }
    await streamFileWithRange(req, res, resolved, {
      mimeType,
      downloadFilename: req.query.download ? path.basename(resolved) : null,
    });
  } catch (error) {
    console.error("Error serving binary file:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get("/api/office-preview/status", authenticateToken, officePreviewStatusRateLimiter, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
    const [libreOffice, candidates, service] = await Promise.all([
      getLibreOfficeStatus({ forceRefresh }),
      getLibreOfficeCandidateStatuses({ forceRefresh }),
      Promise.resolve(getConfiguredOfficePreviewService()),
    ]);
    res.json({
      service,
      libreOffice: {
        ...libreOffice,
        candidates,
      },
      supportedServices: [OFFICE_PREVIEW_SERVICE_BUILTIN, OFFICE_PREVIEW_SERVICE_LIBREOFFICE],
    });
  } catch (error) {
    console.error("Error reading Office preview status:", error);
    res.status(500).json({
      error: "Failed to read Office preview status",
      code: "OFFICE_PREVIEW_STATUS_FAILED",
    });
  }
});

// Convert Office files to PDF for lightweight read-only preview.
// This is an optional fallback for legacy Office/PPT formats; it only works
// when LibreOffice/soffice is available on the host.
app.get(
  "/api/projects/:projectName/files/preview/pdf",
  authenticateToken,
  officePreviewPdfRateLimiter,
  async (req, res) => {
    try {
      const { projectName } = req.params;
      const { path: filePath } = req.query;
      const force = req.query.force === "1" || req.query.force === "true";

      if (!filePath) {
        return res.status(400).json({ error: "Invalid file path" });
      }

      const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
      if (!projectRoot) {
        return res.status(404).json({ error: "Project not found" });
      }

      const resolvedResult = resolvePathInProject(projectRoot, filePath);
      if (!resolvedResult.valid) {
        return res.status(403).json({ error: resolvedResult.error });
      }

      const resolved = resolvedResult.resolved;
      const extension = getFileExtension(resolved);
      if (!OFFICE_PDF_PREVIEW_EXTENSIONS.has(extension)) {
        return res.status(400).json({ error: "Unsupported Office preview format" });
      }

      const stats = await fsPromises.stat(resolved).catch(() => null);
      if (!stats?.isFile()) {
        return res.status(404).json({ error: "File not found" });
      }

      const officePreviewService = getConfiguredOfficePreviewService();
      if (officePreviewService !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE) {
        return res.status(409).json({
          error: "LibreOffice preview service is not selected",
          code: "LIBREOFFICE_PREVIEW_NOT_SELECTED",
        });
      }

      const pdfPath = await convertOfficeDocumentToPdf(resolved, { force, projectRoot });
      await streamFileWithRange(req, res, pdfPath, {
        mimeType: "application/pdf",
        cacheControl: "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
      });
    } catch (error) {
      console.error("Error generating Office PDF preview:", error);
      if (!res.headersSent) {
        res.status(error.statusCode || 500).json({
          error:
            error.code === "LIBREOFFICE_NOT_FOUND"
              ? "LibreOffice executable not found"
              : error.code === "OFFICE_PREVIEW_DISABLED"
                ? "Office preview service is disabled"
                : "Failed to generate Office PDF preview",
          code: error.code || "OFFICE_PREVIEW_FAILED",
        });
      }
    }
  },
);

// Preserve workbook semantics for spreadsheet previews. The manifest exposes
// visible worksheet tabs, while each worksheet is rendered as its own PDF so
// multi-page sheets remain grouped under one tab in the UI.
app.get(
  "/api/projects/:projectName/files/preview/spreadsheet/manifest",
  authenticateToken,
  officePreviewPdfRateLimiter,
  async (req, res) => {
    try {
      const { projectName } = req.params;
      const { path: filePath } = req.query;
      const force = req.query.force === "1" || req.query.force === "true";

      if (!filePath) {
        return res.status(400).json({ error: "Invalid file path" });
      }

      const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
      if (!projectRoot) {
        return res.status(404).json({ error: "Project not found" });
      }
      const resolvedResult = resolvePathInProject(projectRoot, filePath);
      if (!resolvedResult.valid) {
        return res.status(403).json({ error: resolvedResult.error });
      }
      const extension = getFileExtension(resolvedResult.resolved);
      if (!SPREADSHEET_PREVIEW_EXTENSIONS.has(extension)) {
        return res.status(400).json({ error: "Unsupported spreadsheet preview format" });
      }
      if (extension !== "xlsx" && getConfiguredOfficePreviewService() !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE) {
        return res.status(409).json({
          error: "Legacy spreadsheet preview requires LibreOffice",
          code: "LIBREOFFICE_PREVIEW_NOT_SELECTED",
        });
      }
      const manifest = await getSpreadsheetPreviewManifest(resolvedResult.resolved, { force });
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      return res.json(manifest);
    } catch (error) {
      console.error("Error reading spreadsheet preview manifest:", error);
      return res.status(error.statusCode || 500).json({
        error: error.message || "Failed to read spreadsheet preview manifest",
        code: error.code || "SPREADSHEET_PREVIEW_MANIFEST_FAILED",
      });
    }
  },
);

app.get(
  "/api/projects/:projectName/files/preview/spreadsheet/data",
  authenticateToken,
  officePreviewPdfRateLimiter,
  async (req, res) => {
    try {
      const { projectName } = req.params;
      const { path: filePath } = req.query;
      const force = req.query.force === "1" || req.query.force === "true";

      if (!filePath) {
        return res.status(400).json({ error: "Invalid file path" });
      }

      const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
      if (!projectRoot) {
        return res.status(404).json({ error: "Project not found" });
      }
      const resolvedResult = resolvePathInProject(projectRoot, filePath);
      if (!resolvedResult.valid) {
        return res.status(403).json({ error: resolvedResult.error });
      }
      const extension = getFileExtension(resolvedResult.resolved);
      if (!SPREADSHEET_PREVIEW_EXTENSIONS.has(extension)) {
        return res.status(400).json({ error: "Unsupported spreadsheet preview format" });
      }
      if (extension !== "xlsx" && getConfiguredOfficePreviewService() !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE) {
        return res.status(409).json({
          error: "Legacy spreadsheet preview requires LibreOffice",
          code: "LIBREOFFICE_PREVIEW_NOT_SELECTED",
        });
      }

      const preview = await getSpreadsheetInteractivePreview(resolvedResult.resolved, { force });
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      return res.json(preview);
    } catch (error) {
      console.error("Error generating interactive spreadsheet preview:", error);
      return res.status(error.statusCode || 500).json({
        error: error.message || "Failed to generate interactive spreadsheet preview",
        code: error.code || "SPREADSHEET_INTERACTIVE_PREVIEW_FAILED",
      });
    }
  },
);

app.get(
  "/api/projects/:projectName/files/preview/spreadsheet/sheet",
  authenticateToken,
  officePreviewPdfRateLimiter,
  async (req, res) => {
    try {
      const { projectName } = req.params;
      const { path: filePath, sheet: sheetIndex } = req.query;
      const force = req.query.force === "1" || req.query.force === "true";

      if (!filePath || sheetIndex === undefined) {
        return res.status(400).json({ error: "File path and worksheet index are required" });
      }

      const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
      if (!projectRoot) {
        return res.status(404).json({ error: "Project not found" });
      }
      const resolvedResult = resolvePathInProject(projectRoot, filePath);
      if (!resolvedResult.valid) {
        return res.status(403).json({ error: resolvedResult.error });
      }
      const extension = getFileExtension(resolvedResult.resolved);
      if (!SPREADSHEET_PREVIEW_EXTENSIONS.has(extension)) {
        return res.status(400).json({ error: "Unsupported spreadsheet preview format" });
      }
      const officePreviewService = getConfiguredOfficePreviewService();
      if (officePreviewService !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE) {
        return res.status(409).json({
          error: "LibreOffice preview service is not selected",
          code: "LIBREOFFICE_PREVIEW_NOT_SELECTED",
        });
      }

      const pdfPath = await getSpreadsheetSheetPreviewPdf(resolvedResult.resolved, Number(sheetIndex), { force });
      await streamFileWithRange(req, res, pdfPath, {
        mimeType: "application/pdf",
        cacheControl: "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
      });
    } catch (error) {
      console.error("Error generating worksheet PDF preview:", error);
      if (!res.headersSent) {
        res.status(error.statusCode || 500).json({
          error: error.message || "Failed to generate worksheet preview",
          code: error.code || "SPREADSHEET_SHEET_PREVIEW_FAILED",
        });
      }
    }
  },
);

// Serve project files through a stable project-root URL so generated HTML can
// load sibling CSS, JS and image assets with normal relative paths.
app.get("/api/projects/:projectName/preview/{*splat}", authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    const relativeFilePath = getSplatPath(req) || "index.html";

    const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
    if (!projectRoot) {
      return res.status(404).json({ error: "Project not found" });
    }

    const resolvedResult = resolvePathInProject(projectRoot, relativeFilePath);
    if (!resolvedResult.valid) {
      return res.status(403).json({ error: resolvedResult.error });
    }

    let resolved = resolvedResult.resolved;
    let stats = await fsPromises.stat(resolved).catch(() => null);
    if (stats?.isDirectory()) {
      resolved = path.join(resolved, "index.html");
      stats = await fsPromises.stat(resolved).catch(() => null);
    }

    if (!stats || !stats.isFile()) {
      return res.status(404).type("text/plain").send("Preview file not found.");
    }

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    setPreviewContentType(res, resolved);
    fs.createReadStream(resolved).pipe(res);
  } catch (error) {
    console.error("Error serving project preview:", error);
    res.status(500).json({ error: error.message });
  }
});

// Download the complete project as a zip archive.
app.get("/api/projects/:projectName/download", authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
    if (!projectRoot) {
      return res.status(404).json({ error: "Project not found" });
    }

    const rootStats = await fsPromises.stat(projectRoot).catch(() => null);
    if (!rootStats?.isDirectory()) {
      return res.status(404).json({ error: "Project directory not found" });
    }

    const zip = new JSZip();
    await addDirectoryToZip(zip, projectRoot, projectRoot);

    const filename = getSafeZipFilename(projectName);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", contentDispositionAttachment(filename));

    const zipStream = zip.generateNodeStream({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    zipStream.on("error", error => {
      console.error("Error streaming project zip:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to generate project archive" });
      } else {
        res.end();
      }
    });
    zipStream.pipe(res);
  } catch (error) {
    console.error("Error downloading project archive:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Save file content endpoint
app.put("/api/projects/:projectName/file", authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    const { filePath, content } = req.body;

    // Security: ensure the requested path is inside the project root
    if (!filePath) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    if (content === undefined) {
      return res.status(400).json({ error: "Content is required" });
    }

    const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
    if (!projectRoot) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Handle both absolute and relative paths
    const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath);
    const normalizedRoot = path.resolve(projectRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot)) {
      return res.status(403).json({ error: "Path must be under project root" });
    }

    // Memory-managed files must be written back to the memory store instead
    // of the project root — otherwise saving would create a shadow file at
    // <projectRoot>/MEMORY.md that the memory pipeline never reads.
    const memoryCandidate = resolveManagedMemoryFile(projectRoot, path.relative(projectRoot, resolved));
    const writeTarget = memoryCandidate ?? resolved;

    // Write the new content
    await fsPromises.writeFile(writeTarget, content, "utf8");

    res.json({
      success: true,
      path: writeTarget,
      message: "File saved successfully",
    });
  } catch (error) {
    console.error("Error saving file:", error);
    if (error.code === "ENOENT") {
      res.status(404).json({ error: "File or directory not found" });
    } else if (error.code === "EACCES") {
      res.status(403).json({ error: "Permission denied" });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get("/api/projects/:projectName/files", authenticateToken, async (req, res) => {
  try {
    // Using fsPromises from import

    // Use extractProjectDirectory to get the actual project path
    let actualPath;
    try {
      actualPath = await extractProjectDirectory(req.params.projectName);
    } catch (error) {
      console.error("Error extracting project directory:", error);
      // Fallback to simple dash replacement
      actualPath = req.params.projectName.replace(/-/g, "/");
    }

    // Check if path exists
    try {
      await fsPromises.access(actualPath);
    } catch (e) {
      return res.status(404).json({ error: `Project path not found: ${actualPath}` });
    }

    const files = await getFileTree(actualPath, 10, 0, true);
    res.json(files);
  } catch (error) {
    console.error("[ERROR] File tree error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// FILE OPERATIONS API ENDPOINTS
// ============================================================================

/**
 * Validate that a path is within the project root
 * @param {string} projectRoot - The project root path
 * @param {string} targetPath - The path to validate
 * @returns {{ valid: boolean, resolved?: string, error?: string }}
 */
app.post("/api/projects/:projectName/files/upload", authenticateToken, uploadFilesHandler);

/**
 * Proxy an authenticated client WebSocket to a plugin's internal WS server.
 * Auth is enforced by verifyClient before this function is reached.
 */
function handlePluginWsProxy(clientWs, pathname) {
  const pluginName = pathname.replace("/plugin-ws/", "");
  if (!pluginName || /[^a-zA-Z0-9_-]/.test(pluginName)) {
    clientWs.close(4400, "Invalid plugin name");
    return;
  }

  const port = getPluginPort(pluginName);
  if (!port) {
    clientWs.close(4404, "Plugin not running");
    return;
  }

  const upstream = new WebSocket(`ws://127.0.0.1:${port}/ws`);

  upstream.on("open", () => {
    console.log(`[Plugins] WS proxy connected to "${pluginName}" on port ${port}`);
  });

  // Relay messages bidirectionally
  upstream.on("message", data => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
  });
  clientWs.on("message", data => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
  });

  // Propagate close in both directions
  upstream.on("close", () => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });
  clientWs.on("close", () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });

  upstream.on("error", err => {
    console.error(`[Plugins] WS proxy error for "${pluginName}":`, err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(4502, "Upstream error");
  });
  clientWs.on("error", () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });
}

// WebSocket connection handler that routes based on URL path
wss.on("connection", (ws, request) => {
  const url = request.url;
  console.log("[INFO] Client connected to:", url);

  // Parse URL to get pathname without query parameters
  const urlObj = new URL(url, "http://localhost");
  const pathname = urlObj.pathname;

  if (pathname === "/shell") {
    handleShellConnection(ws);
  } else if (pathname === "/ws") {
    handleChatConnection(ws, request);
  } else if (pathname.startsWith("/plugin-ws/")) {
    handlePluginWsProxy(ws, pathname);
  } else {
    console.log("[WARN] Unknown WebSocket path:", pathname);
    ws.close();
  }
});

/**
 * WebSocket Writer - Wrapper for WebSocket to match SSEStreamWriter interface
 *
 * Provider files use `createNormalizedMessage()` from `providers/types.js` and
 * adapter `normalizeMessage()` to produce unified NormalizedMessage events.
 * The writer simply serialises and sends.
 */
class WebSocketWriter {
  constructor(ws, userId = null) {
    this.ws = ws;
    this.sessionId = null;
    this.userId = userId;
    this.isWebSocketWriter = true; // Marker for transport detection
  }

  send(data) {
    const message = JSON.stringify(data);
    if (this.ws.readyState === 1) {
      // WebSocket.OPEN
      this.ws.send(message);
      return;
    }

    // A chat turn can outlive the browser WebSocket that submitted it
    // (refresh, reconnect, dev-client hiccup). Keep the gateway stream live
    // by handing subsequent frames to the user's replacement connection.
    connectedClients.forEach(client => {
      if (client.readyState !== 1) return; // WebSocket.OPEN
      if (client.__satiUserId !== this.userId) return;
      client.send(message);
    });
  }

  updateWebSocket(newRawWs) {
    this.ws = newRawWs;
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  getSessionId() {
    return this.sessionId;
  }
}

// Handle chat WebSocket connections
function handleChatConnection(ws, request) {
  console.log("[INFO] Chat WebSocket connected");

  // Add to connected clients for project updates
  const userId = request?.user?.id ?? request?.user?.userId ?? null;
  ws.__satiUserId = userId;
  connectedClients.add(ws);
  // Sati's cron manager lives inside `sati server`;
  // no legacy daemon lease is needed.
  let cleanedUp = false;

  // Wrap WebSocket with writer for consistent interface with SSEStreamWriter
  const writer = new WebSocketWriter(ws, userId);
  const streamWriter = {
    send: data => broadcastChatFrame(data, ws, userId),
  };

  ws.on("message", async message => {
    try {
      const data = JSON.parse(message);

      if (data.type === "ping") return;
      const requestSessionId = normalizeSessionId(data.sessionId);

      if (data.type === "watch-session") {
        if (requestSessionId) {
          sessionWatchRegistry.watch(requestSessionId, ws);
        }
        return;
      }

      if (data.type === "unwatch-session") {
        if (requestSessionId) {
          sessionWatchRegistry.unwatch(requestSessionId, ws);
        }
        return;
      }

      if (
        data.type === "sati-command" ||
        // Deprecated: legacy per-provider frame types kept for back-compat.
        data.type === "claude-command" ||
        data.type === "cursor-command" ||
        data.type === "codex-command" ||
        data.type === "gemini-command"
      ) {
        console.log("[DEBUG] User message:", data.command || "[Continue/Resume]");
        console.log("📁 Project:", data.options?.projectPath || data.options?.cwd || "Unknown");
        console.log("🔄 Session:", data.options?.sessionId ? "Resume" : "New");
        const commandSessionId = normalizeSessionId(data.options?.sessionId || data.options?.sessionKey);
        if (commandSessionId) {
          sessionWatchRegistry.watch(commandSessionId, ws);
          const userVisibleInput =
            typeof data.options?.userVisibleInput === "string" ? data.options.userVisibleInput.trim() : "";
          if (userVisibleInput) {
            const nowIso = new Date().toISOString();
            const provider = data.options?.providerHint || "sati";
            const optimisticUserFrame = createNormalizedMessage({
              id: `local_ws_user_${crypto.randomUUID()}`,
              sessionId: commandSessionId,
              provider,
              kind: "text",
              role: "user",
              content: userVisibleInput,
              ...(Array.isArray(data.options?.attachments) && data.options.attachments.length > 0
                ? { attachments: data.options.attachments }
                : {}),
              timestamp: nowIso,
            });
            const optimisticStatusFrame = createNormalizedMessage({
              id: `local_ws_status_${crypto.randomUUID()}`,
              sessionId: commandSessionId,
              provider,
              kind: "status",
              text: "Processing",
              canInterrupt: true,
              timestamp: nowIso,
            });
            // The submitting tab already rendered its optimistic user row.
            // Push only to sibling watchers so they mirror instantly.
            broadcastToSessionWatchers(commandSessionId, optimisticUserFrame, userId, ws);
            broadcastToSessionWatchers(commandSessionId, optimisticStatusFrame, userId, ws);
          }
        }
        const providerHint = data.options?.providerHint || data.type.replace("-command", "");
        await runChatViaGateway(data.command, data.options, streamWriter, providerHint);
      } else if (data.type === "abort-session") {
        console.log("[DEBUG] Abort session request:", data.sessionId);
        const provider = data.provider || "sati";
        const success = await abortViaGateway(data.sessionId, provider);
        writer.send(
          createNormalizedMessage({
            kind: "complete",
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId: data.sessionId,
            provider,
          }),
        );
      } else if (data.type === "permission-response") {
        if (data.requestId) {
          await decidePermissionViaGateway(data.requestId, data.allow ? "allow" : "deny", {
            remember: Boolean(data.rememberEntry),
            reason: data.message,
          });
          const resolvedSessionId = normalizeSessionId(data.sessionId);
          if (resolvedSessionId) {
            broadcastToSessionWatchers(
              resolvedSessionId,
              createNormalizedMessage({
                kind: "permission_cancelled",
                requestId: data.requestId,
                sessionId: resolvedSessionId,
                provider: data.provider || "sati",
              }),
              userId,
            );
          }
        }
      } else if (data.type === "approval-response") {
        // 输出门禁 HITL 审批：通过/拒绝一条挂起审批（verdict: adopted | rejected）。
        const verdict = data.verdict === "adopted" ? "adopted" : "rejected";
        const result = await approvalDecideViaGateway(
          data.sessionId,
          data.pendingIndex,
          verdict,
          typeof data.feedback === "string" ? data.feedback : undefined,
        );
        const resolvedSessionId = normalizeSessionId(data.sessionId);
        if (result?.delivered && resolvedSessionId) {
          // 通知同会话 watchers 移除审批卡片（乐观移除的兜底广播）。
          broadcastToSessionWatchers(
            resolvedSessionId,
            createNormalizedMessage({
              kind: "approval_resolved",
              pendingIndex: data.pendingIndex,
              verdict,
              sessionId: resolvedSessionId,
              provider: data.provider || "sati",
            }),
            userId,
          );
        }
      } else if (data.type === "session-permission-grant") {
        const result = await grantSessionPermissionViaGateway(data.sessionId, data.entry);
        ws.send(
          JSON.stringify({
            type: "session-permission-grant-result",
            requestId: typeof data.requestId === "string" ? data.requestId : null,
            sessionId: data.sessionId,
            entry: data.entry,
            granted: result.granted === true,
            ...(typeof result.entry === "string" ? { grantedEntry: result.entry } : {}),
          }),
        );
      } else if (data.type === "elicitation-response") {
        if (data.requestId) {
          await elicitationRespondViaGateway(data.requestId, data.answer);
          const resolvedSessionId = normalizeSessionId(data.sessionId);
          if (resolvedSessionId) {
            broadcastToSessionWatchers(
              resolvedSessionId,
              createNormalizedMessage({
                kind: "permission_cancelled",
                requestId: data.requestId,
                sessionId: resolvedSessionId,
                provider: data.provider || "sati",
              }),
              userId,
            );
          }
        }
      } else if (data.type === "check-session-status") {
        const sessionId = data.sessionId;
        if (normalizeSessionId(sessionId)) {
          sessionWatchRegistry.watch(sessionId, ws);
        }
        const provider = data.provider || "sati";
        const includeActiveTurnMessages = data.includeActiveTurnMessages !== false;
        // Gateway activity may be unavailable (disconnected, restarting). In
        // that case report unknown (`isProcessing: null`) instead of inactive
        // so the UI keeps the session in a synchronizing state rather than
        // cancelling running subagents or clearing the active run.
        const activity = await getSessionActivityViaGateway(sessionId, provider, includeActiveTurnMessages);
        writer.send({
          type: "session-status",
          sessionId,
          provider,
          isProcessing: activity.isProcessing,
          activeRunId: activity.activeRunId,
          activeTurnMessages: activity.activeTurnMessages,
          tokenBudget: getSessionTokenBudget(sessionId),
        });
      } else if (data.type === "get-pending-permissions") {
        // Pending-permission introspection is gateway-internal. The
        // permission_request event already contains everything the
        // UI needs, so the response is now an empty stub.
        writer.send({
          type: "pending-permissions-response",
          sessionId: data.sessionId,
          data: [],
        });
      } else if (data.type === "get-active-sessions") {
        const ids = getActiveSessionIdsViaGateway();
        // Keep the four-provider keys so the legacy UI store does
        // not need to change shape; everything routes through
        // Sati under the hood.
        writer.send({
          type: "active-sessions",
          sessions: { claude: ids, cursor: [], codex: [], gemini: [], sati: ids },
        });
      }
    } catch (error) {
      console.error("[ERROR] Chat WebSocket error:", error.message);
      writer.send({
        type: "error",
        error: error.message,
      });
    }
  });

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    // Remove from connected clients
    connectedClients.delete(ws);
    sessionWatchRegistry.removeClient(ws);
  };

  ws.on("close", (code, reason) => {
    const reasonText = reason?.toString?.() || "";
    console.log(`🔌 Chat client disconnected code=${code}${reasonText ? ` reason=${reasonText}` : ""}`);
    cleanup();
  });
  ws.on("error", () => {
    cleanup();
  });
}

// Handle shell WebSocket connections
function handleShellConnection(ws) {
  console.log("🐚 Shell client connected");
  let shellProcess = null;
  let ptySessionKey = null;
  let urlDetectionBuffer = "";
  const announcedAuthUrls = new Set();

  ws.on("message", async message => {
    try {
      const data = JSON.parse(message);
      console.log("📨 Shell message received:", data.type);

      if (data.type === "init") {
        const projectPath = data.projectPath || process.cwd();
        const sessionId = data.sessionId;
        const hasSession = data.hasSession;
        const provider = data.provider || "sati";
        const initialCommand = data.initialCommand;
        const isPlainShell = data.isPlainShell || (!!initialCommand && !hasSession) || provider === "plain-shell";
        urlDetectionBuffer = "";
        announcedAuthUrls.clear();

        const isLoginCommand =
          initialCommand &&
          (initialCommand.includes("setup-token") ||
            initialCommand.includes("cursor-agent login") ||
            initialCommand.includes("auth login"));

        // Include command hash in session key so different commands get separate sessions
        const commandSuffix =
          isPlainShell && initialCommand ? `_cmd_${Buffer.from(initialCommand).toString("base64").slice(0, 16)}` : "";
        ptySessionKey = `${projectPath}_${sessionId || "default"}${commandSuffix}`;

        // Kill any existing login session before starting fresh
        if (isLoginCommand) {
          const oldSession = ptySessionsMap.get(ptySessionKey);
          if (oldSession) {
            console.log("🧹 Cleaning up existing login session:", ptySessionKey);
            if (oldSession.timeoutId) clearTimeout(oldSession.timeoutId);
            if (oldSession.pty && oldSession.pty.kill) oldSession.pty.kill();
            ptySessionsMap.delete(ptySessionKey);
          }
        }

        const existingSession = isLoginCommand ? null : ptySessionsMap.get(ptySessionKey);
        if (existingSession) {
          console.log("♻️  Reconnecting to existing PTY session:", ptySessionKey);
          shellProcess = existingSession.pty;

          clearTimeout(existingSession.timeoutId);

          ws.send(
            JSON.stringify({
              type: "output",
              data: `\x1b[36m[Reconnected to existing session]\x1b[0m\r\n`,
            }),
          );

          if (existingSession.buffer && existingSession.buffer.length > 0) {
            console.log(`📜 Sending ${existingSession.buffer.length} buffered messages`);
            existingSession.buffer.forEach(bufferedData => {
              ws.send(
                JSON.stringify({
                  type: "output",
                  data: bufferedData,
                }),
              );
            });
          }

          existingSession.ws = ws;

          return;
        }

        console.log("[INFO] Starting shell in:", projectPath);
        console.log(
          "📋 Session info:",
          hasSession ? `Resume session ${sessionId}` : isPlainShell ? "Plain shell mode" : "New session",
        );
        console.log("🤖 Provider:", isPlainShell ? "plain-shell" : provider);
        if (initialCommand) {
          console.log("⚡ Initial command:", initialCommand);
        }

        // First send a welcome message
        let welcomeMsg;
        if (isPlainShell) {
          welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        } else {
          const providerName =
            provider === "sati"
              ? "Sati"
              : provider === "cursor"
                ? "Cursor"
                : provider === "codex"
                  ? "Codex"
                  : provider === "gemini"
                    ? "Gemini"
                    : "Claude";
          welcomeMsg = hasSession
            ? `\x1b[36mResuming ${providerName} session ${sessionId} in: ${projectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
        }

        ws.send(
          JSON.stringify({
            type: "output",
            data: welcomeMsg,
          }),
        );

        try {
          // Validate projectPath — resolve to absolute and verify it exists
          const resolvedProjectPath = path.resolve(projectPath);
          try {
            const stats = fs.statSync(resolvedProjectPath);
            if (!stats.isDirectory()) {
              throw new Error("Not a directory");
            }
          } catch (pathErr) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid project path" }));
            return;
          }

          // Validate sessionId — only allow safe characters
          const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
          if (sessionId && !safeSessionIdPattern.test(sessionId)) {
            ws.send(JSON.stringify({ type: "error", message: "Invalid session ID" }));
            return;
          }

          // Prefer Git Bash on Windows so agent commands can use POSIX shell syntax.
          const shellConfig = getDefaultPtyShell();

          // Build shell command — use cwd for project path (never interpolate into shell string)
          let shellCommand;
          if (isPlainShell) {
            // Plain shell mode - run the initial command in the project directory
            shellCommand = initialCommand;
          } else if (provider === "cursor") {
            if (hasSession && sessionId) {
              shellCommand = `cursor-agent --resume="${sessionId}"`;
            } else {
              shellCommand = "cursor-agent";
            }
          } else if (provider === "codex") {
            // Use codex command; attempt to resume and fall back to a new session when the resume fails.
            if (hasSession && sessionId) {
              shellCommand =
                shellConfig.kind === "powershell"
                  ? `codex resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { codex }`
                  : `codex resume "${sessionId}" || codex`;
            } else {
              shellCommand = "codex";
            }
          } else if (provider === "gemini") {
            const command = initialCommand || "gemini";
            let resumeId = sessionId;
            if (hasSession && sessionId) {
              try {
                // Gemini CLI enforces its own native session IDs, unlike other agents that accept arbitrary string names.
                // The UI only knows about its internal generated `sessionId` (e.g. gemini_1234).
                // We must fetch the mapping from the backend session manager to pass the native `cliSessionId` to the shell.
                const sess = sessionManager.getSession(sessionId);
                if (sess && sess.cliSessionId) {
                  resumeId = sess.cliSessionId;
                  // Validate the looked-up CLI session ID too
                  if (!safeSessionIdPattern.test(resumeId)) {
                    resumeId = null;
                  }
                }
              } catch (err) {
                console.error("Failed to get Gemini CLI session ID:", err);
              }
            }

            if (hasSession && resumeId) {
              shellCommand = `${command} --resume "${resumeId}"`;
            } else {
              shellCommand = command;
            }
          } else if (provider === "sati") {
            const command = initialCommand || "sati";
            if (hasSession && sessionId) {
              shellCommand =
                shellConfig.kind === "powershell"
                  ? `sati --resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { sati }`
                  : `sati --resume "${sessionId}" || sati`;
            } else {
              shellCommand = command;
            }
          } else {
            const command = initialCommand || "claude";
            if (hasSession && sessionId) {
              shellCommand =
                shellConfig.kind === "powershell"
                  ? `claude --resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { claude }`
                  : `claude --resume "${sessionId}" || claude`;
            } else {
              shellCommand = command;
            }
          }

          console.log("🔧 Executing shell command:", shellCommand);

          const shell = shellConfig.shell;
          const shellArgs = shellConfig.args(shellCommand);

          // Use terminal dimensions from client if provided, otherwise use defaults
          const termCols = data.cols || 80;
          const termRows = data.rows || 24;
          console.log("📐 Using terminal dimensions:", termCols, "x", termRows);

          shellProcess = pty.spawn(shell, shellArgs, {
            name: "xterm-256color",
            cols: termCols,
            rows: termRows,
            cwd: resolvedProjectPath,
            env: {
              ...process.env,
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
              FORCE_COLOR: "3",
            },
          });

          console.log("🟢 Shell process started with PTY, PID:", shellProcess.pid);

          ptySessionsMap.set(ptySessionKey, {
            pty: shellProcess,
            ws: ws,
            buffer: [],
            timeoutId: null,
            projectPath,
            sessionId,
          });

          // Handle data output
          shellProcess.onData(data => {
            const session = ptySessionsMap.get(ptySessionKey);
            if (!session) return;

            if (session.buffer.length < 5000) {
              session.buffer.push(data);
            } else {
              session.buffer.shift();
              session.buffer.push(data);
            }

            if (session.ws && session.ws.readyState === WebSocket.OPEN) {
              let outputData = data;

              const cleanChunk = stripAnsiSequences(data);
              urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

              outputData = outputData.replace(
                /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
                "[INFO] Opening in browser: $1",
              );

              const emitAuthUrl = (detectedUrl, autoOpen = false) => {
                const normalizedUrl = normalizeDetectedUrl(detectedUrl);
                if (!normalizedUrl) return;

                const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
                if (isNewUrl) {
                  announcedAuthUrls.add(normalizedUrl);
                  session.ws.send(
                    JSON.stringify({
                      type: "auth_url",
                      url: normalizedUrl,
                      autoOpen,
                    }),
                  );
                }
              };

              const normalizedDetectedUrls = extractUrlsFromText(urlDetectionBuffer)
                .map(url => normalizeDetectedUrl(url))
                .filter(Boolean);

              // Prefer the most complete URL if shorter prefix variants are also present.
              const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
                (url, _, urls) => !urls.some(otherUrl => otherUrl !== url && otherUrl.startsWith(url)),
              );

              dedupedDetectedUrls.forEach(url => emitAuthUrl(url, false));

              if (shouldAutoOpenUrlFromOutput(cleanChunk) && dedupedDetectedUrls.length > 0) {
                const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                  current.length > longest.length ? current : longest,
                );
                emitAuthUrl(bestUrl, true);
              }

              // Send regular output
              session.ws.send(
                JSON.stringify({
                  type: "output",
                  data: outputData,
                }),
              );
            }
          });

          // Handle process exit
          shellProcess.onExit(exitCode => {
            console.log("🔚 Shell process exited with code:", exitCode.exitCode, "signal:", exitCode.signal);
            const session = ptySessionsMap.get(ptySessionKey);
            if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
              session.ws.send(
                JSON.stringify({
                  type: "output",
                  data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${exitCode.signal ? ` (${exitCode.signal})` : ""}\x1b[0m\r\n`,
                }),
              );
            }
            if (session && session.timeoutId) {
              clearTimeout(session.timeoutId);
            }
            ptySessionsMap.delete(ptySessionKey);
            shellProcess = null;
          });
        } catch (spawnError) {
          console.error("[ERROR] Error spawning process:", spawnError);
          ws.send(
            JSON.stringify({
              type: "output",
              data: `\r\n\x1b[31mError: ${spawnError.message}\x1b[0m\r\n`,
            }),
          );
        }
      } else if (data.type === "input") {
        // Send input to shell process
        if (shellProcess && shellProcess.write) {
          try {
            shellProcess.write(data.data);
          } catch (error) {
            console.error("Error writing to shell:", error);
          }
        } else {
          console.warn("No active shell process to send input to");
        }
      } else if (data.type === "resize") {
        // Handle terminal resize
        if (shellProcess && shellProcess.resize) {
          console.log("Terminal resize requested:", data.cols, "x", data.rows);
          shellProcess.resize(data.cols, data.rows);
        }
      }
    } catch (error) {
      console.error("[ERROR] Shell WebSocket error:", error.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "output",
            data: `\r\n\x1b[31mError: ${error.message}\x1b[0m\r\n`,
          }),
        );
      }
    }
  });

  ws.on("close", () => {
    console.log("🔌 Shell client disconnected");

    if (ptySessionKey) {
      const session = ptySessionsMap.get(ptySessionKey);
      if (session) {
        console.log("⏳ PTY session kept alive, will timeout in 30 minutes:", ptySessionKey);
        session.ws = null;

        session.timeoutId = setTimeout(() => {
          console.log("⏰ PTY session timeout, killing process:", ptySessionKey);
          if (session.pty && session.pty.kill) {
            session.pty.kill();
          }
          ptySessionsMap.delete(ptySessionKey);
        }, PTY_SESSION_TIMEOUT);
      }
    }
  });

  ws.on("error", error => {
    console.error("[ERROR] Shell WebSocket error:", error);
  });
}

// Mixed chat attachment upload endpoint. Images are returned as data URLs for
// multimodal input/previews and are also staged under the project so the agent
// can operate on the same bytes by path; other files are staged by path only.
app.post("/api/projects/:projectName/upload-attachments", authenticateToken, async (req, res) => {
  let multerUpload;
  try {
    const multer = (await import("multer")).default;
    const uploadRoot = path.join(os.tmpdir(), "sati-chat-attachments", String(req.user.id));
    const storage = multer.diskStorage({
      destination: async (_req, _file, cb) => {
        try {
          await fsPromises.mkdir(uploadRoot, { recursive: true });
          cb(null, uploadRoot);
        } catch (error) {
          cb(error);
        }
      },
      filename: (_req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        file.originalname = normalizeUploadedFilename(file.originalname);
        cb(null, `${uniqueSuffix}-${sanitizeAttachmentFilename(file.originalname)}`);
      },
    });

    multerUpload = multer({
      storage,
      limits: {
        fileSize: 20 * 1024 * 1024,
        files: 10,
      },
    }).array("attachments", 10);
  } catch (error) {
    console.error("Error configuring attachment upload:", error);
    return res.status(500).json({ error: "Internal server error" });
  }

  multerUpload(req, res, async err => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No attachments provided" });
    }

    let attachmentDir = null;
    try {
      const projectRoot = await extractProjectDirectory(req.params.projectName);
      const targetDir = path.join(
        projectRoot,
        ".tmp",
        "chat-attachments",
        `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      );
      const validation = validatePathInProject(projectRoot, targetDir);
      if (!validation.valid) {
        throw new Error(validation.error || "Invalid attachment target");
      }
      attachmentDir = validation.resolved;

      const images = [];
      const files = [];
      await fsPromises.mkdir(attachmentDir, { recursive: true });

      for (const [index, file] of req.files.entries()) {
        if (CHAT_ATTACHMENT_IMAGE_MIMES.has(file.mimetype)) {
          const buffer = await fsPromises.readFile(file.path);
          const storedFile = await moveUploadedAttachment(file, attachmentDir, index);
          images.push({
            name: storedFile.name,
            data: `data:${file.mimetype};base64,${buffer.toString("base64")}`,
            path: storedFile.path,
            size: storedFile.size,
            mimeType: storedFile.mimeType,
          });
          continue;
        }

        files.push(await moveUploadedAttachment(file, attachmentDir, index));
      }

      if (files.length === 0 && images.length === 0 && attachmentDir) {
        await fsPromises.rm(attachmentDir, { recursive: true, force: true }).catch(() => {});
      }

      res.json({ images, files });
    } catch (error) {
      console.error("Error processing attachments:", error);
      await Promise.all((req.files || []).map(file => fsPromises.unlink(file.path).catch(() => {})));
      if (attachmentDir) {
        await fsPromises.rm(attachmentDir, { recursive: true, force: true }).catch(() => {});
      }
      res.status(500).json({ error: "Failed to process attachments" });
    }
  });
});

// Image upload endpoint
app.post("/api/projects/:projectName/upload-images", authenticateToken, async (req, res) => {
  try {
    const multer = (await import("multer")).default;
    const path = (await import("path")).default;
    const fs = (await import("fs")).promises;
    const os = (await import("os")).default;

    // Configure multer for image uploads
    const storage = multer.diskStorage({
      destination: async (req, file, cb) => {
        const uploadDir = path.join(os.tmpdir(), "sati-image-uploads", String(req.user.id));
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
        cb(null, uniqueSuffix + "-" + sanitizedName);
      },
    });

    const fileFilter = (req, file, cb) => {
      const allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed."));
      }
    };

    const upload = multer({
      storage,
      fileFilter,
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
        files: 5,
      },
    });

    // Handle multipart form data
    upload.array("images", 5)(req, res, async err => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No image files provided" });
      }

      try {
        // Process uploaded images
        const processedImages = await Promise.all(
          req.files.map(async file => {
            // Read file and convert to base64
            const buffer = await fs.readFile(file.path);
            const base64 = buffer.toString("base64");
            const mimeType = file.mimetype;

            // Clean up temp file immediately
            await fs.unlink(file.path);

            return {
              name: file.originalname,
              data: `data:${mimeType};base64,${base64}`,
              size: file.size,
              mimeType: mimeType,
            };
          }),
        );

        res.json({ images: processedImages });
      } catch (error) {
        console.error("Error processing images:", error);
        // Clean up any remaining files
        await Promise.all(req.files.map(f => fs.unlink(f.path).catch(() => {})));
        res.status(500).json({ error: "Failed to process images" });
      }
    });
  } catch (error) {
    console.error("Error in image upload endpoint:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get token usage for a specific session
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
