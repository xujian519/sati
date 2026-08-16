#!/usr/bin/env node
// Load environment variables before other imports execute
import { assertRequiredSatiEnv } from "./load-env.js";
// Install global fetch proxy (SATI_PROXY / HTTPS_PROXY) before any network calls
import { installGlobalProxy } from "./utils/proxy.js";
installGlobalProxy();

import fs from "fs";
import path from "path";

const __dirname = import.meta.dirname;
// Dev-mode SPA fallback redirect target (see `/{*splat}` handler below).
const VITE_PORT = process.env.VITE_PORT || 5173;

assertRequiredSatiEnv();
console.log("SERVER_PORT from runtime config:", process.env.SERVER_PORT);

import express from "express";
import http from "http";
import cors from "cors";

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
import agentRoutes from "./routes/agent.js";
import updateRoutes from "./routes/update.js";
import projectsRoutes from "./routes/projects.js";
import userRoutes from "./routes/user.js";
import pluginsRoutes from "./routes/plugins.js";
import messagesRoutes from "./routes/messages.js";
import projectPreviewRoutes from "./routes/project-preview.js";
import projectUploadsRoutes from "./routes/project-uploads.js";
import tokenUsageRoutes from "./routes/token-usage.js";
import projectFilesRoutes from "./routes/project-files.js";
import projectSessionsRoutes from "./routes/project-sessions.js";
import systemRoutes from "./routes/system.js";

import { validateApiKey, authenticateToken } from "./middleware/auth.js";
import { getConnectableHost } from "../shared/networkHosts.js";
import { createChatWebSocketServer } from "./websocket/chat.js";
import { startServer } from "./services/server-boot.js";

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

app.use(projectSessionsRoutes);
app.use(projectFilesRoutes);
app.use(projectPreviewRoutes);
app.use(projectUploadsRoutes);
app.use(tokenUsageRoutes);
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

startServer(server);
