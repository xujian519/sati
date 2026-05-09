import type { PilotDeckIntentionalDifference } from "./types.js";

export const intentionalDifferences: PilotDeckIntentionalDifference[] = [
  {
    id: "read-workspace-relative-paths",
    legacyBehavior: "Read prompt and implementation are built around absolute file_path inputs.",
    pilotdeckBehavior: "read_file accepts workspace-relative paths and normalizes them against cwd.",
    reason: "PilotDeck tool runtime is explicitly workspace-scoped.",
    risk: "same",
    reviewRequiredBeforeRelease: false,
  },
  {
    id: "read-text-only-phase",
    legacyBehavior: "Read handles text, images, PDFs and notebooks.",
    pilotdeckBehavior: "read_file Phase 1 handles UTF-8 text only and rejects binary-like content.",
    reason: "Non-text modalities are deferred until attachment/context runtimes exist.",
    risk: "lower",
    reviewRequiredBeforeRelease: false,
  },
  {
    id: "bash-no-background-phase",
    legacyBehavior: "Bash supports run_in_background and background task output/stop tools.",
    pilotdeckBehavior: "bash Phase 1 executes foreground commands only.",
    reason: "Background task state belongs in a separate task runtime.",
    risk: "lower",
    reviewRequiredBeforeRelease: false,
  },
  {
    id: "grep-node-subset",
    legacyBehavior: "Grep delegates to ripgrep with broader regex, type and multiline behavior.",
    pilotdeckBehavior: "grep Phase 1 uses a lightweight Node implementation that covers core modes.",
    reason: "Avoid external process coupling before tool runtime contracts stabilize.",
    risk: "same",
    reviewRequiredBeforeRelease: true,
  },
];
