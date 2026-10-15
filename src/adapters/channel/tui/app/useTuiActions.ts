import { readFile } from "node:fs/promises";
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { TuiGatewaySurface } from "./gatewaySurface.js";
import { handleCommand } from "./tuiCommands.js";
import { applyGatewayEventToTuiState, type TuiAppState, type TuiMessage } from "./types.js";
import { computeSmartCollapse, groupSessions } from "./sidebar-helpers.js";
import { MIN_SIDEBAR_COLS } from "./SessionSidebar.js";

/**
 * `#646` sweep P2.8 从 `TuiApp` 抽出的 state（actions）层：会话切换、侧栏打开、
 * 工具输出查看、输入变更、turn 提交等有状态回调。全部依赖显式注入，`TuiApp` 只保留
 * `useState` 初始化与 JSX（render 层）。
 */
export type TuiActionsParams = {
  gateway: TuiGatewaySurface;
  projectKey: string | undefined;
  stdout: NodeJS.WriteStream | undefined;
  exit: () => void;
  state: TuiAppState;
  setState: Dispatch<SetStateAction<TuiAppState>>;
  /** ctrl 组合键按下时间戳：handleInputChange 据此丢弃 ink-text-input 同时收到的裸字符。 */
  suppressUntilRef: MutableRefObject<number>;
};

