import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { readFile } from "node:fs/promises";
import type { Gateway, GatewayMode, GatewaySessionInfo } from "../../../../gateway/index.js";
import { defaultTuiSessionKey } from "../TuiChannel.js";
import { ActivityLine } from "./ActivityLine.js";
import { Header } from "./Header.js";
import { HelpDialog } from "./HelpDialog.js";
import { MessageList } from "./MessageList.js";
import { PromptInput } from "./PromptInput.js";
import { ToolOutputViewer } from "./ToolOutputViewer.js";
import { applyGatewayEventToTuiState, type TuiAppState, type TuiMessage } from "./types.js";
import { pilotDeckDarkBlueTheme } from "./theme.js";

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

export function TuiApp(props: TuiAppProps): React.ReactNode {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = Math.max(10, (stdout?.rows ?? 28) - 7);
  const initialSessionKey = props.sessionKey ?? defaultTuiSessionKey(props.projectKey);
  const [state, setState] = useState<TuiAppState>({
    connection: props.connection,
    activeSessionKey: initialSessionKey,
    sessions: [],
    messages: [],
    activity: [],
    input: "",
    mode: "default",
    isRunning: false,
    helpOpen: false,
    scrollOffset: 0,
    focusedIndex: null,
    viewerContent: null,
    viewerTitle: "",
  });

  useEffect(() => {
    void props.gateway
      .listSessions({ projectKey: props.projectKey, limit: 8 })
      .then((result) => setState((current) => ({ ...current, sessions: result.sessions })))
      .catch(() => undefined);
  }, [props.gateway, props.projectKey]);

  const handleInputChange = useCallback((next: string) => {
    setState((current) => ({ ...current, input: next, focusedIndex: null }));
  }, []);

  const openViewer = useCallback((content: string, title: string) => {
    setState((current) => ({ ...current, viewerContent: content, viewerTitle: title }));
  }, []);

  const closeViewer = useCallback(() => {
    setState((current) => ({ ...current, viewerContent: null, viewerTitle: "" }));
  }, []);

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
      setState((current) => ({ ...current, input: "" }));

      if (!trimmed) {
        if (!state.isRunning && state.focusedIndex !== null) {
          const focused = state.messages[state.focusedIndex];
          if (focused?.role === "tool") {
            setState((current) => {
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
          const lastTool = [...state.messages].reverse().find(
            (m) => m.role === "tool" && ((m.lineCount ?? 0) > 4 || m.resultPath),
          ) as Extract<TuiMessage, { role: "tool" }> | undefined;
          if (lastTool) {
            void openToolOutput(lastTool);
          }
        }
        return;
      }
      if (state.isRunning) {
        return;
      }
      if (await handleCommand(trimmed, props.gateway, props.projectKey, setState, exit, openViewer, openToolOutput, state.messages)) {
        return;
      }

      setState((current) => ({
        ...current,
        messages: [...current.messages, { role: "user", text: trimmed }],
        isRunning: true,
        scrollOffset: 0,
        focusedIndex: null,
      }));

      try {
        for await (const event of props.gateway.submitTurn({
          sessionKey: state.activeSessionKey,
          channelKey: "tui",
          projectKey: props.projectKey,
          message: trimmed,
          mode: state.mode,
        })) {
          setState((current) => ({ ...current, ...applyGatewayEventToTuiState(current, event) }));
        }
      } catch (error) {
        setState((current) => ({
          ...current,
          isRunning: false,
          messages: [
            ...current.messages,
            { role: "error", text: error instanceof Error ? error.message : String(error) },
          ],
        }));
      }
    },
    [exit, props.gateway, props.projectKey, openToolOutput, openViewer, state.activeSessionKey, state.isRunning, state.messages, state.mode, state.focusedIndex],
  );

  const scrollPage = Math.max(1, Math.floor(rows / 2));

  useInput((input, key) => {
    if (state.viewerContent !== null) return;

    if (key.ctrl && input === "c") {
      if (state.isRunning) {
        void props.gateway.abortTurn({ sessionKey: state.activeSessionKey });
      } else {
        exit();
      }
      return;
    }
    if (key.escape) {
      setState((current) => ({ ...current, helpOpen: false, scrollOffset: 0, focusedIndex: null }));
      return;
    }
    if (input === "?" && state.input.length === 0) {
      setState((current) => ({ ...current, helpOpen: !current.helpOpen }));
      return;
    }

    if (key.tab && state.input.length === 0) {
      setState((current) => {
        const toolIndices = current.messages
          .map((m, i) => (m.role === "tool" ? i : -1))
          .filter((i) => i >= 0);
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
      setState((current) => {
        const maxOffset = Math.max(0, current.messages.length - 1);
        return { ...current, scrollOffset: Math.min(maxOffset, current.scrollOffset + scrollPage) };
      });
      return;
    }

    if (key.pageDown || (key.shift && key.downArrow)) {
      setState((current) => ({
        ...current,
        scrollOffset: Math.max(0, current.scrollOffset - scrollPage),
      }));
      return;
    }
  });

  if (state.viewerContent !== null) {
    return (
      <ToolOutputViewer
        content={state.viewerContent}
        title={state.viewerTitle}
        onClose={closeViewer}
      />
    );
  }

  return (
    <Box flexDirection="column" minHeight={12}>
      <Header state={state} model={props.model} cwd={props.cwd ?? process.cwd()} serverUrl={props.serverUrl} />
      <MessageList
        state={state}
        rows={rows}
        model={props.model}
        cwd={props.cwd ?? process.cwd()}
        serverUrl={props.serverUrl}
      />
      {state.helpOpen ? <HelpDialog /> : null}
      {state.helpOpen ? null : <SessionHint sessions={state.sessions} />}
      <ActivityLine state={state} />
      <PromptInput
        value={state.input}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        isRunning={state.isRunning}
        focus={!state.helpOpen}
      />
    </Box>
  );
}

async function handleCommand(
  command: string,
  gateway: Gateway,
  projectKey: string | undefined,
  setState: React.Dispatch<React.SetStateAction<TuiAppState>>,
  exit: () => void,
  openViewer: (content: string, title: string) => void,
  openToolOutput: (msg: Extract<TuiMessage, { role: "tool" }>) => Promise<void>,
  messages: TuiMessage[],
): Promise<boolean> {
  if (!command.startsWith("/")) {
    return false;
  }
  const [name, ...args] = command.split(/\s+/);
  switch (name) {
    case "/new": {
      const result = await gateway.newSession({ channelKey: "tui", projectKey });
      setState((current) => ({
        ...current,
        activeSessionKey: result.sessionKey,
        messages: [{ role: "system", text: `New session: ${result.sessionKey}` }],
      }));
      return true;
    }
    case "/sessions": {
      const result = await gateway.listSessions({ projectKey, limit: 8 });
      setState((current) => ({ ...current, sessions: result.sessions }));
      return true;
    }
    case "/mode": {
      const mode = (args[0] ?? "default") as GatewayMode;
      setState((current) => ({
        ...current,
        mode,
        messages: [...current.messages, { role: "system", text: `Mode: ${mode}` }],
      }));
      return true;
    }
    case "/view": {
      const n = parseInt(args[0] ?? "", 10);
      const tools = messages.filter(
        (m): m is Extract<TuiMessage, { role: "tool" }> =>
          m.role === "tool" && ((m.lineCount ?? 0) > 4 || !!m.resultPath || !!m.fullText),
      );
      if (tools.length === 0) {
        setState((current) => ({
          ...current,
          messages: [...current.messages, { role: "system", text: "No tool output to view." }],
        }));
        return true;
      }
      const target = !isNaN(n) && n >= 1 && n <= tools.length
        ? tools[n - 1]!
        : tools[tools.length - 1]!;
      void openToolOutput(target);
      return true;
    }
    case "/clear":
      setState((current) => ({ ...current, messages: [], focusedIndex: null }));
      return true;
    case "/help":
      setState((current) => ({ ...current, helpOpen: !current.helpOpen }));
      return true;
    case "/exit":
      exit();
      return true;
    default:
      setState((current) => ({
        ...current,
        messages: [...current.messages, { role: "error", text: `Unknown command ${name}` }],
      }));
      return true;
  }
}

function SessionHint({ sessions }: { sessions: GatewaySessionInfo[] }): React.ReactNode {
  if (sessions.length === 0) {
    return null;
  }
  return (
    <Text color={pilotDeckDarkBlueTheme.subtle}>
      sessions: {sessions.map((session) => session.summary || session.sessionId).slice(0, 4).join(" · ")}
    </Text>
  );
}
