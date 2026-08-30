import { join } from "node:path";
import { buildVerdictEnvelope, collectJudgeVotes, renderConsensusText, resolveConsensus } from "../../patent/index.js";
import {
  builtinPatentManifests,
  runWorkflow,
  validateWorkflowManifest,
  JsonFileWorkflowRunStore,
  JsonFileManifestCheckpointStore,
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  runGraphWithCheckpoints,
  grantApproval,
  DOMAIN_GRAPHS,
  caseInventivenessFeedbackPath,
  loadInventivenessFeedback,
  saveSessionCaseBinding,
  caseSessionBindingPath,
  summarizeInventivenessFeedback,
  llmJudge,
  type DomainGraphName,
  type GraphCheckpoint,
  type GraphRunResult,
  type ManifestCheckpoint,
  type WorkflowManifest,
} from "../../patent/index.js";
import { globalAtomRegistry, globalStageHandlerRegistry, type StageProvider } from "../../patent/atoms/index.js";
import { DOMAIN_INPUT_DECLARATIONS, defaultPatentWorkers, type GraphNode, WorkerMonitor } from "../../patent/index.js";
import {
  isProvenanceEnabled,
  ProvenanceCollector,
  ProvenanceStore,
  resolveProvenanceRunId,
} from "../../patent/provenance/index.js";
import { caseProvenanceDir } from "../../patent/paths.js";
import type { SatiToolDefinition, SatiToolModelClient } from "../protocol/types.js";
import {
  buildWorkflowProvider,
  buildWorkflowRunContext,
  previewText,
  renderWorkflowResultText,
  resolveRunPersistTarget,
  runRuleGate,
  writeRunArtifacts,
  type WorkflowProviderDeps,
} from "./patentWorkflowTool.js";

/**
 * `patent_workflow_run` — 原子自动执行工作流工具。
 *
 * 与 `patent_workflow`（收口语义：主代理产出文本 → 工具收口校验）互补：
 * 本工具**注入 provider 自动执行声明了 atom 的阶段**——LLM（`context.model`
 * 或 deps.model）驱动 extract/merge/groundedness/reasoning/keywords/novelty/
 * draft-claims，nuo-patent 检索驱动 search；无 atom 阶段（preprocess/report）
 * 透传输入文本（consistency 已声明 reasoning 原子，不再透传原文）。
 *
 * 审批门语义：disclosure manifest 的 review_gate 阶段（approval-gate 原子）执行时
 * 抛 InterruptStageError → 工作流**暂停**（返回 interrupted，后续阶段不执行）。
 * 断点续跑（manifest 模式）：提供 resumeCheckpointId + caseId 时从上次检查点继续
 * （跳过已完成阶段），approveStageIds 放行已批准审批门；无 caseId 时不可续跑。
 * 图模式（graph=…）另支持 resumeCheckpointId / approveCheckpointId（见 execute）。
 * 人工确认后的 draft_claims 等后续阶段，可由主代理基于 interrupted 结果 +
 * 收口语义（patent_workflow 工具）或自定义 manifest 继续。
 *
 * 接线状态（2026-08）：本工具是原子执行路径的唯一生产消费方——此前 10 个内置
 * 原子 handler 与 createNuoSearchProvider 均无生产调用（详见 src/patent/workflow.ts
 * 头注释的"单一路径"原则：收口 + 原子两条路径并存，各有明确消费工具）。
 */

