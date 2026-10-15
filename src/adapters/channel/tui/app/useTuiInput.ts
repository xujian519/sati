import { useInput } from "ink";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { readPermissionSettings, writePermissionSettings } from "../../../../permission/settings.js";
import type { TuiGatewaySurface } from "./gatewaySurface.js";
import { buildPermissionEntry } from "./tuiCommands.js";
import { computeSmartCollapse, flattenSidebarRows, groupSessions } from "./sidebar-helpers.js";
import type { TuiAppState } from "./types.js";

/**
 * `#646` sweep P2.8 从 `TuiApp` 抽出的 input 层：全局 `useInput` 键盘分发。
 *
 * 按「查看器 → 权限队列 → 帮助面板 → 侧栏 → 通用」的顺序命中第一个可消费分支。
 * 行为与原内联块逐字节一致；`openSidebar` / `switchToSession` 由 state 层注入。
 */
export type TuiInputParams = {
  state: TuiAppState;
  setState: Dispatch<SetStateAction<TuiAppState>>;
  gateway: TuiGatewaySurface;
  exit: () => void;
  scrollPage: number;
  suppressUntilRef: MutableRefObject<number>;
  openSidebar: () => Promise<void>;
  switchToSession: (sessionKey: string, summary?: string) => Promise<void>;
};

