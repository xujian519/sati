export const POLITDECK_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "ConfigChange",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "Elicitation",
  "ElicitationResult",
] as const;

export const POLITDECK_NOT_APPLICABLE_LEGACY_HOOK_EVENTS = [
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
] as const;

export type PolitDeckHookEvent = (typeof POLITDECK_HOOK_EVENTS)[number];
export type PolitDeckNotApplicableLegacyHookEvent =
  (typeof POLITDECK_NOT_APPLICABLE_LEGACY_HOOK_EVENTS)[number];

export function isPolitDeckHookEvent(value: string): value is PolitDeckHookEvent {
  return (POLITDECK_HOOK_EVENTS as readonly string[]).includes(value);
}
