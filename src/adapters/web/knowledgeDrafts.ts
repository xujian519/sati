/**
 * `/api/web/knowledge-drafts` 路由 —— 知识草稿闸门（WS2）的人工确认通道。
 *
 * 走 GatewayServer 既有 `/api/web/*` HTTP 面（Bearer token 鉴权），**不新增
 * WebSocket 协议帧**（D2 决策：避开协议版本与事件矩阵成本；UI 面板后续立项）。
 *
 * 降级不静默（铁律 11）：knowledge.db 缺失一律 404 knowledge_db_not_found，
 * 与「库里暂无草稿」（200 + 空数组）可区分。
 */

import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";
import { resolveKnowledgeDbPaths } from "../../knowledge/config.js";
import {
  confirmKnowledgeDraft,
  listPendingKnowledgeDrafts,
  rejectKnowledgeDraft,
} from "../../knowledge/personal-note/drafts.js";
import { ensureNotesDb } from "../../knowledge/personal-note/notes-db.js";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function errorBody(code: string, message: string): unknown {
  return { error: { code, message } };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    // 请求体非 JSON：回 undefined，由调用方按非法 body 处理（fail-safe）。
    return undefined;
  }
}

/** 处理 /api/web/knowledge-drafts* 请求；返回 false 表示非本路由职责。 */
export async function handleKnowledgeDraftRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const pathname = url.pathname;
  if (pathname !== "/api/web/knowledge-drafts" && !pathname.startsWith("/api/web/knowledge-drafts/")) {
    return false;
  }

  try {
    return await dispatchKnowledgeDraftRoute(request, response, url, pathname);
  } catch (error) {
    // sidecar 打开/写入期异常：fail-closed + 可观测（500 带原因），不静默吞。
    sendJson(
      response,
      500,
      errorBody("knowledge_drafts_error", error instanceof Error ? error.message : String(error)),
    );
    return true;
  }
}

async function dispatchKnowledgeDraftRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  pathname: string,
): Promise<boolean> {
  const { knowledgeDb, notesDb } = resolveKnowledgeDbPaths();

  if (pathname === "/api/web/knowledge-drafts" && request.method === "GET") {
    const limitParam = Number(url.searchParams.get("limit") ?? "100");
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : 100;
    const sidecar = ensureNotesDb(notesDb, knowledgeDb);
    try {
      sendJson(response, 200, { drafts: listPendingKnowledgeDrafts(notesDb, { limit }) });
    } finally {
      sidecar.close();
    }
    return true;
  }

  if (pathname === "/api/web/knowledge-drafts/confirm" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (typeof body?.id !== "string" || !body.id) {
      sendJson(response, 400, errorBody("invalid_body", "Expected { id }"));
      return true;
    }
    if (!knowledgeDb || !existsSync(knowledgeDb)) {
      sendJson(response, 404, errorBody("knowledge_db_not_found", "未找到 knowledge.db，无法投影入库"));
      return true;
    }
    const sidecar = ensureNotesDb(notesDb, knowledgeDb);
    try {
      const result = confirmKnowledgeDraft({ notesDb, knowledgeDb }, body.id);
      if (!result.ok) {
        const status =
          result.code === "draft_not_found" || result.code === "knowledge_db_not_found"
            ? 404
            : result.code === "projection_failed"
              ? 500
              : 409;
        sendJson(response, status, errorBody(result.code, result.message));
        return true;
      }
      sendJson(response, 200, { ok: true, documentId: result.documentId });
    } finally {
      sidecar.close();
    }
    return true;
  }

  if (pathname === "/api/web/knowledge-drafts/reject" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (typeof body?.id !== "string" || !body.id) {
      sendJson(response, 400, errorBody("invalid_body", "Expected { id }"));
      return true;
    }
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
    const sidecar = ensureNotesDb(notesDb, knowledgeDb);
    try {
      const result = rejectKnowledgeDraft(notesDb, body.id, reason);
      if (!result.ok) {
        sendJson(response, result.code === "draft_not_found" ? 404 : 409, errorBody(result.code, result.message));
        return true;
      }
      sendJson(response, 200, { ok: true });
    } finally {
      sidecar.close();
    }
    return true;
  }

  sendJson(response, 404, errorBody("not_found", `No knowledge-drafts route for ${pathname}`));
  return true;
}
