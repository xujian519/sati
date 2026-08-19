/**
 * 声明式工作流执行器（门面）。
 *
 * 设计原则（吸取 Mady 教训：5 条执行路径并存导致"看起来实现但从未运行"）：
 * 只保留一条声明式路径 —— WorkflowManifest（JSON/YAML 可序列化）+ 单一执行器 runWorkflow。
 * 内置 patent_novelty_v1 manifest（五阶段 + novelty_chain 模板镜像）。
 *
 * 原子执行（v2，移植自 Mady agentcore/atom.go + pipeline_handler.go）：
 * - WorkflowStage 可声明 atom（Pipeline 原子操作名）；runWorkflow 优先按 atom 分发到
 *   StageHandler（经注入的 handlers 注册表或全局注册表），handler 内部调用 LLM/检索器。
 * - 未声明 atom 的阶段回退到调用方 executor（向后兼容；patent_workflow 工具走此路径）。
 * - 审批门（approval-gate）等 handler 抛 InterruptStageError 时，runWorkflow 暂停
 *   并返回 interrupted 信息（暂停 ≠ 失败），不执行后续阶段。
 * - 已人工批准的审批门（options.approvalGrants 命中该阶段 id）：跳过执行直接放行，
 *   输出占位文本 APPROVED，不中断、不标记 degraded——人工批准后重跑可从审批门继续。
 *
 * 拆分注记（2026-08-16，巨无霸函数拆解 A2 轮次 1）：类型契约与 WorkflowError 已
 * 迁至 ./workflow/types.ts，内置 manifest 数据已迁至 ./workflow/manifests.ts；
 * 本文件保留执行器本体并 re-export 全部导出（消费方 import "./workflow.js" 零改动）。
 */

import { type PipelineState, globalAtomRegistry, globalStageHandlerRegistry } from "./atoms/index.js";
import {
  WorkflowError,
  type StageExecutor,
  type WorkflowContext,
  type WorkflowInterrupt,
  type WorkflowManifest,
  type WorkflowRunOptions,
  type WorkflowRunResult,
  type WorkflowStage,
  type WorkflowStageResult,
} from "./workflow/types.js";
import { signalFor, signalMatches } from "./workflow/signal.js";
import { buildDefaultWorkerMap, runStageOnce } from "./workflow/executor.js";
import { restoreFromCheckpoint, stageToCheckpointStage } from "./workflow/checkpoint.js";
import type { WorkerExecutionRecord, WorkerOutputValidation } from "./worker-contract.js";
import type { ManifestCheckpoint } from "./workflow/types.js";

// ---- 门面再导出（保持 "./workflow.js" 消费面不变） ----
export { WorkflowError };
export type {
  StageExecutor,
  WorkflowContext,
  WorkflowInterrupt,
  WorkflowManifest,
  ManifestCheckpoint,
  ManifestCheckpointStage,
  ManifestCheckpointStore,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowRunStore,
  WorkflowStage,
  WorkflowStageResult,
  WorkflowStrategy,
} from "./workflow/types.js";
export {
  JsonFileManifestCheckpointStore,
  restoreFromCheckpoint,
  stageToCheckpointStage,
} from "./workflow/checkpoint.js";
export {
  builtinPatentManifests,
  patentDisclosureManifest,
  patentDraftingManifest,
  patentInfringementManifest,
  patentInventivenessManifest,
  patentInvalidationManifest,
  patentNoveltyManifest,
  patentOaResponseManifest,
  patentPatentabilityManifest,
} from "./workflow/manifests.js";
export type { BuiltinPatentManifest } from "./workflow/manifests.js";

/**
 * Manifest 校验（轻量守卫，替代 zod）：非法即抛错。
 * options.atomNames 提供时，额外校验已声明 atom 均存在（fail-fast）。
 */
