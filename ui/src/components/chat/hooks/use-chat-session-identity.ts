import { useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  getSessionRequestParams,
  isReadOnlySession,
  type Project,
  type ProjectSession,
  type SessionRequestParams,
} from "../../../types/app";

/**
 * 「当前在看哪个会话」的解析 —— 从 `useChatSessionState` 拆出的独立 hook（issue #467）。
 *
 * 这里只做**搬家**：`currentSessionId` 这一份 state 加渲染期的镜像块，语义与拆分前逐行一致。
 * 镜像块存在的原因（拆分前就写在原地的注释，原样保留）：
 *
 * Bug fix (was: `selectedSession?.id || currentSessionId || null`): when the user clicks
 * "+ session" the parent flips `selectedSession` to null, but `currentSessionId` still holds
 * the previous session's id for one render tick — so store reads would briefly return the OLD
 * session's messages and bleed them into the freshly-cleared chat view. Strategy:
 *
 *   1. Mirror `selectedSession.id` into `currentSessionId` during render whenever the selection
 *      changes — drops any stale carryover.
 *   2. Expose an `effectiveCurrentSessionId` ref so the *current* render uses the cleared value,
 *      not the lagging React state — the same ref doubles as the **live** session identity that
 *      in-flight fetches read when they come back (issue #476): `loadAllMessages` /
 *      `loadOlderMessages` are useCallbacks, so a session switch mid-flight cannot reach the
 *      closure they were created with.
 *   3. While the selection is stable but `currentSessionId` advances (e.g. backend emits
 *      `session_created` for a from-welcome submit before the parent navigates), keep mirroring
 *      forward so the new id is visible immediately.
 *
 * 单一真源：`currentSessionId` 只此一份；调用方与子 hook 都经返回值读写。
 */

export interface UseChatSessionIdentityArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  /** 「待建会话」标记：为它保留交班窗口，别把已经交到手的会话号当成陈旧值清掉。 */
  pendingViewSessionRef: MutableRefObject<{ sessionId: string | null; startedAt: number } | null>;
}

/**
 * 这批取数是不是**别的会话**的（issue #476）：发起时的会话身份必须仍是实时身份。
 * 判据只此一处，分页与全量两条取数路径共用，避免各写一遍再漂移。
 */
export function isFetchForOtherSession(
  liveSessionIdRef: MutableRefObject<string | null>,
  requestSessionId: string,
): boolean {
  return liveSessionIdRef.current !== requestSessionId;
}

export function useChatSessionIdentity({
  selectedProject,
  selectedSession,
  pendingViewSessionRef,
}: UseChatSessionIdentityArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);

  const selSid = selectedSession?.id ?? null;
  const lastSeenSelSidRef = useRef<string | null>(selSid);
  const effectiveCurrentRef = useRef<string | null>(selSid);
  if (lastSeenSelSidRef.current !== selSid) {
    lastSeenSelSidRef.current = selSid;
    effectiveCurrentRef.current = selSid;
    if (currentSessionId !== selSid) {
      setCurrentSessionId(selSid);
    }
  } else if (currentSessionId !== effectiveCurrentRef.current) {
    const pendingSessionId = pendingViewSessionRef.current?.sessionId ?? null;
    const isPendingSessionHandoff = Boolean(currentSessionId) && pendingSessionId === currentSessionId;
    if (selSid) {
      effectiveCurrentRef.current = selSid;
      if (currentSessionId !== selSid) {
        setCurrentSessionId(selSid);
      }
    } else if (isPendingSessionHandoff) {
      effectiveCurrentRef.current = currentSessionId;
    } else {
      effectiveCurrentRef.current = null;
      if (currentSessionId !== null) {
        setCurrentSessionId(null);
      }
    }
  }
  const pendingSessionIdForRender = pendingViewSessionRef.current?.sessionId ?? null;
  // No selectedSession means we are intentionally on a fresh chat surface unless
  // the backend is still handing us the real id for the first message.
  const hasStaleUnselectedCurrentSession =
    Boolean(currentSessionId) && !selSid && pendingSessionIdForRender !== currentSessionId;
  if (hasStaleUnselectedCurrentSession) {
    effectiveCurrentRef.current = null;
    setCurrentSessionId(null);
  }

  const activeSessionId = selSid ?? effectiveCurrentRef.current;
  const activeScrollKey = selectedProject && activeSessionId ? `${selectedProject.name}:${activeSessionId}` : null;
  const sessionIsReadOnly = isReadOnlySession(selectedSession);
  const sessionRequestParams: SessionRequestParams = useMemo(
    () => getSessionRequestParams(selectedSession),
    [selectedSession],
  );

  return {
    currentSessionId,
    setCurrentSessionId,
    /** 实时会话身份：在途取数返回时读它判「这批数据还算不算当前会话的」（issue #476）。 */
    liveSessionIdRef: effectiveCurrentRef,
    activeSessionId,
    activeScrollKey,
    sessionIsReadOnly,
    sessionRequestParams,
  };
}
