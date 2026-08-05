import React from "react";
import { Box, Text } from "ink";
import { APP_VERSION } from "../../../../version.js";
import { CondensedLogo } from "./SatiLogo.js";
import { satiDarkBlueTheme } from "./theme.js";
import type { TuiAppState } from "./types.js";

export function StatusLine(props: {
  state: TuiAppState;
  model?: string;
  cwd: string;
  serverUrl?: string;
}): React.ReactNode {
  const connection =
    props.state.connection === "remote" ? `server ${props.serverUrl ?? "connected"}` : "local in-process";
  return (
    <Box borderStyle="single" borderColor={satiDarkBlueTheme.border} paddingX={1} justifyContent="space-between">
      <Box gap={1}>
        <CondensedLogo />
        <Text color={satiDarkBlueTheme.subtle}>v{APP_VERSION}</Text>
      </Box>
      <Text color={satiDarkBlueTheme.subtle}>
        {props.model ?? "model"} · {props.state.mode} · {shortenPath(props.cwd)} · {connection}
      </Text>
    </Box>
  );
}

function shortenPath(path: string): string {
  if (path.length <= 42) {
    return path;
  }
  return `...${path.slice(-39)}`;
}
