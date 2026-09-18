import { useCallback, useEffect, useRef } from "react";
import { UI_TIMEOUTS } from "../../../constants/timeouts";
import { logWarn } from "../../../utils/logging";
import { grantSatiToolPermission } from "../utils/chatPermissions";
import { isTemporarySessionId } from "../utils/sessionLauncher";
import type { PendingApproval, PermissionGrantResult, SessionPermissionGrantResult } from "../types/types";
import type { UseChatComposerStateArgs } from "./useChatComposerState";

/**
 * 会话权限与审批层：中止会话、工具权限授予（单次/本会话）、权限请求决策、输出门禁审批。
 *
 * 从 `useChatComposerState.ts` 搬出（#159 N01 缝 4a），**被搬代码逐字未改**。
 * 两个 effect（订阅 `session-permission-grant-result`、卸载时把未决的授权 promise 全部
 * 落成失败）随本层一起搬，且**调用点特意选在它们原来的位置**——effect 的相对顺序有语义，
 * 换位置就无法用 token 比对证明等价。本层依赖（props 与 `cancelBusySendQueue`）在该位置
 * 之前均已就绪，故无需任何后绑定。
 */

type SessionPermissionsOptions = Pick<
  UseChatComposerStateArgs,
  | "currentSessionId"
  | "selectedSession"
  | "canAbortSession"
  | "sendMessage"
  | "subscribe"
  | "pendingViewSessionRef"
  | "pendingPermissionRequests"
  | "setPendingPermissionRequests"
  | "setPendingApprovals"
  | "setCanAbortSession"
  | "setIsAborting"
  | "setClaudeStatus"
  | "setSatiStatus"
> & {
  /** 中止会话时一并取消排队的发送（来自忙碌队列层）。 */
  cancelBusySendQueue: () => void;
};

type SessionPermissionsApi = {
  handleAbortSession: () => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => PermissionGrantResult;
  handleGrantSessionToolPermission: (suggestion: { entry: string; toolName: string }) => SessionPermissionGrantResult;
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleApprovalDecision: (approval: PendingApproval, verdict: "adopted" | "rejected", feedback?: string) => void;
};

