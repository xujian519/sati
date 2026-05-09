import React from "react";
import { Box, Text } from "ink";
import { pilotDeckDarkBlueTheme } from "./theme.js";

export function HelpDialog(): React.ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={pilotDeckDarkBlueTheme.brandAccent} paddingX={1}>
      <Text color={pilotDeckDarkBlueTheme.brand} bold>
        PilotDeck commands
      </Text>
      <Text>/new        create a new session</Text>
      <Text>/sessions   list recent sessions</Text>
      <Text>/mode plan  switch to plan mode</Text>
      <Text>/mode default switch to default mode</Text>
      <Text>/clear      clear transcript</Text>
      <Text>/help       toggle this help</Text>
      <Text>/exit       quit</Text>
      <Text color={pilotDeckDarkBlueTheme.subtle}>Enter sends · Ctrl+C aborts running turns or exits</Text>
    </Box>
  );
}
