import { join } from "node:path";

export { TeamDb, type TeamRow, type TeamMemberRow, type TeamTaskRow, type TeamMessageRow } from "./storage/team-db.js";
export { MEMBER_SESSION_PREFIX, memberSessionKey, parseMemberSessionKey } from "./protocol/member-key.js";
export { createTeamMember, type MemberModelRoute, type CreateTeamMemberOptions } from "./member/member-registry.js";
export {
  wakeMember,
  TeamMemberNotFoundError,
  TeamMemberRetiredError,
  type MemberGateway,
  type WakeMemberOptions,
} from "./member/member-waker.js";
export {
  scanTeamMembers,
  scanStrandedTasks,
  TEAM_MEMBER_RESUME_MARKER,
  TEAM_MEMBER_RESUME_MESSAGE,
  type ScanTeamMembersOptions,
  type ScanTeamMembersResult,
  type ScanStrandedTasksOptions,
  type ScanStrandedTasksResult,
} from "./member/member-scanner.js";
export { TeamApprovalForwarder, type TeamApprovalForwarderOptions } from "./member/approval-forwarder.js";
export { MAILBOX_LEASE_MS, unreadMessages, claimDelivery, expiredClaims } from "./mailbox/mailbox.js";
export { withTeamLock } from "./scheduler/lock.js";
export {
  TeamScheduler,
  type TeamSchedulerOptions,
  type DispatchTicket,
  ownedOpenTask,
  nextReadyTask,
  assignmentPrompt,
  fallbackMailboxPrompt,
} from "./scheduler/scheduler.js";
export {
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  transitionError,
  unsatisfiedDependencies,
  type TeamTaskStatus,
} from "./taskpool/task-status.js";
export {
  beginTaskAttempt,
  invalidateTaskAttempt,
  validateAttemptUpdate,
  attemptsExhausted,
  type TaskAttemptResult,
} from "./taskpool/attempt.js";
export { retryFailedTask, retryableFailedTasks } from "./taskpool/retry.js";
export { toGatewayEvent } from "./protocol/broadcast.js";
export type { TeamEvent, TeamEventEmitter } from "./protocol/events.js";

/** teams.db 默认路径（pilotHome 下）；`SATI_TEAMS_DB` 环境变量可覆盖（测试/治理用）。 */
export function defaultTeamDbPath(pilotHome: string, env: Record<string, string | undefined> = process.env): string {
  return env.SATI_TEAMS_DB ?? join(pilotHome, "teams", "teams.db");
}