export type PatentWorkflowRunInput = {
  /** 工作流 manifest id（缺省 "patent_disclosure_v1"；多个内置 manifest 声明 atom，均可自动执行）。 */
  manifestId?: string;
  /**
   * 领域子图模式：命中时走图引擎自动执行对应子图（A22.2 新颖性 / A22.3 创造性 /
   * A26.3 充分公开），一次调用跑完全部节点（LLM + 检索 + 规则门），无需主代理驱动。
   * 缺省走 manifest 路径（向后兼容）。
   */
  graph?: DomainGraphName;
  /** 图模式断点续跑：提供 checkpoint id（上次中断返回）时从该检查点继续。 */
  resumeCheckpointId?: string;
  /**
   * 图模式审批：批准该检查点的审批门（写入放行标记）后从该检查点续跑——
   * 审批门节点重放时检测到标记即放行，后续节点继续执行（真正通过审批门）。
   * 与 resumeCheckpointId 互斥：提供时优先，等价"批准 + 续跑"。
   */
  approveCheckpointId?: string;
  /**
   * manifest 模式审批：已人工批准的审批门阶段 id 列表（如 ["review_gate"]）。
   * 重跑时这些审批门跳过执行直接放行，未批准的照常中断——实现"批准后继续"。
   */
  approveStageIds?: string[];
  /** 案例标识（用于结果记录与持久化；可含 {caseId} 占位）。 */
  caseId?: string;
  /** 初始材料（技术交底书等），映射为各原子读取的 text/source_text/extraction_input。 */
  input: string;
  /**
   * 权利要求书全文（可选，A26.3 enablement 图专用）：单独传入时 enablement/conclude
   * 节点按"权利要求保护的技术方案"判断；缺省回退 input（与 text 相同）。
   */
  claimText?: string;
  /**
   * claim-chart 阶段的目标对象 JSON（[{id,kind,title?,source_path?}]）；缺省为空
   * （只拆分要素，逐行映射留待后续补充）。kind 取值 prior-art（对比文件）/
   * product（被控产品）。
   */
  chartTargets?: string;
  /** 检索结果上限（缺省 5，透传给 provider.search）。 */
  maxResults?: number;
  /**
   * 图模式检索反思回路最大重检次数（缺省 2，0 = 关闭回路保持旧行为）。
   * 覆盖不足时自动换检索式补检，最多重检该次数后放行 closest。
   */
  retrievalRounds?: number;
  /**
   * LLM Judge 双轨质量分（缺省关闭）：>0 时对图模式的结论报告打 0-1 分
   * （N 次采样取中位数），附在结果尾部，不改变规则门判级。
   */
  judgeSamples?: number;
  /**
   * 多模型共识（缺省关闭）：modelHint 名列表（如 ["judge-a","judge-b"]，经
   * deps.modelHints 配置各 hint 的 provider/model）。提供时对结论报告做
   * 多 judge 并行投票 → 中位数 + 离散度分歧检测（spread > 0.25 判 disagree，
   * 结果附"需人工复核"审计标记，不自动挂 HITL）→ 共识判定 + Verdict Envelope
   * （typed verdict 审计：机械规则门
   * 层 + 语义票层 + 共识层，内容哈希防篡改）。缺省走 judgeSamples 单模型路径。
   */
  judgeModels?: string[];
};

/** provider 装配字段（model/provider/modelId/search）单一来源见 patentWorkflowTool 的 WorkflowProviderDeps。 */
export type PatentWorkflowRunDeps = WorkflowProviderDeps & {
  /** 阶段处理器注册表（缺省全局注册表——registerBuiltinAtoms 已装配内置原子）。 */
  handlers?: typeof globalStageHandlerRegistry;
};

