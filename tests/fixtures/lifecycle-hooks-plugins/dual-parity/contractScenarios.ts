export type LifecycleHookPluginParityStatus =
  | "compare"
  | "intentional_difference"
  | "deferred"
  | "not_applicable";

export type LifecycleHookPluginContractScenario = {
  id: string;
  status: LifecycleHookPluginParityStatus;
  feature: string;
  reason?: string;
};

export const lifecycleHookPluginContractScenarios: LifecycleHookPluginContractScenario[] = [
  {
    id: "hook-event-protocol",
    status: "compare",
    feature: "legacy-compatible hook event names minus not-applicable team/task events",
  },
  {
    id: "command-hook-exit-semantics",
    status: "compare",
    feature: "command hook success, blocking exit 2 and non-blocking non-2 exits",
  },
  {
    id: "prompt-http-agent-adapters",
    status: "compare",
    feature: "prompt/http/agent hooks execute through injected adapters",
  },
  {
    id: "context-compaction-hooks",
    status: "deferred",
    feature: "PreCompact and PostCompact context integration",
    reason: "Context work is intentionally excluded from the current implementation request.",
  },
  {
    id: "team-task-hooks",
    status: "not_applicable",
    feature: "TeammateIdle, TaskCreated and TaskCompleted",
    reason: "PilotDeck does not migrate legacy team/task daemon capabilities.",
  },
];
