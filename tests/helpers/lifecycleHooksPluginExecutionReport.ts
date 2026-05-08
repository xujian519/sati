import {
  lifecycleHookPluginExecutionScenarios,
  type LifecycleHookPluginExecutionScenario,
} from "../fixtures/lifecycle-hooks-plugins/dual-parity/executionScenarios.js";

export type LifecycleHookPluginExecutionReport = Pick<
  LifecycleHookPluginExecutionScenario,
  "id" | "status" | "feature" | "reason"
>;

export function createLifecycleHookPluginExecutionReport(): LifecycleHookPluginExecutionReport[] {
  return lifecycleHookPluginExecutionScenarios.map(({ id, status, feature, reason }) => ({
    id,
    status,
    feature,
    reason,
  }));
}