export function validateWorkflowManifest(
  manifest: WorkflowManifest,
  options?: { atomNames?: ReadonlySet<string> },
): void {
  if (!manifest.id.trim()) throw new WorkflowError("manifest.id 不能为空");
  if (!manifest.name.trim()) throw new WorkflowError("manifest.name 不能为空");
  if (!manifest.caseType.trim()) throw new WorkflowError("manifest.caseType 不能为空");
  if (!Array.isArray(manifest.stages) || manifest.stages.length === 0) {
    throw new WorkflowError("manifest.stages 必须至少包含一个阶段");
  }
  const ids = new Set<string>();
  for (const stage of manifest.stages) {
    if (!stage.id.trim()) throw new WorkflowError("stage.id 不能为空");
    if (ids.has(stage.id)) throw new WorkflowError(`重复的阶段 id: ${stage.id}`);
    ids.add(stage.id);
    if (!["chain", "react", "sub_agent"].includes(stage.strategy)) {
      throw new WorkflowError(`未知策略: ${stage.strategy}（阶段 ${stage.id}）`);
    }
    if (!stage.description.trim()) throw new WorkflowError(`阶段 ${stage.id} 缺少描述`);
    if (stage.atom !== undefined && !stage.atom.trim()) {
      throw new WorkflowError(`阶段 ${stage.id} 的 atom 不能为空字符串`);
    }
    if (options?.atomNames && stage.atom !== undefined && !options.atomNames.has(stage.atom)) {
      throw new WorkflowError(`阶段 ${stage.id} 声明了未知 atom: ${stage.atom}`);
    }
    if (stage.retry !== undefined) {
      if (stage.retry.whenOutputMatches.trim() === "") {
        throw new WorkflowError(`阶段 ${stage.id} 的 retry.whenOutputMatches 不能为空`);
      }
      try {
        new RegExp(stage.retry.whenOutputMatches, "i");
      } catch {
        throw new WorkflowError(`阶段 ${stage.id} 的 retry.whenOutputMatches 非法正则`);
      }
      if (stage.retry.rewindTo !== undefined && !ids.has(stage.retry.rewindTo)) {
        // ids 按 manifest 顺序逐个收集：此检查隐含约束 rewindTo 只能指向更早阶段
        // （后续阶段尚未入 ids）——因此"纯回退边图"天然无环；而"顺序边 + 回退边"
        // 的混合环（如 disclosure 的 consistency → extract_problem）是合法的受控
        // 回退，由 runWorkflow 的 rewindCounts 有界执行，不属配置错误。
        throw new WorkflowError(`阶段 ${stage.id} 的 retry.rewindTo 指向不存在的阶段: ${stage.retry.rewindTo}`);
      }
      if (stage.retry.rewindTo === stage.id) {
        throw new WorkflowError(`阶段 ${stage.id} 的 retry.rewindTo 不能指向自身（无回退意义）`);
      }
      const maxRetries = stage.retry.maxRetries ?? 1;
      if (maxRetries < 0) throw new WorkflowError(`阶段 ${stage.id} 的 retry.maxRetries 不能为负`);
    }
  }
}

/**
 * 单一执行器：按顺序执行各阶段。
 * - 声明 atom 的阶段经 StageHandler 执行（handler 内部调 LLM/检索器），输出合并进 PipelineState
 * - 未声明 atom 的阶段回退调用方 executor（输出为空时标记 degraded 而非中断）
 * - 审批门等中断（InterruptStageError）：暂停执行并返回 interrupted（不执行后续阶段）
 */
