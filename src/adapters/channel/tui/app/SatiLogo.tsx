import React from "react";
import { Box, Text, useStdout } from "ink";
import { satiDarkBlueTheme } from "./theme.js";

const ANSI_SHADOW_LOGO = [
  "███████╗ █████╗ ████████╗██╗",
  "██╔════╝██╔══██╗╚══██╔══╝██║",
  "███████╗███████║   ██║   ██║",
  "╚════██║██╔══██║   ██║   ██║",
  "███████║██║  ██║   ██║   ██║",
  "╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝",
];

const ANSI_SHADOW_VISIBLE_COLS = 28;
// border (2) + paddingX (4) + marginX (2) on the WelcomeCard wrapper.
const ANSI_SHADOW_MIN_TERMINAL_COLS = ANSI_SHADOW_VISIBLE_COLS + 8;

const STANDARD_LOGO = [
  "  ____  _ _       _   ____            _    ",
  " |  _ \\(_) | ___ | |_|  _ \\  ___  ___| | __",
  " | |_) | | |/ _ \\| __| | | |/ _ \\/ __| |/ /",
  " |  __/| | | (_) | |_| |_| |  __/ (__|   < ",
  " |_|   |_|_|\\___/ \\__|____/ \\___|\\___|_|\\_\\",
];

export function SatiLogo({ tagline }: { tagline?: string } = {}): React.ReactNode {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const useShadow = cols >= ANSI_SHADOW_MIN_TERMINAL_COLS;

  return (
    <Box flexDirection="column">
      {(useShadow ? ANSI_SHADOW_LOGO : STANDARD_LOGO).map((line, index) => (
        <Text key={index} color={satiDarkBlueTheme.brandAccent} bold>
          {line}
        </Text>
      ))}
      {tagline ? (
        <Box marginTop={1}>
          <Text color={satiDarkBlueTheme.brandAccent} bold>
            {"↗  "}
          </Text>
          <Text color={satiDarkBlueTheme.subtle}>{tagline}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function CondensedLogo(): React.ReactNode {
  return (
    <Text>
      <Text color={satiDarkBlueTheme.brand} bold>
        Sati
      </Text>
      <Text color={satiDarkBlueTheme.brandAccent}> ↗</Text>
    </Text>
  );
}
