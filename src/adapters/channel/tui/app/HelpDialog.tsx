import React from "react";
import { Box, Text } from "ink";
import { pilotDeckDarkBlueTheme } from "./theme.js";

export function HelpDialog(): React.ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={pilotDeckDarkBlueTheme.brandAccent} paddingX={1}>
      <Text color={pilotDeckDarkBlueTheme.brand} bold>
        PilotDeck commands
      </Text>
      <Text>/new          create a new session</Text>
      <Text>/sessions     list recent sessions</Text>
      <Text>/mode plan    switch to plan mode</Text>
      <Text>/mode default switch to default mode</Text>
      <Text>/mode bypassPermissions  full bypass (writes skipPermissions)</Text>
      <Text>/permissions       list global allow/deny rules</Text>
      <Text>/permissions allow|deny|clear &lt;entry&gt;  edit rules</Text>
      <Text>/permissions bypass  same as skipPermissions in settings</Text>
      <Text>/view [N]     view tool output (N=index, default=last)</Text>
      <Text>/clear        clear transcript</Text>
      <Text>/help         toggle this help</Text>
      <Text>/exit         quit</Text>
      <Text> </Text>
      <Text color={pilotDeckDarkBlueTheme.brand} bold>Navigation</Text>
      <Text>Tab / Shift+Tab   focus prev/next tool output</Text>
      <Text>Enter (empty)     expand focused or view last output</Text>
      <Text>PageUp / Shift+↑  scroll up</Text>
      <Text>PageDown / Shift+↓ scroll down</Text>
      <Text>Esc               clear focus + close help</Text>
      <Text> </Text>
      <Text color={pilotDeckDarkBlueTheme.brand} bold>Viewer (full output)</Text>
      <Text>j/k   scroll line   PgUp/Dn  scroll page</Text>
      <Text>g/G   top/bottom     q/Esc    close viewer</Text>
      <Text> </Text>
      <Text color={pilotDeckDarkBlueTheme.subtle}>Enter sends · Ctrl+C aborts running turns or exits · y/a/n when a permission prompt is shown</Text>
    </Box>
  );
}
