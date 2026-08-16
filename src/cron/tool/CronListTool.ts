import type { SatiToolDefinition } from "../../tool/index.js";
import type { CronListInput, CronListResult } from "../protocol/types.js";
import { CRON_RUN_RECORD_SCHEMA, CRON_TASK_SCHEMA } from "./CronSchemas.js";
import type { CronToolRuntime } from "./CronToolRuntime.js";

export function createCronListTool(runtime: CronToolRuntime): SatiToolDefinition<CronListInput, CronListResult> {
  return {
    name: "cron_list",
    title: "List Cron Tasks",
    description: "List scheduled Cron tasks and optionally recent Cron run history.",
    kind: "session",
    outputSchema: {
      type: "object",
      required: ["tasks"],
      properties: {
        tasks: {
          type: "array",
          items: CRON_TASK_SCHEMA,
        },
        recentRuns: {
          type: "array",
          items: CRON_RUN_RECORD_SCHEMA,
        },
      },
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeHistory: { type: "boolean" },
        limit: { type: "number" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context) => {
      const result = await runtime.listTasks({
        ...(input ?? {}),
        projectKey: context.cwd,
      });
      return {
        content: [{ type: "json", value: result }],
        data: result,
      };
    },
  };
}
