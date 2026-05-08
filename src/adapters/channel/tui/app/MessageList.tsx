import React from "react";
import { Box } from "ink";
import { MessageResponse } from "./MessageResponse.js";
import { WelcomeCard } from "./WelcomeCard.js";
import type { TuiAppState } from "./types.js";

export function MessageList({
  state,
  rows = 18,
  model,
  cwd,
  serverUrl,
}: {
  state: TuiAppState;
  rows?: number;
  model?: string;
  cwd: string;
  serverUrl?: string;
}): React.ReactNode {
  const renderable = state.messages.filter(
    (message) => !(message.role === "assistant" && message.text.trim().length === 0),
  );

  if (renderable.length === 0) {
    const connection = state.connection === "remote" ? (serverUrl ? `server ${serverUrl}` : "server connected") : "local in-process";
    return (
      <Box flexDirection="column" height={rows} justifyContent="center">
        <WelcomeCard model={model} cwd={cwd} connection={connection} />
      </Box>
    );
  }

  const visible = renderable.slice(-Math.max(1, rows - 1));
  return (
    <Box flexDirection="column" height={rows} paddingX={1} overflow="hidden">
      {visible.map((message, index) => (
        <MessageResponse key={index} message={message} />
      ))}
    </Box>
  );
}
