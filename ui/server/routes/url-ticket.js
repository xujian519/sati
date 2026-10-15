/**
 * URL 票据签发路由（#626）。
 *
 * 登录态（会话 Authorization 头）换取一份短期、scope 受限的 `url-ticket`，供无法自定义头的
 * 载体（`<iframe>`/`<img>`/EventSource/dashboard 文档）访问受限资源，替代把会话 JWT 拼进 URL。
 * 只接受会话头（`authenticateSessionOnly`），拒绝用一份短票据续换更长/更宽的票据。
 */

import { Router } from "express";
import { authenticateSessionOnly, generateUrlTicket, urlTicketTtl } from "../middleware/auth.js";

const router = Router();

/** 票据允许的用途白名单：越界一律 400，避免把签发端点当万能凭据铸造器。 */
const ALLOWED_PURPOSES = new Set(["file", "qr", "sse", "dashboard"]);

router.post("/api/url-ticket", authenticateSessionOnly, (req, res) => {
  const { purpose, project, path } = req.body || {};
  if (typeof purpose !== "string" || !ALLOWED_PURPOSES.has(purpose)) {
    return res.status(400).json({ error: "Invalid purpose" });
  }
  const bindings = { purpose };
  if (typeof project === "string" && project) bindings.project = project;
  if (typeof path === "string" && path) bindings.path = path;

  res.setHeader("Cache-Control", "no-store");
  return res.json({
    token: generateUrlTicket(req.user, bindings),
    expiresIn: urlTicketTtl(purpose),
  });
});

export default router;
