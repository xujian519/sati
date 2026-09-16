/**
 * worker 门禁（`WorkerGate`）——通用编排层对「业务域 worker」的**唯一认知面**。
 *
 * 背景（#363 / `TD-TEAM-N06`）：调度器此前直接 `import` 专利域的 `worker-contract.js`
 * （`WorkerRegistry` + `workerAllowedForRole`），于是
 * - 任何团队（含非专利团队）的派发都被强制走专利 worker 的 tier 校验路径；
 * - 专利域改一次 worker 契约，通用调度器要跟着改（依赖方向 `agent/team → patent`），
 *   而 `agent/team/` 其余 22 个文件只依赖 `node:*`/`gateway/protocol`/`telemetry` 与自身。
 *
 * 现在编排层只认下面这个**领域无关**接口，实现由装配点注入（专利侧适配器
 * `src/patent/team-worker-gate.ts`，装配见 `src/cli/teamSubsystem.ts`）。
 *
 * 接口刻意只有两个方法：编排层对 worker 的全部用法就是「存不存在」与「这个角色能不能干」，
 * 再多一个字段就是把域语义请回来。
 */
export interface WorkerGate {
  /** 具名 worker 是否已注册（未注册 → false）。 */
  has(workerName: string): boolean;
  /**
   * 角色是否有权执行具名 worker。
   *
   * **fail-open 语义（实现方必须保持）**：未注册 worker 或未登记角色一律 true——
   * 与 #363 之前的 `workerRegistry.get(name) === undefined → 放行` 逐字同语义。
   * 收紧会让尚未迁移到 worker 契约的任务派发静默停摆（调度器不再唤醒任何成员）。
   */
  allows(roleSlug: string, workerName: string): boolean;
}