export function useTuiActions(params: TuiActionsParams) {
  const { gateway, projectKey, stdout, exit, state, setState, suppressUntilRef } = params;

  const handleInputChange = useCallback(
    (next: string) => {
      // Defer to next microtick so useInput's suppress always runs first
      queueMicrotask(() => {
        if (Date.now() < suppressUntilRef.current) {
          return;
        }
        setState(current => ({ ...current, input: next, focusedIndex: null }));
      });
    },
    [setState, suppressUntilRef],
  );

  const openViewer = useCallback(
    (content: string, title: string) => {
      setState(current => ({ ...current, viewerContent: content, viewerTitle: title }));
    },
    [setState],
  );

  const closeViewer = useCallback(() => {
    setState(current => ({ ...current, viewerContent: null, viewerTitle: "" }));
  }, [setState]);

  const switchToSession = useCallback(
    async (sessionKey: string, summary?: string) => {
      void gateway.resumeSession({ sessionKey });
      setState(c => ({
        ...c,
        activeSessionKey: sessionKey,
        dashboardMode: "closed",
        messages: [{ role: "system", text: `Loading session: ${summary || sessionKey}…` }],
        scrollOffset: 0,
        focusedIndex: null,
      }));
      try {
        const result = await gateway.readSessionMessages({
          sessionKey,
          projectKey,
          limit: 50,
          direction: "backward",
        });
        const tuiMessages: TuiMessage[] = [];
        for (const msg of result.messages) {
          if (msg.role === "user" && msg.kind === "text" && msg.text) {
            tuiMessages.push({ role: "user", text: msg.text });
          } else if (msg.role === "assistant" && msg.kind === "text" && msg.text) {
            tuiMessages.push({ role: "assistant", text: msg.text });
          } else if (msg.role === "assistant" && msg.kind === "thinking" && msg.text) {
            const last = tuiMessages.at(-1);
            if (last?.role === "assistant") {
              last.thinking = (last.thinking ?? "") + msg.text;
            }
          } else if (msg.role === "tool" && msg.kind === "tool_result") {
            tuiMessages.push({
              role: "tool",
              text: msg.text ?? (msg.ok ? "ok" : "error"),
              ok: msg.ok,
              toolCallId: msg.toolCallId,
              toolName: msg.toolName,
            });
          } else if (msg.role === "error") {
            tuiMessages.push({ role: "error", text: msg.text ?? "error" });
          }
        }
        setState(c => ({
          ...c,
          messages:
            tuiMessages.length > 0 ? tuiMessages : [{ role: "system", text: `Session: ${summary || sessionKey}` }],
        }));
      } catch {
        // 会话记录读取/回放失败 → 仅提示已切换会话，不阻断切换（fail-safe）。
        setState(c => ({
          ...c,
          messages: [{ role: "system", text: `Switched to session: ${summary || sessionKey}` }],
        }));
      }
    },
    [gateway, projectKey, setState],
  );

  const openSidebar = useCallback(async () => {
    const cols = stdout?.columns ?? 80;
    try {
      const result = await gateway.listSessions({ projectKey, limit: 20 });
      setState(current => {
        const groups = groupSessions(result.sessions, current.sidebarGroupBy);
        const smartCollapse = computeSmartCollapse(groups, current.activeSessionKey);
        return {
          ...current,
          sessions: result.sessions,
          dashboardMode: cols >= MIN_SIDEBAR_COLS ? "sidebar" : "overlay",
          sidebarCursorIndex: 0,
          sidebarCollapsed: smartCollapse,
        };
      });
    } catch {
      // if fetch fails, use cached sessions
      const groups = groupSessions(state.sessions, state.sidebarGroupBy);
      setState(current => {
        const smartCollapse = computeSmartCollapse(groups, current.activeSessionKey);
        return {
          ...current,
          dashboardMode: cols >= MIN_SIDEBAR_COLS ? "sidebar" : "overlay",
          sidebarCursorIndex: 0,
          sidebarCollapsed: smartCollapse,
        };
      });
    }
  }, [gateway, projectKey, stdout, state.sessions, state.sidebarGroupBy, setState]);

  const openToolOutput = useCallback(
    async (msg: Extract<TuiMessage, { role: "tool" }>) => {
      const SCROLLBACK_LINE_THRESHOLD = 50;
      let text = msg.fullText ?? msg.text;
      if (msg.resultPath) {
        try {
          text = await readFile(msg.resultPath, "utf-8");
        } catch {
          // fallback to what we have
        }
      }
      const lineCount = text.split("\n").length;
      if (lineCount < SCROLLBACK_LINE_THRESHOLD && stdout) {
        stdout.write(`\n--- ${msg.toolName ?? "tool"} output ---\n${text}\n---\n`);
      } else {
        openViewer(text, msg.toolName ?? "tool output");
      }
    },
    [stdout, openViewer],
  );

  const handleSubmit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      setState(current => ({ ...current, input: "" }));

      if (!trimmed) {
        if (!state.isRunning && state.focusedIndex !== null) {
          const focused = state.messages[state.focusedIndex];
          if (focused?.role === "tool") {
            setState(current => {
              const msgs = [...current.messages];
              const msg = msgs[state.focusedIndex!];
              if (msg?.role === "tool") {
                msgs[state.focusedIndex!] = { ...msg, expanded: !msg.expanded };
              }
              return { ...current, messages: msgs };
            });
            return;
          }
        }
        if (!state.isRunning) {
          const lastTool = [...state.messages]
            .reverse()
            .find(m => m.role === "tool" && ((m.lineCount ?? 0) > 4 || m.resultPath)) as
            | Extract<TuiMessage, { role: "tool" }>
            | undefined;
          if (lastTool) {
            void openToolOutput(lastTool);
          }
        }
        return;
      }
      if (state.isRunning || state.pendingPermissions.length > 0) {
        return;
      }
      try {
        if (
          await handleCommand(
            trimmed,
            gateway,
            projectKey,
            setState,
            exit,
            openToolOutput,
            state.messages,
            openSidebar,
            switchToSession,
          )
        ) {
          return;
        }
      } catch (error) {
        setState(c => ({
          ...c,
          messages: [
            ...c.messages,
            { role: "error", text: `Command failed: ${error instanceof Error ? error.message : String(error)}` },
          ],
        }));
        return;
      }

      setState(current => ({
        ...current,
        messages: [...current.messages, { role: "user", text: trimmed }],
        isRunning: true,
        scrollOffset: 0,
        focusedIndex: null,
      }));

      try {
        for await (const event of gateway.submitTurn({
          sessionKey: state.activeSessionKey,
          channelKey: "tui",
          projectKey,
          message: trimmed,
          mode: state.mode,
        })) {
          setState(current => {
            const partial = applyGatewayEventToTuiState(current, event);
            return {
              ...current,
              ...partial,
              scrollOffset: partial.messages !== current.messages ? 0 : current.scrollOffset,
            };
          });
        }
      } catch (error) {
        setState(current => ({
          ...current,
          isRunning: false,
          messages: [
            ...current.messages,
            { role: "error", text: error instanceof Error ? error.message : String(error) },
          ],
        }));
      }
    },
    [
      exit,
      gateway,
      projectKey,
      openToolOutput,
      openSidebar,
      switchToSession,
      setState,
      state.activeSessionKey,
      state.isRunning,
      state.messages,
      state.mode,
      state.focusedIndex,
      state.pendingPermissions,
    ],
  );

  return {
    handleInputChange,
    openViewer,
    closeViewer,
    openSidebar,
    switchToSession,
    openToolOutput,
    handleSubmit,
  };
}
