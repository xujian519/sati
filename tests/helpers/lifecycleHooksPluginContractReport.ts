import {
  lifecycleHookPluginContractScenarios,
  type LifecycleHookPluginContractScenario,
} from "../fixtures/lifecycle-hooks-plugins/dual-parity/contractScenarios.js";

export type LifecycleHookPluginContractReport = Pick<
  LifecycleHookPluginContractScenario,
  "id" | "status" | "feature" | "reason"
>;

export function createLifecycleHookPluginContractReport(): LifecycleHookPluginContractReport[] {
  return lifecycleHookPluginContractScenarios.map(({ id, status, feature, reason }) => ({
    id,
    status,
    feature,
    reason,
  }));
}