export function createPatentWorkflowRunTool(
  deps: PatentWorkflowRunDeps = {},
): SatiToolDefinition<PatentWorkflowRunInput> {
  const manifests = new Map(builtinPatentManifests.map(({ manifest }) => [manifest.id, manifest]));

  return {
    name: "patent_workflow_run",
    outputSchema: {
      type: "object",
      properties: {},
    },
    aliases: ["PatentWorkflowRun", "run_patent_atoms"],
    description:
      "Automatically execute a declarative patent workflow (atom stages) or a domain graph. Manifest path: " +
      "patent_disclosure_v1 (PFE extraction → prior-art search → per-feature novelty → review gate → claims draft), " +
      "patent_drafting_v1 (disclosure pipeline → prior-art compare → drafting: claims draft + specification draft + " +
      "deterministic spec validation + slop score gate; HITL at deconstruct/search/compare/disclosure/final). " +
      "Graph path (graph=novelty|inventiveness|enablement): runs a full domain graph (LLM nodes + patent search + " +
      "deterministic rule gate) in one call — e.g. graph=inventiveness runs the A22.3 three-step analysis end-to-end. " +
      "Provide the input as 'input'. The review gate pauses the run (reports interrupted + checkpointId); re-invoking " +
      "with resumeCheckpointId continues from the pause point (the gate pauses again), while approveCheckpointId " +
      "grants the gate and resumes past it. Manifest path: approveStageIds skips approved gates on rerun; " +
      "resumeCheckpointId (with caseId) resumes past completed stages from the manifest checkpoint. " +
      "When caseId is provided, run results, the Mermaid " +
      "diagram, and graph checkpoints are persisted under <caseDir>/workflow-runs/. Requires a model client.",
    kind: "session",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["input"],
      additionalProperties: false,
      properties: {
        manifestId: {
          type: "string",
          description:
            "Workflow manifest id. Defaults to 'patent_disclosure_v1'; multiple built-in manifests declare atoms (claim-chart etc.) and run automatically.",
        },
        graph: {
          type: "string",
          enum: ["novelty", "inventiveness", "enablement"],
          description:
            "Domain graph to run: novelty (A22.2), inventiveness (A22.3 three-step), enablement (A26.3). " +
            "Runs all LLM/search/rule-gate nodes up to the approval gate, which pauses the run (HITL); " +
            "re-invoke with resumeCheckpointId to continue (the gate pauses again until approved). " +
            "Mutually exclusive with manifestId.",
        },
        resumeCheckpointId: {
          type: "string",
          description:
            "Graph-mode checkpoint id from a previous interrupted run; continues from that point instead of restarting.",
        },
        approveCheckpointId: {
          type: "string",
          description:
            "Graph-mode approval: grants the approval gate at this checkpoint (writes the grant marker) and resumes from it — the gate passes on replay and later nodes run. Mutually exclusive with resumeCheckpointId.",
        },
        approveStageIds: {
          type: "array",
          items: { type: "string" },
          description:
            "Manifest-mode approval: stage ids of already-approved approval gates (e.g. ['review_gate']); reruns skip these gates and continue past them.",
        },
        caseId: {
          type: "string",
          description:
            "Optional case id. When provided, the run result is persisted to <caseDir>/workflow-runs/<runId>.json plus a Mermaid diagram.",
        },
        input: {
          type: "string",
          description: "Initial material (e.g. the technical disclosure text) consumed by the extract atoms.",
        },
        claimText: {
          type: "string",
          description:
            "Optional claim text (for graph=enablement): when provided, the enablement/conclude nodes judge the claimed technical solution; defaults to the input text.",
        },
        chartTargets: {
          type: "string",
          description:
            "Target objects JSON for the claim-chart stage ([{id,kind,title?,source_path?}], kind: prior-art|product); empty by default (elements only, row mapping deferred).",
        },
        maxResults: {
          type: "number",
          description: "Max prior-art search results (default 5).",
        },
        retrievalRounds: {
          type: "number",
          description:
            "Graph-mode retrieval-reflection rounds (default 2, 0 disables the reflection loop): when search coverage is insufficient the graph re-queries up to this many times before proceeding to closest.",
        },
        judgeSamples: {
          type: "number",
          description:
            "LLM Judge quality score (default off): when >0, scores the graph conclusion report 0-1 (median of N samples) and appends it to the result — advisory only, does not change the rule-gate verdict.",
        },
        judgeModels: {
          type: "array",
          items: { type: "string" },
          description:
            "Multi-model consensus judges (default off): modelHint ids (e.g. ['judge-a','judge-b'], each mapped via deps.modelHints). When provided, votes from multiple judges → median + spread-based disagreement detection → consensus verdict + Verdict Envelope (typed, hash-sealed). Takes precedence over judgeSamples.",
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute(input, context) {
      // 图模式：领域子图自动执行（与 manifest 路径互斥）。
      if (input.graph !== undefined) {
        return executeGraphRun(input, context, deps);
      }

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
          ...(checkpointDir !== undefined
            ? { checkpointStore: new JsonFileManifestCheckpointStore(checkpointDir) }
            : {}),
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
    },
  };
}

/**
 * 打开溯源收集器（T3）：`SATI_PROVENANCE=1` 且提供 caseId 时构造 per-case collector，
 * 否则返回 null（零开销）。runId 实例化（方案 P2）：续跑（resume）复用既有 runId，
 * 新运行新建。导出供接线测试。
 */
export function openProvenanceCollector(options: {
  caseId?: string;
  cwd: string;
  runKey: string;
  resume: boolean;
}): ProvenanceCollector | null {
  if (!isProvenanceEnabled() || options.caseId === undefined) return null;
  const runId = resolveProvenanceRunId({
    caseId: options.caseId,
    cwd: options.cwd,
    runKey: options.runKey,
    resume: options.resume,
  });
  const dbPath = join(caseProvenanceDir(options.caseId, options.cwd), "provenance.db");
  return new ProvenanceCollector({ store: new ProvenanceStore(dbPath), runId, caseId: options.caseId });
}

// ---------------------------------------------------------------------------
// 图模式：领域子图自动执行（graph=novelty|inventiveness|enablement）
// ---------------------------------------------------------------------------

type GraphExecuteContext = {
  model?: SatiToolModelClient;
  cwd?: string;
  /** 会话 id（session→case 绑定写侧半桥用；SatiToolRuntimeContext 必有）。 */
  sessionId: string;
  now?: () => Date;
};

/** 渲染图运行结果文本。 */
function renderGraphResultText(opts: {
  graph: DomainGraphName;
  result: GraphRunResult;
  persistNote: string;
  checkpointNote: string;
}): string {
  const completion = opts.result.completed ? "completed" : "incomplete";
  const keyLines = Object.entries(opts.result.state)
    .filter(([key]) => !key.startsWith("_") && !key.endsWith("__degradation"))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      // 防御：state 值可能为 undefined（JSON.stringify(undefined) 返回 undefined）。
      let text: string;
      if (typeof value === "string") text = value;
      else if (value === undefined) text = "";
      else text = JSON.stringify(value);
      const preview = previewText(text, 80, "(空)");
      return `- ${key}: ${preview}`;
    });
  const degraded = opts.result.degraded.map(d => `- ${d.severity} [${d.reason}] ${d.message}`);
  // 节点耗时（阶段 0 检索耗时测量）：按节点名聚合（受控循环/反思回路下同节点多超步执行），
  // 按总耗时降序，辅助识别检索段 vs LLM 段耗时占比。resume 续跑只统计本次执行段。
  const durationByName = new Map<string, { count: number; totalMs: number }>();
  for (const d of opts.result.nodeDurations ?? []) {
    const entry = durationByName.get(d.node) ?? { count: 0, totalMs: 0 };
    entry.count += 1;
    entry.totalMs += d.durationMs;
    durationByName.set(d.node, entry);
  }
  const durations = [...durationByName.entries()]
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .map(([node, { count, totalMs }]) => {
      const mean = count > 0 ? Math.round(totalMs / count) : 0;
      return count > 1 ? `- ${node}: ${count} 次，总 ${totalMs}ms，均值 ${mean}ms` : `- ${node}: ${totalMs}ms`;
    });
  return [
    `patent_workflow_run(graph=${opts.graph}): 图引擎执行 ${opts.result.steps} 超步，完成状态: ${completion}`,
    ...keyLines,
    ...(opts.result.degraded.length > 0 ? ["", "⚠️ 降级标记:", ...degraded] : ["", "✅ 无降级"]),
    ...(durations.length > 0 ? ["", "⏱ 节点耗时（本次执行段）:", ...durations] : []),
    `规则门 verdict: ${String(opts.result.state.rule_gate_verdict ?? "（未启用）")}`,
    opts.checkpointNote,
    opts.persistNote,
    ...(opts.result.interrupted !== undefined
      ? [
          `⏸ 审批门暂停: "${opts.result.interrupted.node}"（${opts.result.interrupted.message}）——可用 resumeCheckpointId 续跑`,
        ]
      : []),
  ].join("\n");
}

