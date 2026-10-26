import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import type { Gateway, GatewaySessionInfo } from "../../../../gateway/index.js";
import { readPermissionSettings } from "../../../../permission/settings.js";
import { defaultTuiSessionKey } from "./sessionKey.js";
import { ActivityLine } from "./ActivityLine.js";
import { Header } from "./Header.js";
import { HelpDialog } from "./HelpDialog.js";
import { MessageList } from "./MessageList.js";
import { PermissionPrompt } from "./PermissionPrompt.js";
import { PromptInput } from "./PromptInput.js";
import { SessionSidebar } from "./SessionSidebar.js";
import { ToolOutputViewer } from "./ToolOutputViewer.js";
import { groupSessions } from "./sidebar-helpers.js";
import type { TuiAppState } from "./types.js";
import { satiDarkBlueTheme } from "./theme.js";
import { useTuiActions } from "./useTuiActions.js";
import { useTuiInput } from "./useTuiInput.js";
import { readTerminalSize } from "./terminal-size.js";

export type TuiAppProps = {
  gateway: Gateway;
  connection: "remote" | "in_process";
  projectKey?: string;
  sessionKey?: string;
  model?: string;
  cwd?: string;
  serverUrl?: string;
  /** Called when user requests to view a persisted tool output file. */
  onViewOutput?: (path: string) => Promise<void>;
};

/**
 * TUI 根组件（`#646` sweep P2.8 拆分后）。
 *
 * 三层分工：`useTuiActions`（state 层：会话/侧栏/提交/查看器回调）、`useTuiInput`
 * （input 层：`useInput` 键盘分发）、本组件（render 层：`useState` 初始化 + JSX 布局）。
 * `tuiCommands.ts` 承载斜杠命令，与三层解耦。此前本函数 643 行、叠加四类职责，是
 * backlog `TD-*` 记录的 `src/` 顶级 god function 之一。
 */
export function TuiApp(props: TuiAppProps): React.ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = Math.max(10, (readTerminalSize(stdout).rows ?? 28) - 7);
  const initialSessionKey = props.sessionKey ?? defaultTuiSessionKey(props.projectKey);
  // Tracks when a ctrl combo key was pressed so handleInputChange can
  // discard the raw character that ink-text-input receives alongside it.
  // Uses a timestamp because onChange may fire before or after useInput.
  const suppressUntilRef = useRef(0);

  const [state, setState] = useState<TuiAppState>(() => {
    const perm = readPermissionSettings();
    return {
      connection: props.connection,
      activeSessionKey: initialSessionKey,
      sessions: [],
      messages: [],
      activity: [],
      input: "",
      mode: perm.skipPermissions ? "bypassPermissions" : "default",
      isRunning: false,
      helpOpen: false,
      helpTab: "shortcuts",
      settingsCursor: 0,
      scrollOffset: 0,
      focusedIndex: null,
      viewerContent: null,
      viewerTitle: "",
      pendingPermissions: [],
      dashboardMode: "closed",
      sidebarCursorIndex: 0,
      sidebarCollapsed: new Set(),
      sidebarGroupBy: "project",
    };
  });

  const actions = useTuiActions({
    gateway: props.gateway,
    projectKey: props.projectKey,
    stdout,
    exit,
    state,
    setState,
    suppressUntilRef,
  });

  // 会话列表首帧拉取（原 useEffect 面，保留在 render 层，仅依赖 gateway/projectKey）。
  useEffect(() => {
    void props.gateway
      .listSessions({ projectKey: props.projectKey, limit: 8 })
      .then(result => setState(current => ({ ...current, sessions: result.sessions })))
      .catch(() => undefined);
  }, [props.gateway, props.projectKey]);

  const scrollPage = Math.max(1, Math.floor(rows / 2));

  useTuiInput({
    state,
    setState,
    gateway: props.gateway,
    exit,
    scrollPage,
    suppressUntilRef,
    openSidebar: actions.openSidebar,
    switchToSession: actions.switchToSession,
  });

  if (state.viewerContent !== null) {
    return <ToolOutputViewer content={state.viewerContent} title={state.viewerTitle} onClose={actions.closeViewer} />;
  }

  const showSidebar = state.dashboardMode === "sidebar";
  const sidebarGroups = groupSessions(state.sessions, state.sidebarGroupBy);

  const chatContent = (
    <Box flexDirection="column" flexGrow={1} minHeight={12}>
      <Header state={state} model={props.model} cwd={props.cwd ?? process.cwd()} serverUrl={props.serverUrl} />
      <MessageList
        state={state}
        rows={rows}
        model={props.model}
        cwd={props.cwd ?? process.cwd()}
        serverUrl={props.serverUrl}
      />
      {state.helpOpen ? (
        <HelpDialog
          activeTab={state.helpTab}
          mode={state.mode}
          connection={
            state.connection === "remote" ? (props.serverUrl ? `remote (${props.serverUrl})` : "remote") : "local"
          }
          sessionKey={state.activeSessionKey}
          model={props.model}
          settingsCursor={state.settingsCursor}
        />
      ) : null}
      {!state.helpOpen && !showSidebar ? <SessionHint sessions={state.sessions} /> : null}
      {state.pendingPermissions.length > 0 ? (
        <PermissionPrompt
          toolName={state.pendingPermissions[0]!.toolName}
          payload={state.pendingPermissions[0]!.payload}
          queueLength={state.pendingPermissions.length}
        />
      ) : null}
      <ActivityLine state={state} />
      <PromptInput
        value={state.input}
        onChange={actions.handleInputChange}
        onSubmit={value => void actions.handleSubmit(value)}
        isRunning={state.isRunning}
        focus={!state.helpOpen && state.pendingPermissions.length === 0}
      />
    </Box>
  );

  if (showSidebar) {
    return (
      <Box flexDirection="row" minHeight={12}>
        <SessionSidebar
          groups={sidebarGroups}
          collapsed={state.sidebarCollapsed}
          cursorIndex={state.sidebarCursorIndex}
          activeSessionKey={state.activeSessionKey}
          maxRows={rows}
          groupBy={state.sidebarGroupBy}
        />
        {chatContent}
      </Box>
    );
  }

  return chatContent;
}

function SessionHint({ sessions }: { sessions: GatewaySessionInfo[] }): React.ReactNode {
  if (sessions.length <= 1) {
    return null;
  }
  const count = sessions.length;
  return (
    <Text color={satiDarkBlueTheme.subtle} dimColor>
      {count} session{count > 1 ? "s" : ""} · Ctrl+E sidebar · /switch N
    </Text>
  );
}
