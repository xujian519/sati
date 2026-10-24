import { useCallback, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { ToastKind } from "../../contexts/ToastContext";
import { api } from "../../utils/api";
import { UI_TIMEOUTS } from "../../constants/timeouts";
import type { ChatInterfaceProps, ChatMessage, ChatRunMode } from "../chat/types/types";
import type { Project, ProjectSession } from "../../types/app";
import { getDraftInputStorageKey, safeLocalStorage } from "../chat/utils/chatStorage";

type Translate = TFunction<"chat", undefined>;

/**
 * fork / 编辑最后一轮 / 重新生成最后一轮（#646 B2.6）。
 * 三个回调的守卫、错误兜底与副作用顺序与搬迁前逐字一致；`isForkPending`
 * 随簇迁移以保持「一个动作一个 pending 闸门」。
 */
export function useChatForkActions({
  selectedProject,
  selectedSession,
  currentSessionId,
  isLoading,
  sessionIsReadOnly,
  chatMessages,
  textareaRef,
  setRunMode,
  addToast,
  t,
  setInput,
  onNavigateToSession,
  scrollToBottom,
  beginEditLastTurn,
  regenerateLastTurn,
}: {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  isLoading: boolean;
  sessionIsReadOnly: boolean;
  chatMessages: ChatMessage[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setRunMode: Dispatch<SetStateAction<ChatRunMode>>;
  addToast: (type: ToastKind, message: string) => void;
  t: Translate;
  setInput: (value: string) => void;
  onNavigateToSession?: ChatInterfaceProps["onNavigateToSession"];
  scrollToBottom?: () => void;
  beginEditLastTurn: (sessionId: string, content: string) => void;
  regenerateLastTurn: (sessionId: string, content: string) => void;
}) {
  const [isForkPending, setIsForkPending] = useState(false);

  const handleFork = useCallback(
    async (message: ChatMessage, _carriedPreview: number) => {
      if (isForkPending || isLoading || sessionIsReadOnly) return;
      const sessionId = currentSessionId || selectedSession?.id;
      const fromEntryId = message.entryId;
      if (!sessionId || !fromEntryId || !selectedProject) {
        addToast("error", t("fork.missingTarget", { defaultValue: "Cannot fork this message." }));
        return;
      }

      const projectPath = selectedProject.fullPath || selectedProject.path || "";
      setIsForkPending(true);
      try {
        const response = await api.forkSession(sessionId, { projectPath, fromEntryId });
        let result: { newSessionId?: string; prefillText?: string; runMode?: string; mode?: string; error?: string } =
          {};
        try {
          result = await response.json();
        } catch {
          // 非 JSON 响应 → 按空结果处理，下方分支已兜底。
          result = {};
        }
        if (!response.ok) {
          throw new Error(result?.error || `Fork failed (${response.status})`);
        }
        const newSessionId = result?.newSessionId;
        if (!newSessionId) {
          throw new Error("Fork did not return a new session id");
        }
        setRunMode(
          result.runMode === "ask" ? "ask" : result.mode === "plan" || result.runMode === "plan" ? "plan" : "agent",
        );

        if (typeof window.refreshProjects === "function") {
          try {
            await window.refreshProjects();
          } catch {
            // Keep the fork usable even if the sidebar refresh races/fails.
          }
        }

        const forkDraft =
          typeof result.prefillText === "string"
            ? result.prefillText
            : message.type === "user"
              ? message.content || ""
              : "";
        const forkDraftStorageKey = getDraftInputStorageKey(selectedProject.name, newSessionId);
        if (forkDraft) {
          safeLocalStorage.setItem(forkDraftStorageKey, forkDraft);
        } else {
          safeLocalStorage.removeItem(forkDraftStorageKey);
        }

        onNavigateToSession?.(newSessionId);
        setInput(forkDraft);
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          scrollToBottom?.();
        });
        // Messages load asynchronously after the session switch; scroll again
        // once the carried history has had a chance to render.
        setTimeout(() => scrollToBottom?.(), UI_TIMEOUTS.CHAT_FORK_SCROLL_AFTER_RENDER_MS);
        addToast(
          "success",
          t("fork.ready", {
            defaultValue: "Fork created — edit the prompt and send when ready.",
          }),
        );
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        addToast("error", messageText || t("fork.failed", { defaultValue: "Fork failed." }));
      } finally {
        setIsForkPending(false);
      }
    },
    [
      addToast,
      currentSessionId,
      isForkPending,
      isLoading,
      sessionIsReadOnly,
      onNavigateToSession,
      scrollToBottom,
      selectedProject,
      selectedSession?.id,
      setInput,
      t,
      textareaRef,
      setRunMode,
    ],
  );

  // 协议 1.7：编辑最后一条 user 消息——预填 composer，提交时改发 edit-last-turn。
  const handleEditLastUserMessage = useCallback(
    (message: ChatMessage) => {
      if (isLoading || sessionIsReadOnly || !message.entryId) return;
      const sessionId = currentSessionId || selectedSession?.id;
      if (!sessionId) return;
      beginEditLastTurn(sessionId, String(message.content ?? ""));
    },
    [beginEditLastTurn, currentSessionId, isLoading, selectedSession?.id, sessionIsReadOnly],
  );

  // 协议 1.7：重新生成最后一轮——取最后一条 user 消息原文做乐观气泡，
  // 服务端以最后一条 accepted_input 为准（含其改写文本）。
  const handleRegenerateLastTurn = useCallback(
    (message: ChatMessage) => {
      if (isLoading || sessionIsReadOnly || !message.entryId) return;
      const sessionId = currentSessionId || selectedSession?.id;
      if (!sessionId) return;
      const lastUserMessage = [...chatMessages]
        .reverse()
        .find(m => m.type === "user" && String(m.content ?? "").trim());
      if (!lastUserMessage) return;
      regenerateLastTurn(sessionId, String(lastUserMessage.content ?? ""));
    },
    [chatMessages, currentSessionId, isLoading, regenerateLastTurn, selectedSession?.id, sessionIsReadOnly],
  );

  return { isForkPending, handleFork, handleEditLastUserMessage, handleRegenerateLastTurn };
}
