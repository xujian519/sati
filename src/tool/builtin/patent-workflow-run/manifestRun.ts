import { globalAtomRegistry, globalStageHandlerRegistry } from "../../../patent/atoms/index.js";
import {
  JsonFileManifestCheckpointStore,
  JsonFileWorkflowRunStore,
  WorkerMonitor,
  builtinPatentManifests,
  defaultPatentWorkers,
  runWorkflow,
  validateWorkflowManifest,
} from "../../../patent/index.js";
import {
  buildWorkflowProvider,
  buildWorkflowRunContext,
  previewText,
  renderWorkflowResultText,
  resolveRunPersistTarget,
  runRuleGate,
  writeRunArtifacts,
} from "../patentWorkflowTool.js";
import type { ManifestCheckpoint, WorkflowManifest } from "../../../patent/index.js";
import type { SatiToolExecutionOutput, SatiToolRuntimeContext } from "../../protocol/types.js";
import { openProvenanceCollector } from "./provenance.js";
import type { PatentWorkflowRunDeps, PatentWorkflowRunInput } from "./types.js";

/** 工厂注入的运行期依赖（manifest 表在工厂构建一次后复用）。 */
export type PatentWorkflowRunRuntime = {
  deps: PatentWorkflowRunDeps;
  manifests: Map<string, WorkflowManifest>;
};

