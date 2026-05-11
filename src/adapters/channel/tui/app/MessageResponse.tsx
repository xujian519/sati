import React from "react";
import { Box, Text } from "ink";
import type { TuiMessage } from "./types.js";
import { pilotDeckDarkBlueTheme } from "./theme.js";

function formatCharCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k chars`;
  return `${n} chars`;
}

export function MessageResponse({ message }: { message: TuiMessage }): React.ReactNode {
  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={pilotDeckDarkBlueTheme.brandAccent} bold>
          You
        </Text>
        <Text>{message.text.trimEnd()}</Text>
      </Box>
    );
  }

  if (message.role === "assistant") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={pilotDeckDarkBlueTheme.brand} bold>
          PilotDeck
        </Text>
        {message.thinking && message.thinking.length > 0 && (
          <Text dimColor italic>
            {"∴ Thinking"} ({formatCharCount(message.thinking.length)})
          </Text>
        )}
        {message.text.trim().length > 0 && (
          <Text color={pilotDeckDarkBlueTheme.text}>{message.text.trim()}</Text>
        )}
      </Box>
    );
  }

  if (message.role === "system") {
    return (
      <Box flexDirection="row">
        <Text color={pilotDeckDarkBlueTheme.subtle}>{message.text}</Text>
      </Box>
    );
  }

  const color =
    message.role === "error"
      ? pilotDeckDarkBlueTheme.error
      : message.ok === false
        ? pilotDeckDarkBlueTheme.error
        : pilotDeckDarkBlueTheme.success;

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text color={pilotDeckDarkBlueTheme.subtle}>  ⎿  </Text>
      <Box flexGrow={1}>
        <Text color={color}>{message.text.trim()}</Text>
      </Box>
    </Box>
  );
}
