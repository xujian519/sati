import React from "react";
import { Box, Text } from "ink";
import type { TuiMessage } from "./types.js";
import { politDeckDarkBlueTheme } from "./theme.js";

export function MessageResponse({ message }: { message: TuiMessage }): React.ReactNode {
  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={politDeckDarkBlueTheme.brandAccent} bold>
          You
        </Text>
        <Text>{message.text.trimEnd()}</Text>
      </Box>
    );
  }

  if (message.role === "assistant") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={politDeckDarkBlueTheme.brand} bold>
          PolitDeck
        </Text>
        <Text color={politDeckDarkBlueTheme.text}>{message.text.trim()}</Text>
      </Box>
    );
  }

  if (message.role === "system") {
    return (
      <Box flexDirection="row">
        <Text color={politDeckDarkBlueTheme.subtle}>{message.text}</Text>
      </Box>
    );
  }

  const color =
    message.role === "error"
      ? politDeckDarkBlueTheme.error
      : message.ok === false
        ? politDeckDarkBlueTheme.error
        : politDeckDarkBlueTheme.success;

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Text color={politDeckDarkBlueTheme.subtle}>  ⎿  </Text>
      <Box flexGrow={1}>
        <Text color={color}>{message.text.trim()}</Text>
      </Box>
    </Box>
  );
}