/** 图模式执行入口：构建子图 → 装配 provider → 带检查点运行（可续跑）→ 渲染。 */
async function executeGraphRun(
  input: PatentWorkflowRunInput,
  context: GraphExecuteContext,
  deps: PatentWorkflowRunDeps,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const graphName = input.graph!;
  const def = DOMAIN_GRAPHS[graphName];
  const graphId = `patent_${graphName}`;
  // caseId 透出：claim-chart 等原子按 provider.caseId 落盘/核验合并（与 manifest 路径一致）。
  const provider = buildWorkflowProvider(deps, { ...context, caseId: input.caseId });
  if (!provider) {
    return {
      content: [
        {
          type: "text",
          text: `patent_workflow_run: 未提供模型客户端（context.model 缺失），无法执行图 ${graphName}。请在有模型会话中调用。`,
        },
      ],
    };
  }

  // 统一 ctx 映射（与 manifest 路径一致）。
  const workflowCtx = buildWorkflowRunContext({
    caseId: input.caseId,
    input: input.input,
    maxResults: input.maxResults,
    chartTargets: input.chartTargets,
    claimText: input.claimText,
  });

  // HITL 反馈回流（P2-4）：同 case 历史人工反馈注入 conclude 提示（仅提示，不强制）。
  if (graphName === "inventiveness" && input.caseId !== undefined) {
    const feedbackPath = join(context.cwd ?? process.cwd(), caseInventivenessFeedbackPath(input.caseId));
    const history = await loadInventivenessFeedback(feedbackPath).catch(() => []);
    const summary = summarizeInventivenessFeedback(history);
    if (summary.length > 0) workflowCtx.inventiveness_feedback_history = summary;
    // 写侧半桥：落 session→case 绑定，审批驳回/修改回调按 sessionId 反查 caseId 落反馈；
    // 写失败不阻断 run（fail-open）。graph 标记绑定来源，供反馈记录溯源甄别。
    const now = context.now ?? (() => new Date());
    await saveSessionCaseBinding(join(context.cwd ?? process.cwd(), caseSessionBindingPath(input.caseId)), {
      sessionId: context.sessionId,
      boundAt: now().toISOString(),
      graph: "inventiveness",
    }).catch(() => undefined);
  }

  // 审批/续跑：approveCheckpointId 优先——批准审批门（写入放行标记）后从该检查点
  // 继续，审批门节点重放时放行、后续节点执行；否则 resumeCheckpointId 直接续跑
  // （不改变审批门状态，门会再次暂停等待审批）。
  const resumeSpec =
    input.approveCheckpointId !== undefined
      ? { checkpointId: input.approveCheckpointId, grant: true }
      : input.resumeCheckpointId !== undefined
        ? { checkpointId: input.resumeCheckpointId, grant: false }
        : undefined;

  // 溯源旁路（T3/T8）：SATI_PROVENANCE=1 + caseId 时收集审批门/图节点/降级；resume 复用 runId。
  const provenanceCollector = openProvenanceCollector({
    caseId: input.caseId,
    cwd: context?.cwd ?? process.cwd(),
    runKey: graphId,
    resume: resumeSpec !== undefined,
  });

  // 检查点：caseId 提供时持久化到 <caseDir>/workflow-runs/checkpoints/，否则内存。
  const graph = def
    .build({
      handlers: deps.handlers ?? globalStageHandlerRegistry,
      // 检索反思回路开关：retrievalRounds 透传给 inventiveness 图的 retrieval.maxRounds
      // （缺省 2 = 最多重检 2 次；0 = 关闭回路保持旧行为）。novelty/enablement 忽略该选项。
      ...(graphName === "inventiveness" && input.retrievalRounds !== undefined
        ? { retrieval: { maxRounds: input.retrievalRounds } }
        : {}),
      // 图节点溯源（T8）：addNode 统一入口包装（含裸节点），声明表缺失只记产出不伪造因果。
      ...(provenanceCollector !== null
        ? {
            onAddNode: (name: string, node: GraphNode) =>
              provenanceCollector!.wrapNode(name, node, DOMAIN_INPUT_DECLARATIONS[graphName][name]),
          }
        : {}),
    })
    .compile(def.entry);
  let store;
  let persistNote = "持久化: 未启用（未提供 caseId）";
  if (input.caseId !== undefined) {
    const persistTarget = resolveRunPersistTarget(input.caseId, graphId, context.cwd ?? process.cwd());
    if (persistTarget !== undefined) {
      store = new JsonFileCheckpointStore(join(persistTarget.runsDir, "checkpoints"));
      persistNote = `持久化: checkpoints 目录 ${join(persistTarget.runsDir, "checkpoints")}`;
    }
  }
  store ??= new InMemoryCheckpointStore();

  let resumeFrom: GraphCheckpoint | undefined;
  let result: GraphRunResult;
  let checkpointId: string | undefined;
  try {
    if (resumeSpec !== undefined) {
      if (resumeSpec.grant) {
        resumeFrom = await grantApproval(store, resumeSpec.checkpointId);
        // 审批门放行旁路：以检查点标识本次放行（幂等键防 resume 重放重复）。
        provenanceCollector?.recordApprovalGate({
          stageId: `checkpoint:${resumeSpec.checkpointId}`,
          kind: "granted",
        });
      } else {
        resumeFrom = await store.load(resumeSpec.checkpointId);
      }
      if (resumeFrom === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `patent_workflow_run: 检查点 "${resumeSpec.checkpointId}" 不存在（可用 checkpoints 目录下的 id）。`,
            },
          ],
        };
      }
    }

    ({ result, checkpointId } = await runGraphWithCheckpoints(graph, workflowCtx, {
      store,
      graphId,
      provider,
      resumeFrom,
      // 超步钩子（T8）：collector 维护 currentStep（GraphNodeContext 无 stepIndex，评审 P9）。
      onSuperStepStart: async step => {
        provenanceCollector?.setCurrentStep(step);
      },
    }));

    // 全图降级标记（结果侧，覆盖引擎级直接写 state 的降级路径，评审 P9）。
    if (result.degraded.length > 0) {
      provenanceCollector?.recordDegradations(result.degraded);
    }

    // 审批门挂起旁路（评审 I5：与 granted 同口径——均用 checkpoint 标识，
    // 否则 pending 用节点名、granted 用 checkpoint id 两条记录无法按 stageId 关联）。
    if (result.interrupted !== undefined) {
      provenanceCollector?.recordApprovalGate({
        stageId: `checkpoint:${checkpointId ?? "unknown"}`,
        kind: "pending",
        message: result.interrupted.message,
      });
    }
  } finally {
    provenanceCollector?.close();
  }

  const checkpointNote = checkpointId
    ? `检查点: ${checkpointId}${result.interrupted !== undefined ? "（中断可续跑）" : ""}`
    : "检查点: 无";

  // LLM Judge 双轨质量分（P2-3）→ 第三刀升级：judgeModels 提供时走多模型共识链
  // （collectJudgeVotes → resolveConsensus → Verdict Envelope）；否则保留单模型
  // N 采样中位数（judgeSamples，向后兼容）。均附在结果尾部、不改变规则门判级。
  const judgeNote = await buildJudgeSection({
    graphName,
    input: input.input,
    report: String(result.state.inventiveness_conclusion ?? ""),
    ruleGateVerdict: String(result.state.rule_gate_verdict ?? "unknown"),
    ruleGateDomains: Array.isArray(result.state.rule_gate_domains) ? (result.state.rule_gate_domains as string[]) : [],
    judges: assembleGraphJudges(input, deps),
    samples: input.judgeSamples ?? 1,
    singleModelFallback: input.judgeSamples ?? 0,
    interrupted: result.interrupted !== undefined,
    provider,
  });

  return {
    content: [
      {
        type: "text",
        text: renderGraphResultText({ graph: graphName, result, persistNote, checkpointNote }) + judgeNote,
      },
    ],
  };
}

