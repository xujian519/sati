/**
 * ui/server 系统路由（B5-1 分片）：health / runtime-config / removed
 * providers / ccr 仪表盘 / always-on cron / memory-dashboard。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）。
 */

import fs from "fs";
import path from "path";
import express, { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { readPermissionSettings } from "../services/permissionSettings.js";
import { readSatiConfigFile } from "../services/satiConfig.js";
import { getAlwaysOnDashboardEvents } from "../services/always-on-events.js";
import { getProjectCronJobsOverview } from "../projects.js";
import {
  getRouterDashboardData,
  getRouterSessionStats,
  getRouterStatsSummary,
  getSatiGateway,
} from "../sati-bridge.js";
import { MEMORY_DASHBOARD_DIR } from "./memory.js";

const router = Router();

const installMode = fs.existsSync(path.join(import.meta.dirname, "..", "..", ".git")) ? "git" : "npm";

router.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    installMode,
  });
});

router.get("/api/agents/runtime-config", authenticateToken, (_req, res) => {
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

router.get("/api/ccr/dashboard", authenticateToken, (_req, res) => {
  try {
    res.json(getRouterDashboardData());
  } catch (error) {
    console.error("[router-dashboard] failed:", error);
    res.status(500).json({ error: error?.message || "router-dashboard failed" });
  }
});

router.get("/api/always-on/events", authenticateToken, async (req, res) => {
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

router.get("/api/always-on/cron-jobs", authenticateToken, async (_req, res) => {
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

router.get("/api/ccr/health", authenticateToken, (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    port: null,
    embedded: true,
    backend: "sati-router",
  });
});

router.get("/api/ccr/config", authenticateToken, (_req, res) => {
  // The legacy CCR YAML schema is no longer the source of truth for
  // model routing — that lives in Sati config now. Return null so
  // the legacy useRouterSettings hook simply renders the "no config"
  // empty state instead of a config editor.
  res.json(null);
});

router.get("/api/ccr/stats/summary", authenticateToken, (_req, res) => {
  try {
    res.json(getRouterStatsSummary());
  } catch (error) {
    res.status(500).json({ error: error?.message || "router-stats-summary failed" });
  }
});

router.get("/api/ccr/stats/sessions/:sessionId", authenticateToken, (req, res) => {
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

router.get("/memory-dashboard", authenticateToken, (req, res) => {
  const indexPath = path.join(MEMORY_DASHBOARD_DIR, "index.html");
  if (!fs.existsSync(indexPath)) {
    res.status(404).type("text/plain").send("Memory dashboard assets not bundled.");
    return;
  }
  res.sendFile(indexPath);
});

router.use(
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
router.use("/memory-dashboard", (_req, res) => {
  res.status(404).type("text/plain").send("Not found in memory-dashboard.");
});

export default router;
