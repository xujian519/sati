import { Router } from "express";
import { homedir } from "node:os";
import { join } from "node:path";
import { authenticateToken } from "../middleware/auth.js";
import { InputError, NotFoundError, WorkspaceStore } from "../../../src/map/index.js";

const router = Router();
const store = new WorkspaceStore(join(homedir(), ".sati", "map", "workspaces.json"));

function sendError(res, error) {
  if (error instanceof InputError) {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  if (error instanceof NotFoundError) {
    return res.status(404).json({ error: error.message, code: error.code });
  }
  if (error?.code === "CONFLICT") {
    return res.status(409).json({ error: error.message, code: "CONFLICT" });
  }
  console.error("[map] unexpected error:", error);
  return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
}

// GET /api/map/workspaces
router.get("/api/map/workspaces", authenticateToken, async (_req, res) => {
  try {
    const workspaces = await store.list();
    res.json(workspaces);
  } catch (error) {
    sendError(res, error);
  }
});

// POST /api/map/workspaces
router.post("/api/map/workspaces", authenticateToken, async (req, res) => {
  try {
    const { title } = req.body || {};
    const summary = await store.create(title);
    res.status(201).json(summary);
  } catch (error) {
    sendError(res, error);
  }
});

// GET /api/map/workspaces/:id
router.get("/api/map/workspaces/:id", authenticateToken, async (req, res) => {
  try {
    const workspace = await store.get(req.params.id);
    res.json(workspace);
  } catch (error) {
    sendError(res, error);
  }
});

// POST /api/map/workspaces/:id/threads
router.post("/api/map/workspaces/:id/threads", authenticateToken, async (req, res) => {
  try {
    const thread = await store.createThread(req.params.id, req.body || {});
    res.status(201).json(thread);
  } catch (error) {
    sendError(res, error);
  }
});

// POST /api/map/threads/:id/branch
router.post("/api/map/threads/:id/branch", authenticateToken, async (req, res) => {
  try {
    const thread = await store.branch(req.params.id, req.body || {});
    res.status(201).json(thread);
  } catch (error) {
    sendError(res, error);
  }
});

// PATCH /api/map/threads/:id
router.patch("/api/map/threads/:id", authenticateToken, async (req, res) => {
  try {
    const thread = await store.updateThread(req.params.id, req.body || {});
    res.json(thread);
  } catch (error) {
    sendError(res, error);
  }
});

// DELETE /api/map/threads/:id
router.delete("/api/map/threads/:id", authenticateToken, async (req, res) => {
  try {
    const result = await store.removeThread(req.params.id);
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

// POST /api/map/sessions/sync
router.post("/api/map/sessions/sync", authenticateToken, async (req, res) => {
  try {
    const { sessions, removedSessionIds } = req.body || {};
    const { summaries, threads } = await store.syncSessions(sessions, removedSessionIds);
    res.json({ workspaces: summaries, threads });
  } catch (error) {
    sendError(res, error);
  }
});

// GET /api/map/sessions/:id/history (optional MVP — not implemented)
router.get("/api/map/sessions/:id/history", authenticateToken, async (req, res) => {
  res.status(501).json({ error: "session history projection is not implemented in MVP", sessionId: req.params.id });
});

export default router;
