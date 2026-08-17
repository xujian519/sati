/**
 * Centralized Model Definitions
 * Single source of truth for all supported AI models
 */

export const CLAUDE_MODELS = {
  // Models in SDK format (what the actual SDK accepts)
  OPTIONS: [
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus" },
    { value: "haiku", label: "Haiku" },
    { value: "opusplan", label: "Opus Plan" },
    { value: "sonnet[1m]", label: "Sonnet [1M]" },
  ],

  DEFAULT: "sonnet",
};
