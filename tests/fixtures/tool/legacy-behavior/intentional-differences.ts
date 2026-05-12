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
  {
    id: "bash-non-zero-message-context",
    legacyBehavior:
      "Bash returns the literal text 'Shell command failed' as the tool error message; exitCode/stdout/stderr only available via separate result fields.",
    pilotdeckBehavior:
      "bash error text is `Command exited with code <N>: <command>` followed by the captured stderr and stdout, so the model + UI can distinguish e.g. `ls /missing` (file already gone, exit 1) from an actual infrastructure crash without scraping a separate details bag.",
    reason:
      "The opaque legacy string made every non-zero exit look identical, which (a) tripped the Web UI's 'Add to Allowed Tools' affordance for non-permission failures and (b) gave the agent no signal to recognize benign exit codes like `ls`/`grep`/`test` returning no-match.",
    risk: "lower",
    reviewRequiredBeforeRelease: false,
  },
];