export async function runWorkflow(
  manifest: WorkflowManifest,
  ctx: WorkflowContext,
  executor?: StageExecutor,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult> {
  validateWorkflowManifest(manifest);
  const requireAll = manifest.validation?.requireAllSteps ?? true;
  const maxRetries = manifest.validation?.maxRetries ?? 2;
  const handlers = options.handlers ?? globalStageHandlerRegistry;
  const atoms = options.atoms ?? globalAtomRegistry;

  // 原子契约存在性 fail-fast：声明了未知 atom（连契约都没有）直接抛错；
  // 已知 atom 但 handler 未注册时回退 executor（atom 是契约，handler 是实现，可延迟注册）。
  for (const stage of manifest.stages) {
    if (stage.atom !== undefined && !atoms.lookup(stage.atom)) {
      throw new WorkflowError(`阶段 ${stage.id} 声明了未知 atom "${stage.atom}"（请先 RegisterAtom）`);
    }
  }

  // 断点续跑（T10）：提供 resumeFrom 时跳过已完成阶段，从检查点恢复结果与 state；
  // 已放行审批门并入 approvalGrants（同一放行契约，审批门重放时直接放行）。
  const state: PipelineState = { ...ctx };
  const results: WorkflowStageResult[] = [];
  let interrupted: WorkflowInterrupt | undefined;
  let startIndex = 0;
  let approvalGrants = options.approvalGrants;
  if (options.resumeFrom !== undefined) {
    const restored = restoreFromCheckpoint(options.resumeFrom);
    results.push(...restored.results);
    Object.assign(state, restored.state);
    startIndex = options.resumeFrom.stageIndex;
    approvalGrants = [...new Set([...(approvalGrants ?? []), ...restored.approvalGrants])];
  }

  const stageIds = new Map(manifest.stages.map((s, i) => [s.id, i]));
  // 回退计数（局部 Map，不污染 PipelineState；跨阶段重入持久，防无限回退）。
  const rewindCounts = new Map<string, number>();
  // 信号正则预编译（manifest 常量，避免每次执行/回退重新编译；判定逻辑见 ./workflow/signal.ts）。
  const signalCache = new Map<string, RegExp>();

  // 单阶段执行（重试循环 + degraded 构造）见 ./workflow/executor.ts（参数化，供串行/并行共用）。
  const workerMap = buildDefaultWorkerMap();
  const stageOptions = {
    handlers,
    atoms,
    provider: options.provider,
    executor,
    maxRetries,
    approvalGrants,
    ctx,
    workers: workerMap,
  };

  /** 落检查点（可选）：每阶段完成后持久化已完成结果与阶段间 state。 */
  const saveCheckpoint = async (index: number): Promise<void> => {
    if (options.checkpointStore === undefined) return;
    const checkpointId = options.runId ?? manifest.id;
    const checkpoint: ManifestCheckpoint = {
      id: checkpointId,
      manifestId: manifest.id,
      stageIndex: index,
      completedStages: results.map(stageToCheckpointStage),
      state: { ...state },
      approvalGrants: approvalGrants ?? [],
      updatedAt: new Date().toISOString(),
    };
    await options.checkpointStore.save(checkpoint);
  };

  const pushResult = (
    stage: WorkflowStage,
    outcome: { output: string; retries: number; workerValidation?: WorkerOutputValidation },
  ): void => {
    const workerValidation = outcome.workerValidation;
    results.push({
      stageId: stage.id,
      strategy: stage.strategy,
      output: outcome.output,
      degraded: outcome.output.trim().length === 0 || outcome.output.startsWith("[WORKFLOW_DEGRADED]"),
      retries: outcome.retries,
      ...(stage.atom !== undefined ? { atom: stage.atom } : {}),
      ...(workerValidation !== undefined
        ? {
            workerValidation: {
              workerName: workerValidation.workerName,
              valid: workerValidation.valid,
              missingHardFields: workerValidation.missingHardFields,
              missingSoftFields: workerValidation.missingSoftFields,
            },
          }
        : {}),
    });
    // Worker 执行监控（真实运行统计，供审计）。
    if (workerValidation !== undefined && options.monitor !== undefined) {
      const record: WorkerExecutionRecord = {
        workerName: workerValidation.workerName,
        inputValid: true,
        outputValid: workerValidation.valid,
        degraded: workerValidation.degraded,
        startedAt: Date.now(),
        durationMs: 0,
        note:
          workerValidation.missingHardFields.length > 0
            ? `硬性契约缺失: ${workerValidation.missingHardFields.join("、")}`
            : undefined,
      };
      options.monitor.record(record);
    }
  };

  // 并行窗口上限：无 retry（无信号回退风险）且**同 atom** 的连续阶段才可并行
  // （如 extract 三路分键提取）。非同 atom 阶段（approval-gate 审批门等可能抛
  // 中断的 handler）保持串行——并行组内前序中断时后续阶段已并发执行过，
  // 与"审批门后不再执行"语义不符，故中断型阶段一律不进并行组。
  const MAX_PARALLEL_STAGES = 4;

  for (let index = startIndex; index < manifest.stages.length; ) {
    // 计算可并行窗口（从当前 stage 起，连续且无 retry、同 atom 的阶段）。
    let window = 1;
    const groupAtom = manifest.stages[index]!.atom;
    while (index + window < manifest.stages.length && window < MAX_PARALLEL_STAGES) {
      const candidate = manifest.stages[index + window]!;
      if (candidate.retry !== undefined || candidate.atom !== groupAtom || groupAtom === undefined) break;
      window += 1;
    }

    if (window > 1) {
      // 并行组：各 stage 独立执行（无 retry → 组内不可能触发信号回退；
      // interrupted 在组内全部完成后按顺序处理，与串行 break 语义一致）。
      const group = manifest.stages.slice(index, index + window);
      const outcomes = await Promise.all(group.map(stage => runStageOnce(stage, state, stageOptions)));
      let groupInterrupted: WorkflowInterrupt | undefined;
      for (let gi = 0; gi < outcomes.length; gi += 1) {
        const outcome = outcomes[gi]!;
        if (outcome.interrupted) {
          groupInterrupted = outcome.interrupted;
          break;
        }
        pushResult(group[gi]!, outcome);
      }
      if (groupInterrupted) {
        interrupted = groupInterrupted;
        break;
      }
      index += window;
      await saveCheckpoint(index);
      continue;
    }

    const stage = manifest.stages[index]!;
    const outcome = await runStageOnce(stage, state, stageOptions);
    if (outcome.interrupted) {
      interrupted = outcome.interrupted;
      break;
    }
    const { output, retries } = outcome;

    // 一致性重试循环（对齐 Mady check_consistency 条件回退边）：输出触发信号时
    // 回退到 rewindTo 阶段重新执行（含中间阶段），覆盖被回退阶段的旧结果与 state。
    if (output.trim().length > 0 && stage.retry !== undefined) {
      const signal = signalFor(stage, signalCache);
      if (signal !== undefined && signalMatches(output, signal)) {
        const rewindTo = stage.retry.rewindTo ?? stage.id;
        const rewindIndex = stageIds.get(rewindTo)!;
        const rewindCount = (rewindCounts.get(stage.id) ?? 0) + 1;
        const maxRewind = stage.retry.maxRetries ?? 1;
        if (rewindCount > maxRewind) {
          // 超过最大回退次数：保留当前（不一致）输出并继续，标记 degraded。
          results.push({
            stageId: stage.id,
            strategy: stage.strategy,
            output: `[WORKFLOW_RETRY_EXHAUSTED] ${stage.id}: ${output}`,
            degraded: true,
            retries,
            ...(stage.atom !== undefined ? { atom: stage.atom } : {}),
          });
          index += 1;
          await saveCheckpoint(index);
          continue;
        }
        // 覆盖从 rewindTo 起的结果与 state 键（防陈旧输出被兜底复用），回退重执行。
        rewindCounts.set(stage.id, rewindCount);
        results.splice(rewindIndex);
        for (const rewinded of manifest.stages.slice(rewindIndex)) {
          delete state[rewinded.id];
          // 清理原子输出键（2026-08 修复）：只删 stage-id 键时，重跑中某路解析
          // 失败（如 extract 非 JSON 保留原文）会残留旧一代数组，下游 merge
          // 混用两代提取结果且无降级告警。
          if (rewinded.atom !== undefined) {
            for (const key of atoms.lookup(rewinded.atom)?.outputSchema ?? []) {
              delete state[key];
            }
          }
        }
        index = rewindIndex;
        continue;
      }
    }

    pushResult(stage, { output, retries, workerValidation: outcome.workerValidation });
    index += 1;
    await saveCheckpoint(index);
  }

  const degradedSteps = results.filter(r => r.degraded).map(r => r.stageId);
  const completed = !requireAll || (degradedSteps.length === 0 && interrupted === undefined);
  const okCount = results.filter(r => !r.degraded).length;

  let summary: string;
  if (interrupted) {
    summary = `工作流 ${manifest.id}（${manifest.name}）: 已执行 ${results.length}/${manifest.stages.length} 阶段，在 "${interrupted.stageId}" 暂停等待人工确认`;
  } else {
    summary = `工作流 ${manifest.id}（${manifest.name}）: ${okCount}/${results.length} 阶段完成${degradedSteps.length > 0 ? `，降级阶段: ${degradedSteps.join("、")}` : ""}`;
  }

  const result: WorkflowRunResult = {
    manifestId: manifest.id,
    caseType: manifest.caseType,
    completed,
    stages: results,
    degradedSteps,
    summary,
    ...(interrupted ? { interrupted } : {}),
  };
  // 持久化失败不阻断执行结果（对齐工具层"持久化失败仅提示"的语义），
  // 仅把告警带回结果供调用方展示。
  try {
    await options.persist?.saveRun(result, options.runId);
  } catch (error) {
    result.persistWarning = `持久化失败（不影响执行结果）: ${error instanceof Error ? error.message : String(error)}`;
  }
  return result;
}
