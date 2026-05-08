import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { politDeckDarkBlueTheme } from "./theme.js";

export function PromptInput({
  value,
  onChange,
  onSubmit,
  isRunning,
  focus,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  isRunning: boolean;
  focus: boolean;
}): React.ReactNode {
  return (
    <Box
      borderStyle="round"
      borderColor={isRunning || focus ? politDeckDarkBlueTheme.brandAccent : politDeckDarkBlueTheme.border}
      paddingX={1}
      flexDirection="row"
    >
      <Text color={politDeckDarkBlueTheme.brandAccent}>{"> "}</Text>
      <Box flexGrow={1}>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="Ask PolitDeck... (/help)"
          showCursor
          focus={focus}
        />
      </Box>
    </Box>
  );
}
