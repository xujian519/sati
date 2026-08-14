export const SATI_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  /**
   * @todo Notification — no semantic "user notification" scenario yet.
   * `broadcastNotification` is currently infrastructure-only (config reload).
   * Wire once Always-On task_notification or Feishu adapter matures.
   */
  "Notification",
  "UserPromptSubmit",
  "PreModelRequest",
  /**
   * Turn 开始、模型请求组装前的扩展点（对应 dsh pre-step）：钩子返回的
   * `messages` 追加到本轮模型可见消息（消息改写）；`blockingErrors` 中的
   * block 效果终止 turn（消息拒绝）。无钩子注册时零开销。
   */
  "PreStep",
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
  /**
   * @todo CwdChanged — only meaningful in Always-On workspace switching;
   * regular sessions have a fixed cwd. Wire once in-session cwd switching
   * is supported.
   */
  "CwdChanged",
  /**
   * @todo FileChanged — could fire after write_file/edit_file tool success.
   * Requires injecting dispatch into ToolRuntime context (the AgentEventEmitter
   * callback mechanism is ready; implementation deferred to avoid scope creep).
   */
  "FileChanged",
  "WorktreeCreate",
  "WorktreeRemove",
  "Elicitation",
  "ElicitationResult",
] as const;

export const SATI_NOT_APPLICABLE_LEGACY_HOOK_EVENTS = ["TeammateIdle", "TaskCreated", "TaskCompleted"] as const;

export type SatiHookEvent = (typeof SATI_HOOK_EVENTS)[number];
export type SatiNotApplicableLegacyHookEvent = (typeof SATI_NOT_APPLICABLE_LEGACY_HOOK_EVENTS)[number];

export function isSatiHookEvent(value: string): value is SatiHookEvent {
  return (SATI_HOOK_EVENTS as readonly string[]).includes(value);
}
