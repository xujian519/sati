/**
 * ui/server 项目/会话路由（B5-2 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：项目列表/会话/
 * 重命名/删除/创建 + SSE 会话搜索。
 */

import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import {
  addProjectManually,
  deleteProject,
  deleteSession,
  getProjects,
  getSessions,
  renameProject,
  searchConversations,
} from "../projects.js";
import { applyCustomSessionNames, sessionNamesDb } from "../database/db.js";
import { broadcastProgress } from "../websocket/broadcast.js";

const router = Router();

const VALID_PROVIDERS = ["sati"];

router.get("/api/projects", authenticateToken, async (req, res) => {
  try {
    const projects = await getProjects(broadcastProgress);
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/api/projects/:projectName/sessions", authenticateToken, async (req, res) => {
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
router.put("/api/projects/:projectName/rename", authenticateToken, async (req, res) => {
  try {
    const { displayName } = req.body;
    await renameProject(req.params.projectName, displayName);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete session endpoint
router.delete("/api/projects/:projectName/sessions/:sessionId", authenticateToken, async (req, res) => {
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
router.put("/api/sessions/:sessionId/rename", authenticateToken, async (req, res) => {
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
router.delete("/api/projects/:projectName", authenticateToken, async (req, res) => {
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
router.post("/api/projects/create", authenticateToken, async (req, res) => {
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
router.get("/api/search/conversations", authenticateToken, async (req, res) => {
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

export default router;
