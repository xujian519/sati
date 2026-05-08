import React from "react";
import { Box, Text } from "ink";
import { politDeckDarkBlueTheme } from "./theme.js";

const ASCII_LOGO = [
  " ____       _ _ _   ____            _    ",
  "|  _ \\ ___ | (_) |_|  _ \\  ___  ___| | __",
  "| |_) / _ \\| | | __| | | |/ _ \\/ __| |/ /",
  "|  __/ (_) | | | |_| |_| |  __/ (__|   < ",
  "|_|   \\___/|_|_|\\__|____/ \\___|\\___|_|\\_\\",
];

export function PolitDeckLogo({ tagline }: { tagline?: string } = {}): React.ReactNode {
  return (
    <Box flexDirection="column">
      {ASCII_LOGO.map((line, index) => (
        <Text key={index} color={politDeckDarkBlueTheme.brand} bold>
          {line}
          {index === 0 ? <Text color={politDeckDarkBlueTheme.brandAccent}>{"  ↗"}</Text> : null}
        </Text>
      ))}
      {tagline ? <Text color={politDeckDarkBlueTheme.subtle}>{tagline}</Text> : null}
    </Box>
  );
}

export function CondensedLogo(): React.ReactNode {
  return (
    <Text>
      <Text color={politDeckDarkBlueTheme.brand} bold>
        PolitDeck
      </Text>
      <Text color={politDeckDarkBlueTheme.brandAccent}> ↗</Text>
    </Text>
  );
}
