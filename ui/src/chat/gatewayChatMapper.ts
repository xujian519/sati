/**
 * P2b-3：出站消息帧 → gateway 协议调用映射（纯函数）。
 *
 * 直连模式下，前端 Chat 组件仍发送原有的 ws 协议帧（sati-command /
 * abort-session / permission-response / elicitation-response），由本模块
 * 映射为 gateway 协议调用。与传输解耦、可单测。
 *
 * 覆盖帧（与 ui/server `sati-bridge.js` 接收的帧对齐）：
 *   - sati-command        → submit_turn（无 sessionId 时先 new_session）
 *   - abort-session       → abort_turn
 *   - permission-response → permission_decide
 *   - elicitation-response→ elicitation_respond
 *   - 其他帧              → ignore（直连模式不转发给 ui/server）
 */

import type { WebGatewayMode, WebAgentRunMode, WebChannelAttachment, WebSubmitTurnInput } from "@sati/web-client";

export type SubmitTurnLike = {
  sessionKey: string;
  channelKey: string;
  message: string;
  projectKey?: string;
  attachments?: WebChannelAttachment[];
  runMode?: WebAgentRunMode;
  mode?: WebGatewayMode;
  basePermissionMode?: WebGatewayMode;
};

export type GatewayCall =
  | { kind: "submit_turn"; input: SubmitTurnLike }
  | {
      kind: "new_session_then_submit";
      newSession: { projectKey?: string; channelKey: string; hint?: string };
      submit: SubmitTurnLike;
    }
  | { kind: "abort_turn"; input: { sessionKey: string; runId?: string; reason?: string } }
  | {
      kind: "permission_decide";
      input: { sessionKey: string; requestId: string; decision: "allow" | "deny"; remember?: boolean; reason?: string };
    }
  | { kind: "elicitation_respond"; input: { sessionKey: string; requestId: string; answer: unknown } }
  | { kind: "ignore" };

type OutgoingFrame = {
  type?: string;
  command?: string;
  options?: Record<string, unknown>;
  sessionId?: string;
  provider?: string;
  requestId?: string;
  allow?: boolean;
  rememberEntry?: boolean;
  message?: string;
  answer?: unknown;
  [key: string]: unknown;
};

function toWebChannelAttachment(images?: unknown): WebChannelAttachment[] | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  return images
    .filter((image): image is Record<string, unknown> => typeof image === "object" && image !== null)
    .map(image => ({
      type: "image" as const,
      mimeType: typeof image.mimeType === "string" ? image.mimeType : "image/png",
      data: typeof image.data === "string" ? image.data : String(image.data ?? ""),
    }));
}

function buildSubmitTurn(command: string, options: Record<string, unknown>): SubmitTurnLike {
  const projectKey = typeof options.projectPath === "string" ? options.projectPath : undefined;
  return {
    sessionKey: typeof options.sessionId === "string" ? options.sessionId : "",
    channelKey: "web",
    message: command,
    ...(projectKey ? { projectKey } : {}),
    ...(typeof options.runMode === "string" ? { runMode: options.runMode as WebAgentRunMode } : {}),
    ...(typeof options.permissionMode === "string" ? { mode: options.permissionMode as WebGatewayMode } : {}),
    ...(typeof options.basePermissionMode === "string"
      ? { basePermissionMode: options.basePermissionMode as WebGatewayMode }
      : {}),
    ...(toWebChannelAttachment(options.images)
      ? { attachments: toWebChannelAttachment(options.images) as WebChannelAttachment[] }
      : {}),
  };
}

/** 把 Chat 组件发出的 ws 帧映射为 gateway 协议调用。 */
export function mapOutgoingMessage(frame: OutgoingFrame): GatewayCall {
  switch (frame.type) {
    case "sati-command": {
      const command = typeof frame.command === "string" ? frame.command : "";
      const options = (frame.options ?? {}) as Record<string, unknown>;
      const sessionId = typeof options.sessionId === "string" ? options.sessionId : "";
      const projectKey = typeof options.projectPath === "string" ? options.projectPath : undefined;
      if (sessionId) {
        return { kind: "submit_turn", input: buildSubmitTurn(command, options) };
      }
      return {
        kind: "new_session_then_submit",
        newSession: {
          ...(projectKey ? { projectKey } : {}),
          channelKey: "web",
          hint: command,
        },
        submit: buildSubmitTurn(command, options),
      };
    }

    case "abort-session": {
      const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : "";
      if (!sessionId) return { kind: "ignore" };
      return { kind: "abort_turn", input: { sessionKey: sessionId } };
    }

    case "permission-response": {
      const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
      const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : "";
      if (!requestId || !sessionId) return { kind: "ignore" };
      return {
        kind: "permission_decide",
        input: {
          sessionKey: sessionId,
          requestId,
          decision: frame.allow ? "allow" : "deny",
          ...(typeof frame.rememberEntry === "boolean" ? { remember: frame.rememberEntry } : {}),
          ...(typeof frame.message === "string" && frame.message.trim() ? { reason: frame.message.trim() } : {}),
        },
      };
    }

    case "elicitation-response": {
      const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
      const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : "";
      if (!requestId || !sessionId) return { kind: "ignore" };
      return { kind: "elicitation_respond", input: { sessionKey: sessionId, requestId, answer: frame.answer } };
    }

    default:
      return { kind: "ignore" };
  }
}

/** 便捷类型：与 WebSubmitTurnInput 对齐的 submit 入参。 */
export type { WebSubmitTurnInput };