/** 图模式 judge 装配（消费 judgeModels → deps.modelHints；缺省单 judge 走默认模型）。 */
function assembleGraphJudges(input: PatentWorkflowRunInput, deps: PatentWorkflowRunDeps): NamedJudgeInput[] {
  const hints = input.judgeModels ?? [];
  // 无共识配置：单 judge（默认模型）——采样数由调用方控制（judgeSamples）。
  if (hints.length === 0) {
    return [{ judgeId: "default" }];
  }
  return hints.map(hint => {
    const mapped = deps.modelHints?.[hint];
    return {
      judgeId: `judge:${hint}`,
      ...(mapped?.provider !== undefined ? { provider: mapped.provider } : {}),
      ...(mapped?.model !== undefined ? { model: mapped.model } : {}),
      modelHint: hint,
    };
  });
}

/** judge 输入形状（callLLM 由 buildJudgeSection 依 provider + modelHint 注入）。 */
type NamedJudgeInput = {
  judgeId: string;
  provider?: string;
  model?: string;
  modelHint?: string;
};

type JudgeSectionOptions = {
  graphName: string;
  /** 题目（graph 输入）。 */
  input: string;
  /** 结论报告（conclude 节点产物）。 */
  report: string;
  /** 机械层判级（rule_gate_verdict）。 */
  ruleGateVerdict: string;
  /** 机械层检查域。 */
  ruleGateDomains: string[];
  /** 已装配 judge（含 modelHint；callLLM 由本函数按 provider 注入）。 */
  judges: NamedJudgeInput[];
  /** 每 judge 采样数。 */
  samples: number;
  /** judgeSamples 单模型兼容路径的采样数（>0 且无 judgeModels 时生效）。 */
  singleModelFallback: number;
  /** 是否中断（中断时不评估）。 */
  interrupted: boolean;
  /** LLM 通道（judge 调用经 provider.callLLM，modelHint 透传 per-node 覆盖）。 */
  provider: StageProvider | undefined;
};

