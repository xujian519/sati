/**
 * 专利侧 worker 门禁适配器（`src/patent/team-worker-gate.ts`）行为判据（#363 / `TD-TEAM-N06`）。
 *
 * 判据分两组：
 * 1. **与收敛前逐字等价的三条分支**——未注册 worker 放行、未登记角色放行、已登记角色按 tier
 *    白名单判定。前两条是 fail-open（收紧会让尚未迁移到 worker 契约的任务派发静默停摆），
 *    是本适配器唯一可能悄悄漂移的地方，故逐条钉住；
 * 2. **`has` 与 `allows` 不共用同一判据**——`has` 只管存在性，不得顺手做权限判定
 *    （team_create_task 的存在性校验与调度器的权限校验是两件事）。
 *
 * 结构一致性（适配器对象满足 `WorkerGate`）由装配点 `src/cli/teamSubsystem.ts` 的显式标注在
 * 编译期把关；本文件另用一个带类型的局部绑定在测试侧再钉一次（`const gate: WorkerGate = …`）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerGate } from "../../src/agent/team/index.js";
import { WorkerRegistry, createPatentWorkerGate, defaultPatentWorkers } from "../../src/patent/index.js";
// 白名单表本身未从 patent barrel 导出（生产消费方只有 workerAllowedForRole），判据按深引取用。
import { ROLE_WORKER_TIERS } from "../../src/patent/worker-contract.js";

/** 内置 6 个专利 worker 的注册表（与生产装配点 `teamSubsystem` 同源）。 */
function patentRegistry(): WorkerRegistry {
  const registry = new WorkerRegistry();
  for (const worker of defaultPatentWorkers()) registry.register(worker);
  return registry;
}

test("fail-open：未注册 worker 一律放行（与 #363 前调度器内联实现同语义）", () => {
  const gate: WorkerGate = createPatentWorkerGate(patentRegistry());
  // 「幽灵 worker」在收敛前走的是 `registry.get(name) === undefined → true` 这条早退，
  // 收敛后由适配器承担。收紧成 false 会让未迁移任务的派发静默停摆。
  assert.equal(gate.allows("drafter", "no-such-worker"), true);
  assert.equal(gate.allows("adjudicator", "no-such-worker"), true);
  // 存在性本身仍要如实报 false（否则 team_create_task 的校验就废了）
  assert.equal(gate.has("no-such-worker"), false);
});

test("fail-open：未登记角色不限制（新增角色默认放开）", () => {
  const gate = createPatentWorkerGate(patentRegistry());
  // 前置（独立真值：白名单表本身的键集，不复用被测谓词）——该角色确实未登记，
  // 否则这条用例测的不是「未登记角色」分支。
  assert.equal(Object.keys(ROLE_WORKER_TIERS).includes("brand-new-role"), false);
  assert.equal(gate.allows("brand-new-role", "quality_checker"), true);
  assert.equal(gate.allows("brand-new-role", "patent-technical-analyzer"), true);
});

test("已登记角色：按 tier 白名单放行/拒绝（判定委托 workerAllowedForRole）", () => {
  const gate = createPatentWorkerGate(patentRegistry());
  // 前置（独立真值）：这两个角色确实已登记
  assert.deepEqual(ROLE_WORKER_TIERS.researcher, ["domain"]);
  assert.deepEqual(ROLE_WORKER_TIERS.drafter, ["work", "provision"]);
  // researcher 白名单只有 domain——patent-search-commander(tier=domain) 放行，
  // patent-technical-analyzer(tier=work) 拒绝。
  assert.equal(gate.allows("researcher", "patent-search-commander"), true);
  assert.equal(gate.allows("researcher", "patent-technical-analyzer"), false);
  // drafter 白名单 work+provision——与技术分析 worker 相反
  assert.equal(gate.allows("drafter", "patent-technical-analyzer"), true);
  assert.equal(gate.allows("drafter", "patent-search-commander"), false);
  // has 不受权限影响：被拒绝的 worker 仍是「已注册」
  assert.equal(gate.has("patent-search-commander"), true);
});

test("has 只判存在性：不与权限判定合并", () => {
  const registry = patentRegistry();
  const gate = createPatentWorkerGate(registry);
  for (const worker of defaultPatentWorkers()) {
    assert.equal(gate.has(worker.name), true, `${worker.name} 已注册`);
  }
  registry.register({ name: "lazy-worker", tier: "checker", description: "懒激活 worker", preRegister: false });
  assert.equal(gate.has("lazy-worker"), true, "懒激活（preRegister=false）仍是已注册");
});

test("门禁读取的是注册表当前状态，不是构造时的快照", () => {
  const registry = patentRegistry();
  const gate = createPatentWorkerGate(registry);
  assert.equal(gate.has("late-worker"), false);
  registry.register({ name: "late-worker", tier: "checker", description: "构造后注册的 worker" });
  assert.equal(gate.has("late-worker"), true);
  assert.equal(gate.allows("adjudicator", "late-worker"), true); // checker 角色 + checker worker
});
