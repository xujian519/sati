import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Gateway, GatewayMode, GatewaySessionInfo } from "../../../../gateway/index.js";
import { defaultTuiSessionKey } from "../TuiChannel.js";
import { ActivityLine } from "./ActivityLine.js";
import { Header } from "./Header.js";
import { HelpDialog } from "./HelpDialog.js";
import { MessageList } from "./MessageList.js";
import { PromptInput } from "./PromptInput.js";
import { applyGatewayEventToTuiState, type TuiAppState } from "./types.js";
import { politDeckDarkBlueTheme } from "./theme.js";

export type TuiAppProps = {
  gateway: Gateway;
  connection: "remote" | "in_process";
  projectKey?: string;
  sessionKey?: string;
  model?: string;
  cwd?: string;
  serverUrl?: string;
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
  });

  useEffect(() => {
    void props.gateway
      .listSessions({ projectKey: props.projectKey, limit: 8 })
      .then((result) => setState((current) => ({ ...current, sessions: result.sessions })))
      .catch(() => undefined);
  }, [props.gateway, props.projectKey]);

  const handleInputChange = useCallback((next: string) => {
    setState((current) => ({ ...current, input: next }));
  }, []);

  const handleSubmit = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      setState((current) => ({ ...current, input: "" }));
      if (!trimmed || state.isRunning) {
        return;
      }
      if (await handleCommand(trimmed, props.gateway, props.projectKey, setState, exit)) {
        return;
      }

      setState((current) => ({
        ...current,
        messages: [...current.messages, { role: "user", text: trimmed }],
        isRunning: true,
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
    [exit, props.gateway, props.projectKey, state.activeSessionKey, state.isRunning, state.mode],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (state.isRunning) {
        void props.gateway.abortTurn({ sessionKey: state.activeSessionKey });
      } else {
        exit();
      }
      return;
    }
    if (key.escape) {
      setState((current) => ({ ...current, helpOpen: false }));
      return;
    }
    if (input === "?" && state.input.length === 0) {
      setState((current) => ({ ...current, helpOpen: !current.helpOpen }));
    }
  });

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
    case "/clear":
      setState((current) => ({ ...current, messages: [] }));
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
    <Text color={politDeckDarkBlueTheme.subtle}>
      sessions: {sessions.map((session) => session.summary || session.sessionId).slice(0, 4).join(" · ")}
    </Text>
  );
}
