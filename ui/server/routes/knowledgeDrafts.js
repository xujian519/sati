/**
 * 知识草稿确认 REST 路由（WS2 UI 通道）：浏览器 → ui/server → gateway HTTP 面。
 *
 * 经 `getSatiGatewayWithReset()` 的既有模式是 WS 协议方法，但 knowledge-drafts
 * 刻意没有 WS 方法（D2 决策，见 docs/notes/implemented/2026-10-14-knowledge-draft-gate.md）——
 * 这里走 gateway 同端口的 `/api/web/*` HTTP 面 + server-token Bearer。
 *
 * 语义全部在 gateway 侧（src/adapters/web/knowledgeDrafts.ts）：本路由只做
 * 透传——状态码与错误体原样回浏览器（降级不静默，铁律 11 的 UI 侧口径）。
 */
import express from "express";
import { readGatewayToken } from "../sati-bridge.js";

/**
 * gateway 同端口 HTTP 面基址（与 sati-bridge 的 GATEWAY_URL 同默认值，
 * ws://…/ws → http://…）。HTTP 透传专用；WS 连接仍走 sati-bridge。
 */
const GATEWAY_HTTP_BASE = (process.env.SATI_GATEWAY_URL || "ws://127.0.0.1:19789/ws")
  .replace(/^ws/, "http")
  .replace(/\/ws\/?$/, "");

const router = express.Router();

async function forward(pathname, { method = "GET", body, query } = {}) {
  const token = await readGatewayToken();
  if (!token) {
    return { status: 503, payload: { error: { code: "gateway_not_ready", message: "gateway token 不可用" } } };
  }
  const queryString = query ? `?${new URLSearchParams(query).toString()}` : "";
  let response;
  try {
    response = await fetch(`${GATEWAY_HTTP_BASE}/api/web/knowledge-drafts${pathname}${queryString}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // gateway 未启动/网络不可达：502 可观测兜底，不静默吞（降级不静默，铁律 11）。
    return { status: 502, payload: { error: { code: "gateway_unreachable", message: "gateway 不可达" } } };
  }
  const payload = await response.json().catch(() => {
    // 非 JSON 响应体（gateway 异常页/空响应）：按空载荷呈现，状态码仍可观测。
    return null;
  });
  return { status: response.status, payload: payload ?? { error: { code: "empty_response" } } };
}

// GET /?limit=<n> — 列出 pending 草稿（sidecar 数据源，不依赖 knowledge.db）
router.get("/", async (req, res) => {
  const limit = req.query.limit;
  const result = await forward("", { query: limit !== undefined ? { limit: String(limit) } : undefined });
  res.status(result.status).json(result.payload);
});

// POST /confirm — { id } → { ok, documentId }
router.post("/confirm", async (req, res) => {
  const id = req.body?.id;
  if (typeof id !== "string" || !id) {
    return res.status(400).json({ error: { code: "invalid_request", message: "id is required" } });
  }
  const result = await forward("/confirm", { method: "POST", body: { id } });
  res.status(result.status).json(result.payload);
});

// POST /reject — { id, reason? } → { ok }
router.post("/reject", async (req, res) => {
  const id = req.body?.id;
  if (typeof id !== "string" || !id) {
    return res.status(400).json({ error: { code: "invalid_request", message: "id is required" } });
  }
  const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : undefined;
  const result = await forward("/reject", { method: "POST", body: { id, ...(reason ? { reason } : {}) } });
  res.status(result.status).json(result.payload);
});

export default router;
