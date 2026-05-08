import React from "react";
import { Box, Text } from "ink";
import type { TuiAppState } from "./types.js";
import { politDeckDarkBlueTheme } from "./theme.js";

export function ActivityLine({ state }: { state: TuiAppState }): React.ReactNode {
  const latest = state.activity.slice(0, 3);
  if (!state.isRunning && latest.length === 0) {
    return null;
  }
  return (
    <Box paddingX={1}>
      {state.isRunning ? <Text color={politDeckDarkBlueTheme.brandAccent}>✦ thinking </Text> : null}
      {latest.map((item) => (
        <Text key={item.id} color={colorForStatus(item.status)}>
          {item.text}{" "}
        </Text>
      ))}
    </Box>
  );
}

function colorForStatus(status: string): string {
  if (status === "done") return politDeckDarkBlueTheme.success;
  if (status === "error") return politDeckDarkBlueTheme.error;
  if (status === "running") return politDeckDarkBlueTheme.brandAccent;
  return politDeckDarkBlueTheme.subtle;
}
