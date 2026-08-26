/**
 * 项目看板（Kanban）REST 路由（Phase 5）：浏览器 → ui/server → gateway 协议方法。
 *
 * 看板数据面在 `src/board/`，UI 不与 src/ 直连；本路由经 sati-bridge 共享的
 * gateway 客户端（getSatiGatewayWithReset）调用 `kanban_*` 方法。路由不直接
 * 碰文件/DB，全部转发到 gateway（唯一事实源），`kanban_updated` 实时推送由
 * sati-bridge 的 notification 转发接线完成（见 kanban-events）。
 *
 * gateway 访问统一走 getSatiGatewayWithReset：gateway 重启后缓存死连接自动复位，
 * 失败仍记录日志并转发错误给 express 错误处理链。
 */
import express from "express";
import { getSatiGatewayWithReset } from "../sati-bridge.js";

const router = express.Router();

/** 每个 gateway kanban 方法的最小入参校验：projectKey（字符串）为公共前提。 */
function requireProjectKey(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 生成一个「转发到 gateway kanban 方法」的 handler。
 * @param {string} method gateway 方法名（如 "kanbanGet"）。
 * @param {(body: Record<string, unknown>) => object} pickParams 从 body 提取 forward 参数。
 * @param {(body: Record<string, unknown>) => string | null} validate 返回错误信息或 null。
 */
function proxy(method, pickParams, validate) {
  return async (req, res, next) => {
    try {
      const body = req.body || {};
      const validationError = validate(body);
      if (validationError) {
        return res.status(400).json({ ok: false, error: { code: "invalid_request", message: validationError } });
      }
      const gw = await getSatiGatewayWithReset();
      if (typeof gw[method] !== "function") {
        return res.status(501).json({
          ok: false,
          error: { code: "not_configured", message: `gateway 不支持 ${method}（可能版本过低）` },
        });
      }
      const params = pickParams(body);
      const result = await gw[method](params);
      res.json(result);
    } catch (error) {
      console.error(`[kanban:${method}] gateway 调用失败:`, error);
      next(error);
    }
  };
}

const requireProject = body => (requireProjectKey(body.projectKey) ? null : "projectKey 必填且非空");
const pickProject = body => ({ projectKey: body.projectKey });

// ─── 读板 / 订阅 ─────────────────────────────────────────────────────────────

router.post(
  "/get",
  proxy(
    "kanbanGet",
    body => ({ projectKey: body.projectKey, includeArchived: body.includeArchived ?? false }),
    requireProject,
  ),
);

router.post(
  "/subscribe",
  proxy(
    "kanbanSubscribe",
    body => ({ projectId: body.projectId }),
    body => (requireProjectKey(body.projectId) ? null : "projectId 必填且非空"),
  ),
);

router.post(
  "/unsubscribe",
  proxy(
    "kanbanUnsubscribe",
    body => ({ projectId: body.projectId }),
    body => (requireProjectKey(body.projectId) ? null : "projectId 必填且非空"),
  ),
);

// ─── 卡片 CRUD ───────────────────────────────────────────────────────────────

router.post(
  "/add-card",
  proxy(
    "kanbanAddCard",
    body => ({
      projectKey: body.projectKey,
      columnId: body.columnId,
      title: body.title,
      note: body.note,
      label: body.label,
      priority: body.priority,
      color: body.color,
      dueDate: body.dueDate,
    }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (typeof body.columnId !== "string" || !body.columnId) return "columnId 必填";
      if (typeof body.title !== "string" || !body.title.trim()) return "title 必填";
      return null;
    },
  ),
);

router.post(
  "/update-card",
  proxy(
    "kanbanUpdateCard",
    body => ({
      projectKey: body.projectKey,
      cardId: body.cardId,
      title: body.title,
      note: body.note,
      label: body.label,
      priority: body.priority,
      color: body.color,
      dueDate: body.dueDate,
    }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (typeof body.cardId !== "string" || !body.cardId) return "cardId 必填";
      return null;
    },
  ),
);

router.post(
  "/move-card",
  proxy(
    "kanbanMoveCard",
    body => ({
      projectKey: body.projectKey,
      cardId: body.cardId,
      columnId: body.columnId,
      toIndex: body.toIndex,
    }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (typeof body.cardId !== "string" || !body.cardId) return "cardId 必填";
      if (typeof body.columnId !== "string" || !body.columnId) return "columnId 必填";
      return null;
    },
  ),
);

router.post(
  "/archive-card",
  proxy(
    "kanbanArchiveCard",
    body => ({ projectKey: body.projectKey, cardId: body.cardId }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (typeof body.cardId !== "string" || !body.cardId) return "cardId 必填";
      return null;
    },
  ),
);

router.post(
  "/restore-card",
  proxy(
    "kanbanRestoreCard",
    body => ({ projectKey: body.projectKey, cardId: body.cardId }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (typeof body.cardId !== "string" || !body.cardId) return "cardId 必填";
      return null;
    },
  ),
);

router.post(
  "/purge-card",
  proxy(
    "kanbanPurgeCard",
    body => ({ projectKey: body.projectKey, cardId: body.cardId }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (typeof body.cardId !== "string" || !body.cardId) return "cardId 必填";
      return null;
    },
  ),
);

router.post(
  "/duplicate-card",
  proxy(
    "kanbanDuplicateCard",
    body => ({
      projectKey: body.projectKey,
      cardId: body.cardId,
      columnId: body.columnId,
      toIndex: body.toIndex,
    }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (typeof body.cardId !== "string" || !body.cardId) return "cardId 必填";
      return null;
    },
  ),
);

// ─── 批量 ────────────────────────────────────────────────────────────────────

router.post(
  "/bulk-archive-cards",
  proxy(
    "kanbanBulkArchiveCards",
    body => ({ projectKey: body.projectKey, ids: body.ids }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (!Array.isArray(body.ids) || body.ids.length === 0) return "ids 必填且非空";
      return null;
    },
  ),
);

router.post(
  "/bulk-move-cards",
  proxy(
    "kanbanBulkMoveCards",
    body => ({ projectKey: body.projectKey, ids: body.ids, columnId: body.columnId }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (!Array.isArray(body.ids) || body.ids.length === 0) return "ids 必填且非空";
      if (typeof body.columnId !== "string" || !body.columnId) return "columnId 必填";
      return null;
    },
  ),
);

// ─── 跨项目移动 ──────────────────────────────────────────────────────────────

router.post(
  "/move-to-project",
  proxy(
    "kanbanMoveCardToProject",
    body => ({ projectKey: body.projectKey, cardId: body.cardId, toProjectKey: body.toProjectKey }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (typeof body.cardId !== "string" || !body.cardId) return "cardId 必填";
      if (!requireProjectKey(body.toProjectKey)) return "toProjectKey 必填且非空";
      return null;
    },
  ),
);

// ─── 列管理 ──────────────────────────────────────────────────────────────────

router.post(
  "/add-column",
  proxy(
    "kanbanAddColumn",
    body => ({ projectKey: body.projectKey, title: body.title, color: body.color }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (typeof body.title !== "string" || !body.title.trim()) return "title 必填";
      return null;
    },
  ),
);

router.post(
  "/rename-column",
  proxy(
    "kanbanRenameColumn",
    body => ({ projectKey: body.projectKey, columnId: body.columnId, title: body.title }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (typeof body.columnId !== "string" || !body.columnId) return "columnId 必填";
      if (typeof body.title !== "string" || !body.title.trim()) return "title 必填";
      return null;
    },
  ),
);

router.post(
  "/delete-column",
  proxy(
    "kanbanDeleteColumn",
    body => ({ projectKey: body.projectKey, columnId: body.columnId }),
    body => {
      if (!requireProjectKey(body.projectKey)) return "projectKey 必填且非空";
      if (typeof body.columnId !== "string" || !body.columnId) return "columnId 必填";
      return null;
    },
  ),
);

// ─── 撤销 ────────────────────────────────────────────────────────────────────

router.post("/undo", proxy("kanbanUndo", pickProject, requireProject));

export default router;
