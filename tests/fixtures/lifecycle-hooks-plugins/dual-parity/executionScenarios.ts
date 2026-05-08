import type { LifecycleHookPluginParityStatus } from "./contractScenarios.js";

export type LifecycleHookPluginExecutionScenario = {
  id: string;
  status: LifecycleHookPluginParityStatus;
  feature: string;
  reason?: string;
};

export const lifecycleHookPluginExecutionScenarios: LifecycleHookPluginExecutionScenario[] = [
  {
    id: "command-hook-success-additional-context",
    status: "compare",
    feature: "command hook stdout JSON produces additional context",
  },
  {
    id: "permission-request-hook-allow",
    status: "compare",
    feature: "PermissionRequest hook can resolve an ask decision as allow",
  },
  {
    id: "async-rewake-background-queue",
    status: "deferred",
    feature: "asyncRewake wakes the model through a task notification queue",
    reason: "Task notification queue is not part of the current non-context implementation.",
  },
  {
    id: "marketplace-installers",
    status: "deferred",
    feature: "Git, zip and MCPB installer execution",
    reason: "Current implementation only defines safe marketplace references and defers external installation.",
  },
];
