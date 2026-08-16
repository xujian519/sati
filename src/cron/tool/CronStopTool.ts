import type { SatiToolDefinition } from "../../tool/index.js";
import type { CronStopInput, CronStopResult } from "../protocol/types.js";
import type { CronToolRuntime } from "./CronToolRuntime.js";

export function createCronStopTool(runtime: CronToolRuntime): SatiToolDefinition<CronStopInput, CronStopResult> {
  return {
    name: "cron_stop",
    title: "Stop Cron Run",
    description: "Stop a currently running Cron run. One-time tasks are removed after being stopped.",
    kind: "session",
    outputSchema: {
      type: "object",
      required: ["stopped"],
      properties: {
        stopped: { type: "boolean" },
        taskId: { type: "string" },
        runId: { type: "string" },
        deletedOneTimeTask: { type: "boolean" },
      },
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        taskId: { type: "string" },
        runId: { type: "string" },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    execute: async (input, context) => {
      const result = await runtime.stopTask({
        ...input,
        projectKey: context.cwd,
      });
      return {
        content: [{ type: "json", value: result }],
        data: result,
      };
    },
  };
}