/**
 * 构建图模式判分段落：judgeModels 多模型共识（votes → consensus → envelope）
 * 或 judgeSamples 单模型采样（向后兼容文本）。纯逻辑可单测（注入 mock judge）。
 */
export async function buildJudgeSection(opts: JudgeSectionOptions): Promise<string> {
  if (opts.interrupted) return "";
  const report = opts.report;
  if (report.trim().length === 0) return "\n🧭 评估：无结论报告（结论节点降级），跳过评分";
  if (opts.provider?.callLLM === undefined) return "\n🧭 评估：无 LLM 通道，跳过评分";
  const multimodel = opts.judges.some(j => j.modelHint !== undefined) || opts.judges.length > 1;
  if (!multimodel && opts.singleModelFallback <= 0) return "";

  if (multimodel) {
    // 多模型共识链：各 judge 经 provider.callLLM + modelHint（宿主 modelHints 映射 provider/model）。
    const votes = await collectJudgeVotes(
      opts.judges.map(j => ({
        judgeId: j.judgeId,
        ...(j.provider !== undefined ? { provider: j.provider } : {}),
        ...(j.model !== undefined ? { model: j.model } : {}),
        callLLM: (prompt, callOpts) =>
          opts.provider!.callLLM!(prompt, {
            ...callOpts,
            ...(j.modelHint !== undefined ? { modelHint: j.modelHint } : {}),
          }),
      })),
      opts.input,
      report,
      undefined,
      { samples: opts.samples, temperature: 0 },
    );
    if (votes.length === 0) return "\n🧭 共识判定：全部 judge 评分失败（跳过）";
    const verdict = resolveConsensus(votes);
    if (verdict === undefined) return "\n🧭 共识判定：无可判定票（跳过）";
    const envelope = buildVerdictEnvelope({
      artifact: report.slice(0, 120),
      artifactType: `graph:${opts.graphName}/conclusion`,
      layers: [
        {
          layer: "mechanical",
          label: "确定性规则门",
          verdict: opts.ruleGateVerdict,
          detail: `规则门判级：${opts.ruleGateVerdict}（域：${opts.ruleGateDomains.join(", ") || "未知"}），不因共识改变。`,
          participants: [...opts.ruleGateDomains],
          at: new Date().toISOString(),
        },
        {
          layer: "semantic",
          label: "LLM Judge 多模型打分",
          verdict: votes.map(v => v.score.toFixed(2)).join(" / "),
          detail: `共 ${votes.length} 票：${votes.map(v => `${v.judgeId} ${v.score.toFixed(2)}`).join("；")}`,
          participants: votes.map(v => v.judgeId),
          at: new Date().toISOString(),
        },
        {
          layer: "consensus",
          label: "共识判定",
          verdict: verdict.verdict,
          detail: `中位 ${verdict.median.toFixed(3)}（阈值 ${verdict.threshold}），极差 ${verdict.spread.toFixed(3)}`,
          participants: [],
          at: new Date().toISOString(),
        },
      ],
    });
    return `\n${renderConsensusText(verdict)}\n🔏 Verdict Envelope: overall=${envelope.overall} | hash=${envelope.hash.slice(0, 16)}…`;
  }

  // 单模型路径（向后兼容：judgeSamples）。
  const score = await llmJudge(
    { callLLM: (prompt, callOpts) => opts.provider!.callLLM!(prompt, callOpts) },
    opts.input,
    report,
    undefined,
    { samples: opts.singleModelFallback, temperature: 0 },
  );
  return score !== undefined
    ? `\n🧭 LLM Judge 质量分（双轨参考，不影响规则门判级）: ${score.toFixed(3)}`
    : "\n🧭 LLM Judge：评分失败（采样解析异常）";
}