export function useSessionPermissions({
  currentSessionId,
  selectedSession,
  canAbortSession,
  sendMessage,
  subscribe,
  pendingViewSessionRef,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  setPendingApprovals,
  setCanAbortSession,
  setIsAborting,
  setClaudeStatus,
  setSatiStatus,
  cancelBusySendQueue,
}: SessionPermissionsOptions): SessionPermissionsApi {
  /* 未决的"本会话授权"promise：由下面的订阅 effect 落定，卸载时统一失败。 */
  const pendingSessionGrantResolversRef = useRef(new Map<string, (result: PermissionGrantResult) => void>());

  useEffect(() => {
    if (!subscribe) {
      return undefined;
    }
    return subscribe(message => {
      if (message?.type !== "session-permission-grant-result") {
        return;
      }
      const requestId = typeof message.requestId === "string" ? message.requestId : "";
      if (!requestId) {
        return;
      }
      const resolve = pendingSessionGrantResolversRef.current.get(requestId);
      if (!resolve) {
        return;
      }
      pendingSessionGrantResolversRef.current.delete(requestId);
      resolve({ success: message.granted === true });
    });
  }, [subscribe]);

  useEffect(() => {
    // 拷贝 ref 对象（而非当前值），cleanup 始终读取最新 Map，避免未来
    // ref 被重新赋值时清理到旧实例。
    const pendingResolversRef = pendingSessionGrantResolversRef;
    return () => {
      pendingResolversRef.current.forEach(resolve => resolve({ success: false }));
      pendingResolversRef.current.clear();
    };
  }, []);

  const handleAbortSession = useCallback(() => {
    if (!canAbortSession) {
      return;
    }

    const pendingSessionId = typeof window !== "undefined" ? sessionStorage.getItem("pendingSessionId") : null;

    const candidateSessionIds = [
      currentSessionId,
      pendingViewSessionRef.current?.sessionId || null,
      pendingSessionId,
      selectedSession?.id || null,
    ];

    const targetSessionId =
      candidateSessionIds.find(sessionId => Boolean(sessionId) && !isTemporarySessionId(sessionId)) || null;

    if (!targetSessionId) {
      logWarn("Abort requested but no concrete session ID is available yet.");
      return;
    }

    cancelBusySendQueue();

    sendMessage({
      type: "abort-session",
      sessionId: targetSessionId,
      provider: "sati",
    });

    setCanAbortSession(false);
    setIsAborting(true);
    setSatiStatus({
      text: "Stopping",
      tokens: 0,
      can_interrupt: false,
    });
  }, [
    canAbortSession,
    cancelBusySendQueue,
    currentSessionId,
    pendingViewSessionRef,
    selectedSession?.id,
    sendMessage,
    setCanAbortSession,
    setIsAborting,
    setSatiStatus,
  ]);

  const handleGrantToolPermission = useCallback((suggestion: { entry: string; toolName: string }) => {
    if (!suggestion) {
      return { success: false };
    }
    // adapter. After the PolitDeck-only migration every provider
    // routes through the same gateway PermissionContext, so we let
    // every provider persist its grants to localStorage and have the
    // sati server pick them up via the gateway PermissionRuntime
    // on the next turn.
    return grantSatiToolPermission(suggestion.entry);
  }, []);

  const handleGrantSessionToolPermission = useCallback(
    (suggestion: { entry: string; toolName: string }) => {
      if (!suggestion?.entry) {
        return { success: false };
      }

      const sessionId = [selectedSession?.id, currentSessionId, pendingViewSessionRef.current?.sessionId].find(
        candidate => candidate && !isTemporarySessionId(candidate),
      );

      if (!sessionId) {
        return { success: false };
      }

      const requestId = `session-permission-grant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let settled = false;
      const completion = new Promise<PermissionGrantResult>(resolve => {
        pendingSessionGrantResolversRef.current.set(requestId, result => {
          settled = true;
          resolve(result);
        });
        window.setTimeout(() => {
          if (settled) {
            return;
          }
          pendingSessionGrantResolversRef.current.delete(requestId);
          resolve({ success: false });
        }, UI_TIMEOUTS.PERMISSION_GRANT_TIMEOUT_MS);
      });

      sendMessage({
        type: "session-permission-grant",
        requestId,
        sessionId,
        entry: suggestion.entry,
        toolName: suggestion.toolName,
      });
      completion.catch(() => undefined);
      return { success: true, pending: true, completion };
    },
    [currentSessionId, pendingViewSessionRef, selectedSession?.id, sendMessage],
  );

  const handlePermissionDecision = useCallback(
    (
      requestIds: string | string[],
      decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
    ) => {
      const ids = Array.isArray(requestIds) ? requestIds : [requestIds];
      const validIds = ids.filter(Boolean);
      if (validIds.length === 0) {
        return;
      }

      validIds.forEach(requestId => {
        const pending = pendingPermissionRequests.find(r => r.requestId === requestId);
        if (pending?.isElicitation) {
          // Elicitation flow (e.g. `ask_user_question`): submit selections
          // through GatewayElicitationBus, not GatewayPermissionBus.
          const submitted =
            (decision?.updatedInput as
              | {
                  answers?: Record<string, string | string[]>;
                  annotations?: Record<string, { preview?: string; notes?: string }>;
                }
              | undefined) ?? {};
          const submittedAnswers = submitted.answers ?? {};
          const hasAnswers = Object.keys(submittedAnswers).length > 0;
          const answer =
            decision?.allow && hasAnswers
              ? {
                  type: "answered" as const,
                  answers: submittedAnswers,
                  ...(submitted.annotations ? { annotations: submitted.annotations } : {}),
                }
              : {
                  type: "cancelled" as const,
                  reason: decision?.message ?? (decision?.allow ? "skipped" : "declined"),
                };
          sendMessage({
            type: "elicitation-response",
            requestId,
            sessionId: pending?.sessionId,
            answer,
          });
          return;
        }

        sendMessage({
          type: "permission-response",
          requestId,
          sessionId: pending?.sessionId,
          allow: Boolean(decision?.allow),
          updatedInput: decision?.updatedInput,
          message: decision?.message,
          rememberEntry: decision?.rememberEntry,
        });
      });

      setPendingPermissionRequests(previous => {
        const next = previous.filter(request => !validIds.includes(request.requestId));
        if (next.length === 0) {
          setClaudeStatus(null);
          setSatiStatus(null);
        }
        return next;
      });
    },
    [pendingPermissionRequests, sendMessage, setClaudeStatus, setSatiStatus, setPendingPermissionRequests],
  );

  /**
   * 输出门禁 HITL 审批决策：通过（adopted）/ 拒绝（rejected，可带理由）。
   * 经 /ws 桥 approval-response 转发 gateway.approvalDecide；乐观移除卡片，
   * 服务端 approval_resolved 广播为兜底。
   */
  const handleApprovalDecision = useCallback(
    (approval: PendingApproval, verdict: "adopted" | "rejected", feedback?: string) => {
      const sessionId = currentSessionId || selectedSession?.id;
      if (!sessionId) return;
      sendMessage({
        type: "approval-response",
        sessionId,
        pendingIndex: approval.pendingIndex,
        verdict,
        ...(verdict === "rejected" && feedback ? { feedback } : {}),
      });
      setPendingApprovals(prev => prev.filter(a => a.pendingIndex !== approval.pendingIndex));
    },
    [currentSessionId, selectedSession?.id, sendMessage, setPendingApprovals],
  );

  return {
    handleAbortSession,
    handleGrantToolPermission,
    handleGrantSessionToolPermission,
    handlePermissionDecision,
    handleApprovalDecision,
  };
}
