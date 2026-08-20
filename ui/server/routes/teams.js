/**
 * 团队活动面板 REST 路由（M4）：浏览器 → ui/server → gateway 协议方法。
 * 面板不直接碰 TeamDb（ui/server 无 teams.db 访问权），全部经 gateway
 * team_panel_snapshot / team_tool_call / panel_heartbeat 转发；权限/校验/事件广播
 * 在 gateway 侧工具层完成。
 */
import express from "express";
import { getSatiGateway } from "../sati-bridge.js";

const router = express.Router();

/**
 * POST /api/teams/panel
 * 面板快照：TeamDb 直查 + SessionPresence 在线态合并（gateway team_panel_snapshot）。
 */
router.post("/panel", async (req, res, next) => {
  try {
    const { sessionKey } = req.body || {};
    const gw = await getSatiGateway();
    const snapshot = await gw.teamPanelSnapshot({ sessionKey });
    res.json(snapshot);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/teams/action
 * 面板操作：直调既有 team_* 工具（gateway team_tool_call；权限/校验/事件广播在
 * gateway 工具层完成）。tool 非 string 或 input 非 object → 400。
 */
router.post("/action", async (req, res, next) => {
  try {
    const { tool, input, sessionKey } = req.body || {};
    if (typeof tool !== "string" || typeof input !== "object" || input === null || Array.isArray(input)) {
      return res.status(400).json({ ok: false, error: { code: "invalid_request", message: "tool/input 必填" } });
    }
    const gw = await getSatiGateway();
    const result = await gw.teamToolCall({ tool, input, sessionKey });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/teams/heartbeat
 * 面板心跳：汇总活跃浏览器会话 key 上报 gateway（SessionPresence.panelTouch）。
 * sessionKeys 非数组 → 400。
 */
router.post("/heartbeat", async (req, res, next) => {
  try {
    const { sessionKeys } = req.body || {};
    if (!Array.isArray(sessionKeys)) {
      return res.status(400).json({ touched: 0 });
    }
    const gw = await getSatiGateway();
    const result = await gw.panelHeartbeat({ sessionKeys });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
