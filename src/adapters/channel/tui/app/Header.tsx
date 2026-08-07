import React from "react";
import { Box, Text } from "ink";
import { APP_VERSION } from "../../../../version.js";
import { satiDarkBlueTheme } from "./theme.js";
import type { TuiAppState } from "./types.js";

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
        <Text color={satiDarkBlueTheme.brand} bold>
          Sati
        </Text>
        <Text color={satiDarkBlueTheme.brandAccent}> ↗</Text>
        <Text color={satiDarkBlueTheme.subtle}>
          {"  "}v{APP_VERSION}
        </Text>
      </Text>
      <Text color={satiDarkBlueTheme.subtle}>
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