export function useTuiInput(params: TuiInputParams): void {
  const { state, setState, gateway, exit, scrollPage, suppressUntilRef, openSidebar, switchToSession } = params;

  useInput((input, key) => {
    if (state.viewerContent !== null) return;

    if (state.pendingPermissions.length > 0) {
      const front = state.pendingPermissions[0]!;
      const { requestId, toolName, payload } = front;
      const dequeue = (c: TuiAppState) => ({ ...c, pendingPermissions: c.pendingPermissions.slice(1) });
      if (input === "y") {
        void gateway.permissionDecide({
          sessionKey: state.activeSessionKey,
          requestId,
          decision: "allow",
          remember: false,
        });
        setState(dequeue);
        return;
      }
      if (input === "a") {
        void gateway.permissionDecide({
          sessionKey: state.activeSessionKey,
          requestId,
          decision: "allow",
          remember: true,
        });
        const entry = buildPermissionEntry(toolName, payload);
        const current = readPermissionSettings();
        if (!current.allowedTools.includes(entry)) {
          writePermissionSettings({ allowedTools: [...current.allowedTools, entry] });
        }
        setState(dequeue);
        return;
      }
      if (input === "n") {
        void gateway.permissionDecide({
          sessionKey: state.activeSessionKey,
          requestId,
          decision: "deny",
          reason: "User denied in TUI",
        });
        setState(dequeue);
        return;
      }
      if (key.escape) {
        void gateway.abortTurn({ sessionKey: state.activeSessionKey });
        setState(c => ({ ...c, pendingPermissions: [] }));
        return;
      }
      return;
    }

    // --- Help panel keyboard block ---
    if (state.helpOpen) {
      const tabOrder: Array<"shortcuts" | "settings" | "about"> = ["shortcuts", "settings", "about"];
      if (key.rightArrow || (key.tab && !key.shift)) {
        if (state.helpTab !== "settings") {
          setState(c => {
            const idx = tabOrder.indexOf(c.helpTab);
            return { ...c, helpTab: tabOrder[(idx + 1) % tabOrder.length]! };
          });
        }
        return;
      }
      if (key.leftArrow || (key.shift && key.tab)) {
        if (state.helpTab !== "settings") {
          setState(c => {
            const idx = tabOrder.indexOf(c.helpTab);
            return { ...c, helpTab: tabOrder[(idx - 1 + tabOrder.length) % tabOrder.length]! };
          });
        }
        return;
      }
      if (state.helpTab === "settings") {
        const SETTINGS_COUNT = 3;
        if (key.upArrow) {
          setState(c => ({ ...c, settingsCursor: Math.max(0, c.settingsCursor - 1) }));
          return;
        }
        if (key.downArrow) {
          setState(c => ({ ...c, settingsCursor: Math.min(SETTINGS_COUNT - 1, c.settingsCursor + 1) }));
          return;
        }
        if (key.return || input === " ") {
          setState(c => {
            if (c.settingsCursor === 0) {
              const modes: Array<"default" | "plan" | "bypassPermissions"> = ["default", "plan", "bypassPermissions"];
              const idx = modes.indexOf(c.mode as "default" | "plan" | "bypassPermissions");
              const next = modes[(idx + 1) % modes.length]!;
              if (next === "bypassPermissions") {
                writePermissionSettings({ ...readPermissionSettings(), skipPermissions: true });
              } else {
                writePermissionSettings({ ...readPermissionSettings(), skipPermissions: false });
              }
              return { ...c, mode: next };
            }
            return c;
          });
          return;
        }
      }
      if (input === "1") {
        setState(c => ({ ...c, helpTab: "shortcuts" }));
        return;
      }
      if (input === "2") {
        setState(c => ({ ...c, helpTab: "settings", settingsCursor: 0 }));
        return;
      }
      if (input === "3") {
        setState(c => ({ ...c, helpTab: "about" }));
        return;
      }
      if (key.escape || input === "q") {
        setState(c => ({ ...c, helpOpen: false }));
        return;
      }
      return;
    }

    // --- Sidebar keyboard block ---
    if (state.dashboardMode === "sidebar") {
      const groups = groupSessions(state.sessions, state.sidebarGroupBy);
      const rows = flattenSidebarRows(groups, state.sidebarCollapsed);

      if (key.escape || (key.ctrl && input === "c")) {
        setState(c => ({ ...c, dashboardMode: "closed" }));
        return;
      }
      if (key.ctrl && input === "e") {
        suppressUntilRef.current = Date.now() + 100;
        setState(c => ({ ...c, dashboardMode: "closed" }));
        return;
      }
      if (key.ctrl && input === "s") {
        suppressUntilRef.current = Date.now() + 100;
        setState(c => {
          const next: "project" | "status" = c.sidebarGroupBy === "project" ? "status" : "project";
          const newGroups = groupSessions(c.sessions, next);
          return {
            ...c,
            sidebarGroupBy: next,
            sidebarCursorIndex: 0,
            sidebarCollapsed: computeSmartCollapse(newGroups, c.activeSessionKey),
          };
        });
        return;
      }
      if (key.upArrow && state.input.length === 0) {
        setState(c => ({
          ...c,
          sidebarCursorIndex: Math.max(0, c.sidebarCursorIndex - 1),
        }));
        return;
      }
      if (key.downArrow && state.input.length === 0) {
        setState(c => ({
          ...c,
          sidebarCursorIndex: Math.min(rows.length - 1, c.sidebarCursorIndex + 1),
        }));
        return;
      }
      if (key.return) {
        if (state.input.trim().length > 0) {
          // Input has content — let PromptInput handle submission
        } else {
          const row = rows[state.sidebarCursorIndex];
          if (row?.kind === "header") {
            setState(c => {
              const next = new Set(c.sidebarCollapsed);
              if (next.has(row.groupKey)) next.delete(row.groupKey);
              else next.add(row.groupKey);
              return { ...c, sidebarCollapsed: next };
            });
          } else if (row?.kind === "session") {
            const sessionKey = row.session.sessionKey ?? row.session.sessionId;
            void switchToSession(sessionKey, row.session.summary);
          }
          return;
        }
      }
      if (key.rightArrow && state.input.length === 0) {
        const row = rows[state.sidebarCursorIndex];
        if (row?.kind === "header" && row.collapsed) {
          setState(c => {
            const next = new Set(c.sidebarCollapsed);
            next.delete(row.groupKey);
            return { ...c, sidebarCollapsed: next };
          });
        } else if (row?.kind === "session") {
          const sessionKey = row.session.sessionKey ?? row.session.sessionId;
          void switchToSession(sessionKey, row.session.summary);
        }
        return;
      }
      if (key.leftArrow && state.input.length === 0) {
        const row = rows[state.sidebarCursorIndex];
        if (row?.kind === "header" && !row.collapsed) {
          setState(c => {
            const next = new Set(c.sidebarCollapsed);
            next.add(row.groupKey);
            return { ...c, sidebarCollapsed: next };
          });
        } else if (row?.kind === "session") {
          const headerIdx = rows.findIndex(r => r.kind === "header" && r.groupKey === row.groupKey);
          if (headerIdx >= 0) {
            setState(c => ({ ...c, sidebarCursorIndex: headerIdx }));
          }
        }
        return;
      }
      // Non-navigation keys fall through to normal input handling
    }

    if (key.ctrl && input === "c") {
      if (state.isRunning) {
        void gateway.abortTurn({ sessionKey: state.activeSessionKey });
      } else {
        exit();
      }
      return;
    }

    // Ctrl+E: open sidebar (or toggle off if already open)
    if (key.ctrl && input === "e") {
      suppressUntilRef.current = Date.now() + 100;
      void openSidebar();
      return;
    }

    // Esc: close/interrupt only, never opens anything
    if (key.escape) {
      if (state.isRunning) {
        void gateway.abortTurn({ sessionKey: state.activeSessionKey });
        return;
      }
      if (state.helpOpen) {
        setState(c => ({ ...c, helpOpen: false }));
        return;
      }
      if (state.scrollOffset > 0 || state.focusedIndex !== null) {
        setState(c => ({ ...c, scrollOffset: 0, focusedIndex: null }));
        return;
      }
      return;
    }
    if (input === "?" && state.input.length === 0) {
      setState(current => ({ ...current, helpOpen: !current.helpOpen }));
      return;
    }

    if (key.tab && state.input.length === 0) {
      setState(current => {
        const toolIndices = current.messages.map((m, i) => (m.role === "tool" ? i : -1)).filter(i => i >= 0);
        if (toolIndices.length === 0) return current;

        if (key.shift) {
          if (current.focusedIndex === null) {
            return { ...current, focusedIndex: toolIndices[toolIndices.length - 1]! };
          }
          const pos = toolIndices.indexOf(current.focusedIndex);
          const next = pos <= 0 ? toolIndices[toolIndices.length - 1]! : toolIndices[pos - 1]!;
          return { ...current, focusedIndex: next };
        } else {
          if (current.focusedIndex === null) {
            return { ...current, focusedIndex: toolIndices[0]! };
          }
          const pos = toolIndices.indexOf(current.focusedIndex);
          const next = pos >= toolIndices.length - 1 ? toolIndices[0]! : toolIndices[pos + 1]!;
          return { ...current, focusedIndex: next };
        }
      });
      return;
    }

    if (key.pageUp || (key.shift && key.upArrow)) {
      setState(current => {
        const maxOffset = Math.max(0, current.messages.length - 1);
        return { ...current, scrollOffset: Math.min(maxOffset, current.scrollOffset + scrollPage) };
      });
      return;
    }

    if (key.pageDown || (key.shift && key.downArrow)) {
      setState(current => ({
        ...current,
        scrollOffset: Math.max(0, current.scrollOffset - scrollPage),
      }));
      return;
    }
  });
}