/** manifest 模式执行：续跑检查点 → 溯源旁路 → worker 监控 → runWorkflow → 规则门与持久化。 */
export async function runManifestWorkflow(
  runtime: PatentWorkflowRunRuntime,
  input: PatentWorkflowRunInput,
  context: SatiToolRuntimeContext,
): Promise<SatiToolExecutionOutput> {
  const { deps, manifests } = runtime;
  // 默认 patent_disclosure_v1（PFE 管线）；多个内置 manifest 声明 atom
  // （claim-chart/draft-claims/novelty/reasoning 等），均可经本工具自动执行。
  const manifest: WorkflowManifest | undefined = manifests.get(input.manifestId ?? "patent_disclosure_v1");
  if (!manifest) {
    const available = [...manifests.keys()].join(", ");
    return {
      content: [
        { type: "text", text: `patent_workflow_run: 未知 manifest "${input.manifestId}"（可用: ${available}）` },
      ],
    };
  }
  try {
    validateWorkflowManifest(manifest);
  } catch (err) {
    return {
      content: [{ type: "text", text: `patent_workflow_run: manifest 校验失败: ${(err as Error).message}` }],
    };
  }

  // 模型客户端：deps 优先，否则运行时上下文（AgentLoop 注入）；皆无时明确报错。
  // caseId 透出：claim-chart 等原子按 provider.caseId 落盘/核验合并。
  const provider = buildWorkflowProvider(deps, { ...context, caseId: input.caseId });
  if (!provider) {
    return {
      content: [
        {
          type: "text",
          text: "patent_workflow_run: 未提供模型客户端（context.model 缺失），无法执行原子阶段。请在有模型会话中调用。",
        },
      ],
    };
  }

  // 统一 ctx 映射：各原子输入键（text/source_text/extraction_input）指向同一份输入。
  const workflowCtx = buildWorkflowRunContext({
    caseId: input.caseId,
    input: input.input,
    maxResults: input.maxResults,
    chartTargets: input.chartTargets,
    claimText: input.claimText,
  });

  // 无 atom 阶段（preprocess/report）：透传输入文本（等价"未预处理"），不 degraded。
  const executor = async (): Promise<string> => input.input;

  // caseId 持久化（复用收口工具目录约定）：runWorkflow 内 saveRun JSON，执行后补 .mmd。
  const persistTarget = resolveRunPersistTarget(input.caseId, manifest.id, context?.cwd ?? process.cwd());

  // 断点续跑（T10，manifest 模式）：resumeCheckpointId 提供时从上次检查点继续
  // （跳过已完成阶段；配合 approveStageIds 放行审批门）。无 caseId 时不可续跑。
  let resumeFrom: ManifestCheckpoint | undefined;
  const checkpointDir = persistTarget?.runsDir;
  if (input.resumeCheckpointId !== undefined) {
    if (checkpointDir === undefined) {
      return {
        content: [
          {
            type: "text",
            text: "patent_workflow_run: manifest 模式断点续跑需要 caseId（检查点持久化目录）。请提供 caseId。",
          },
        ],
      };
    }
    const store = new JsonFileManifestCheckpointStore(checkpointDir);
    resumeFrom = await store.load(input.resumeCheckpointId);
    if (resumeFrom === undefined) {
      return {
        content: [
          {
            type: "text",
            text: `patent_workflow_run: 检查点 "${input.resumeCheckpointId}" 不存在（${checkpointDir}）。请先执行一次产生检查点，或去掉 resumeCheckpointId 从零开始。`,
          },
        ],
      };
    }
  }

  // 溯源旁路（T3）：SATI_PROVENANCE=1 + caseId 时收集审批门挂起/放行；resume 复用 runId。
  const provenanceCollector = openProvenanceCollector({
    caseId: input.caseId,
    cwd: context?.cwd ?? process.cwd(),
    runKey: manifest.id,
    resume: input.resumeCheckpointId !== undefined,
  });

  // Worker 执行监控（T4）：装配 monitor 使生产路径产生 worker 记录（此前
  // runWorkflow 未传 monitor，workflow.ts 的 monitor.record 为死路径）；
  // onRecord 旁路审计落盘（outputPath 从 worker 契约 outputs[0].path 推导；
  // recordWorker 内部 fail-open，store 抛错不外泄，评审 C2）。
  const workerMonitor = new WorkerMonitor({
    onRecord: record => {
      if (provenanceCollector === null) return;
      const contract = defaultPatentWorkers().find(w => w.name === record.workerName);
      const outputPath = contract?.outputs?.[0]?.path?.replace(/\{caseId\}/g, input.caseId ?? "");
      provenanceCollector.recordWorker({ record, outputPath });
    },
  });

  // 评审 C2：runWorkflow 抛错（含 store 异常）也必须释放 collector 句柄
  // （DatabaseSync 无 GC finalizer 保证，Windows 上不关闭无法删库/替换，EBUSY）。
  let result;
  try {
    result = await runWorkflow(manifest, workflowCtx, executor, {
      handlers: deps.handlers ?? globalStageHandlerRegistry,
      atoms: globalAtomRegistry,
      provider,
      persist: persistTarget ? new JsonFileWorkflowRunStore(persistTarget.runsDir) : undefined,
      runId: persistTarget?.runId,
      monitor: workerMonitor,
      // 断点续跑：resumeFrom 跳过已完成阶段；checkpointStore 每阶段落盘。
      ...(resumeFrom !== undefined ? { resumeFrom } : {}),
      ...(checkpointDir !== undefined ? { checkpointStore: new JsonFileManifestCheckpointStore(checkpointDir) } : {}),
      // 已人工批准的审批门：重跑时跳过（放行），未批准的照常中断。
      ...(input.approveStageIds !== undefined && input.approveStageIds.length > 0
        ? { approvalGrants: input.approveStageIds }
        : {}),
    });
  } catch (err) {
    provenanceCollector?.close();
    throw err;
  }

  // 审批门溯源：放行集合 = 显式 approveStageIds ∪ resume 合并的 approvalGrants
  // （幂等键保证 resume 自动放行不重复记录）；挂起 = result.interrupted。
  if (provenanceCollector !== null) {
    try {
      const granted = new Set([...(input.approveStageIds ?? []), ...(resumeFrom?.approvalGrants ?? [])]);
      for (const stageId of granted) {
        provenanceCollector.recordApprovalGate({ stageId, kind: "granted" });
      }
      if (result.interrupted !== undefined) {
        provenanceCollector.recordApprovalGate({
          stageId: result.interrupted.stageId,
          kind: "pending",
          message: result.interrupted.message,
        });
      }
    } finally {
      provenanceCollector.close();
    }
  }

  const persistNote = persistTarget
    ? await writeRunArtifacts(persistTarget, manifest, result)
    : "持久化: 未启用（未提供 caseId）";

  const lines = result.stages.map(s => {
    const flag = s.degraded ? "⚠️ 降级" : "✅";
    return `- ${flag} ${s.stageId}${s.atom !== undefined ? ` [atom:${s.atom}]` : ""}: ${previewText(s.output)}`;
  });

  const interruptNote = result.interrupted
    ? `⏸ 审批门暂停: "${result.interrupted.stageId}"（${result.interrupted.message}）——等待人工确认，后续阶段未执行`
    : undefined;

  // 确定性规则门（复用收口工具）：非降级阶段产出拼接文本判级；中断时不跑（产出不完整）。
  const entry = builtinPatentManifests.find(e => e.manifest.id === manifest.id);
  const checkSection =
    result.interrupted === undefined && entry !== undefined ? runRuleGate(result, entry.checkDomains) : "";

  return {
    content: [
      {
        type: "text",
        text: renderWorkflowResultText({
          toolName: "patent_workflow_run",
          result,
          stageLines: lines,
          persistNote,
          checkSection,
          interruptNote,
        }),
      },
    ],
  };
}
