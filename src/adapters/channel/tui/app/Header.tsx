import React from "react";
import { Box, Text } from "ink";
import type { TuiAppState } from "./types.js";
import { politDeckDarkBlueTheme } from "./theme.js";

export function Header({
  state,
  model,
  cwd,
  serverUrl,
}: {
  state: TuiAppState;
  model?: string;
  cwd: string;
  serverUrl?: string;
}): React.ReactNode {
  const connection =
    state.connection === "remote" ? (serverUrl ? `server ${serverUrl}` : "server connected") : "local in-process";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={politDeckDarkBlueTheme.brand} bold>
          PolitDeck
        </Text>
        <Text color={politDeckDarkBlueTheme.brandAccent}> ↗</Text>
        <Text color={politDeckDarkBlueTheme.subtle}>{"  "}v0.1.0</Text>
      </Text>
      <Text color={politDeckDarkBlueTheme.subtle}>
        {model ?? "model"} · {state.mode} · {shortenPath(cwd)} · {connection}
      </Text>
    </Box>
  );
}

function shortenPath(path: string): string {
  if (path.length <= 60) {
    return path;
  }
  return `...${path.slice(-57)}`;
}
