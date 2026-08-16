/** Canonical output contract for a Cron task record (CronTask). */
export const CRON_TASK_SCHEMA = {
  type: "object",
  required: [
    "schemaVersion",
    "taskId",
    "message",
    "schedule",
    "status",
    "sessionKey",
    "channelKey",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    schemaVersion: { type: "integer" },
    taskId: { type: "string" },
    message: { type: "string" },
    schedule: { type: "object" },
    status: { type: "string" },
    sessionKey: { type: "string" },
    channelKey: { type: "string" },
    projectKey: { type: "string" },
    mode: { type: "string" },
    timezone: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    nextRunAt: { type: "string" },
    lastRunId: { type: "string" },
    revision: { type: "integer" },
    scheduleComputationVersion: { type: "integer" },
    originSessionKey: { type: "string" },
    originChannelKey: { type: "string" },
  },
} as const;

/** Canonical output contract for a Cron run record (CronRunRecord). */
export const CRON_RUN_RECORD_SCHEMA = {
  type: "object",
  required: ["schemaVersion", "runId", "taskId", "sessionKey", "startedAt"],
  properties: {
    schemaVersion: { type: "integer" },
    runId: { type: "string" },
    taskId: { type: "string" },
    sessionKey: { type: "string" },
    projectKey: { type: "string" },
    startedAt: { type: "string" },
    finishedAt: { type: "string" },
    outcome: { type: "string" },
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;

export const CRON_SCHEDULE_SCHEMA = {
  anyOf: [
    {
      type: "object",
      required: ["type", "runAt"],
      additionalProperties: false,
      properties: {
        type: { type: "string", const: "once" },
        runAt: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "expression"],
      additionalProperties: false,
      properties: {
        type: { type: "string", const: "cron" },
        expression: { type: "string" },
        timezone: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "amount", "unit"],
      additionalProperties: false,
      properties: {
        type: { type: "string", const: "delay" },
        amount: { type: "number", exclusiveMinimum: 0 },
        unit: { type: "string", enum: ["second", "minute", "hour", "day"] },
      },
    },
  ],
} as const;
