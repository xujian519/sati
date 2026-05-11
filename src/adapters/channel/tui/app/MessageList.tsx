import React from "react";
import { Box, Text } from "ink";
import { MessageResponse } from "./MessageResponse.js";
import { WelcomeCard } from "./WelcomeCard.js";
import type { TuiAppState } from "./types.js";
import { pilotDeckDarkBlueTheme } from "./theme.js";

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
    (message) => !(message.role === "assistant" && message.text.trim().length === 0 && !message.thinking),
  );

  if (renderable.length === 0) {
    const connection = state.connection === "remote" ? (serverUrl ? `server ${serverUrl}` : "server connected") : "local in-process";
    return (
      <Box flexDirection="column" height={rows} justifyContent="center">
        <WelcomeCard model={model} cwd={cwd} connection={connection} />
      </Box>
    );
  }

  const { scrollOffset } = state;
  const total = renderable.length;

  // scrollOffset is message-count from the bottom (0 = pinned to bottom).
  // Compute the end index (exclusive) and start index for the visible window.
  const end = Math.max(0, total - scrollOffset);
  const start = Math.max(0, end - Math.max(1, rows - 1));
  const visible = renderable.slice(start, end);

  const hasMore = scrollOffset > 0;

  return (
    <Box flexDirection="column" height={rows} paddingX={1} overflow="hidden">
      {start > 0 && (
        <Text color={pilotDeckDarkBlueTheme.subtle} dimColor>
          ↑ {start} more message{start > 1 ? "s" : ""} above (PageUp to scroll)
        </Text>
      )}
      {visible.map((message, index) => (
        <MessageResponse key={start + index} message={message} />
      ))}
      {hasMore && (
        <Text color={pilotDeckDarkBlueTheme.subtle} dimColor>
          ↓ {scrollOffset} below — PageDown to scroll back
        </Text>
      )}
    </Box>
  );
}
