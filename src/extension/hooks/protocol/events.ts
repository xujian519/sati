export const PILOTDECK_HOOK_EVENTS = [
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

export const PILOTDECK_NOT_APPLICABLE_LEGACY_HOOK_EVENTS = [
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
] as const;

export type PilotDeckHookEvent = (typeof PILOTDECK_HOOK_EVENTS)[number];
export type PilotDeckNotApplicableLegacyHookEvent =
  (typeof PILOTDECK_NOT_APPLICABLE_LEGACY_HOOK_EVENTS)[number];

export function isPilotDeckHookEvent(value: string): value is PilotDeckHookEvent {
  return (PILOTDECK_HOOK_EVENTS as readonly string[]).includes(value);
}
