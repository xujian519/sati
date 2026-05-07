import { DEFAULT_CRON_JITTER_CONFIG } from '../../utils/cronTasks.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export const DEFAULT_MAX_AGE_DAYS =
  DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs / (24 * 60 * 60 * 1000)

/**
 * Unified gate for the cron scheduling system. Cron tooling is now always
 * compiled into repo builds, and this runtime gate decides whether the tools,
 * scheduler, and /loop skill are actually enabled.
 *
 * The cron module graph (cronScheduler/cronTasks/cronTasksLock/cron.ts + the
 * three tools + /loop skill) has zero imports into src/assistant/ and no
 * feature('KAIROS') calls. The REPL.tsx kairosEnabled read is safe:
 * kairosEnabled is unconditionally in AppStateStore with default false, so
 * when KAIROS is off the scheduler just gets assistantMode: false.
 *
 * Called from Tool.isEnabled() (lazy, post-init) and inside useEffect /
 * imperative setup, never at module scope — so the disk cache has had a
 * chance to populate.
 *
 * Cron now bypasses GrowthBook entirely. The local env var remains the single
 * explicit kill switch so operators can still disable the feature without
 * editing code.
 */
export function isKairosCronEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CRON)
}

/**
 * Kill switch for disk-persistent (durable) cron tasks. Narrower than
 * {@link isKairosCronEnabled} — flipping this off forces `durable: false` at
 * the call() site, leaving session-only cron (in-memory, GA) untouched.
 *
 * Durable cron also bypasses GrowthBook. Keep the same local kill switch as the
 * broader cron feature so a local disable cleanly suppresses both regular and
 * durable task creation paths.
 */
export function isDurableCronEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CRON)
}

export const CRON_CREATE_TOOL_NAME = 'CronCreate'
export const CRON_DELETE_TOOL_NAME = 'CronDelete'
export const CRON_LIST_TOOL_NAME = 'CronList'

export function buildCronCreateDescription(durableEnabled: boolean): string {
  return durableEnabled
    ? 'Schedule a prompt to run at a future time — either recurring on a cron schedule, or once at a specific time. Pass durable: true to persist to .claude/scheduled_tasks.json; pass manualOnly: true to create a proposal that only runs when manually triggered.'
    : 'Schedule a prompt to run at a future time in the Cron daemon — either recurring on a cron schedule, or once at a specific time. Pass manualOnly: true to create a proposal that only runs when manually triggered.'
}

export function buildCronCreatePrompt(durableEnabled: boolean): string {
  const durabilitySection = durableEnabled
    ? `## Durability

By default (durable: false) the job stays session-scoped in the Cron daemon and is stored separately from durable jobs so it can be restored after a daemon restart. Pass durable: true to write to .claude/scheduled_tasks.json so the job survives across sessions. Only use durable: true when the user explicitly asks for the task to persist across sessions ("keep doing this every day", "set this up permanently"). Most "remind me in 5 minutes" / "check back in an hour" requests should stay session-scoped.`
    : `## Session-only

Jobs stay session-scoped in the Cron daemon and are stored separately from durable jobs so they can be restored after a daemon restart.`

  const manualOnlySection = `## Manual-only proposals

Pass manualOnly: true when the job should be created as a proposal rather than auto-scheduled. Manual-only jobs still appear in Always-On and can be launched with "Run now", but they never fire automatically on their cron schedule. Use this for "propose follow-up tasks for later approval" workflows.`

  const durableRuntimeNote = durableEnabled
    ? 'Durable jobs persist to .claude/scheduled_tasks.json and survive session restarts — on next launch they resume automatically. One-shot durable tasks that were missed while the daemon was down are surfaced for catch-up. Session-scoped jobs are stored separately from durable jobs and are restored when the daemon restarts, but remain scoped to their originating session. '
    : ''

  return `Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.

Uses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local — no timezone conversion needed.

## Prompt title

The scheduled prompt must start with a short Markdown H1 title on the first line, followed by a blank line and then the task instructions. The title is used by Always-On as the visible job name, so keep it specific and concise.

Example prompt:
# Daily PR check

Check open PRs, CI status, and unresolved review comments. Report blockers first and do not make changes unless explicitly asked.

## One-shot tasks (recurring: false)

For "remind me at X" or "at <time>, do Y" requests — fire once then auto-delete.
Pin minute/hour/day-of-month/month to specific values:
  "remind me at 2:30pm today to check the deploy" → cron: "30 14 <today_dom> <today_month> *", recurring: false
  "tomorrow morning, run the smoke test" → cron: "57 8 <tomorrow_dom> <tomorrow_month> *", recurring: false

## Recurring jobs (recurring: true, the default)

For "every N minutes" / "every hour" / "weekdays at 9am" requests:
  "*/5 * * * *" (every 5 min), "0 * * * *" (hourly), "0 9 * * 1-5" (weekdays at 9am local)

## Avoid the :00 and :30 minute marks when the task allows it

Every user who asks for "9am" gets \`0 9\`, and every user who asks for "hourly" gets \`0 *\` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:
  "every morning around 9" → "57 8 * * *" or "3 9 * * *" (not "0 9 * * *")
  "hourly" → "7 * * * *" (not "0 * * * *")
  "in an hour or so, remind me to..." → pick whatever minute you land on, don't round

Only use minute 0 or 30 when the user names that exact time and clearly means it ("at 9:00 sharp", "at half past", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.

${durabilitySection}

${manualOnlySection}

## Runtime behavior

Jobs fire from the Cron daemon rather than the foreground REPL/Web query process. ${durableRuntimeNote}The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.

Recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the ${DEFAULT_MAX_AGE_DAYS}-day limit when scheduling recurring jobs.

Returns a job ID you can pass to ${CRON_DELETE_TOOL_NAME}.`
}

export const CRON_DELETE_DESCRIPTION = 'Cancel a scheduled cron job by ID'
export function buildCronDeletePrompt(durableEnabled: boolean): string {
  return durableEnabled
    ? `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME}. Removes it from .claude/scheduled_tasks.json (durable jobs) or the Cron daemon's session-scoped store (session-only jobs).`
    : `Cancel a cron job previously scheduled with ${CRON_CREATE_TOOL_NAME}. Removes it from the Cron daemon's session-scoped store.`
}

export const CRON_LIST_DESCRIPTION = 'List scheduled cron jobs'
export function buildCronListPrompt(durableEnabled: boolean): string {
  return durableEnabled
    ? `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME}, both durable (.claude/scheduled_tasks.json) and session-scoped in the Cron daemon. Include whether each job is manualOnly (proposal-only, no auto-fire).`
    : `List all cron jobs scheduled via ${CRON_CREATE_TOOL_NAME} in the Cron daemon session store. Include whether each job is manualOnly (proposal-only, no auto-fire).`
}
