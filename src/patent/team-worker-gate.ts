/**
 * 专利 worker 注册表 → 通用编排层 worker 门禁的**适配器**（装配层注入用，见 #363）。
 *
 * 方向说明：本模块刻意**不** import `src/agent/team` 的 `WorkerGate` 类型——patent 是业务域，
 * 不得反向依赖通用编排层（那正是 #363 要拆的那条边）。结构一致性由装配点
 * `src/cli/teamSubsystem.ts` 的显式类型标注在编译期把关
 * （`const workerGate: WorkerGate = createPatentWorkerGate(registry)`），
 * 行为判据见 `tests/patent/team-worker-gate.spec.ts`。
 */
import { type WorkerRegistry, workerAllowedForRole } from "./worker-contract.js";

/**
 * 用专利 worker 注册表构造门禁实现。
 *
 * `allows` 的两条 fail-open 分支（未注册 worker、未登记角色）与 #363 之前调度器内的
 * 内联实现逐字等价：`registry.get(name) === undefined → true`，否则按
 * `workerAllowedForRole(roleSlug, worker)` 的 tier 白名单判定。
 */
export function createPatentWorkerGate(registry: WorkerRegistry) {
  return {
    has: (workerName: string): boolean => registry.get(workerName) !== undefined,
    allows: (roleSlug: string, workerName: string): boolean => {
      const worker = registry.get(workerName);
      return worker === undefined || workerAllowedForRole(roleSlug, worker);
    },
  };
}
