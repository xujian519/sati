import { join } from "node:path";
import {
  builtinPatentManifests,
  runWorkflow,
  validateWorkflowManifest,
  JsonFileWorkflowRunStore,
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  runGraphWithCheckpoints,
  grantApproval,
  DOMAIN_GRAPHS,
  caseInventivenessFeedbackPath,
  loadInventivenessFeedback,
  summarizeInventivenessFeedback,
  llmJudge,
  type DomainGraphName,
  type GraphCheckpoint,
  type GraphRunResult,
  type WorkflowManifest,
} from "../../patent/index.js";
import { globalAtomRegistry, globalStageHandlerRegistry } from "../../patent/atoms/index.js";
import type { SatiToolDefinition, SatiToolModelClient } from "../protocol/types.js";
import {
  buildWorkflowProvider,
  buildWorkflowRunContext,
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
 * 或 deps.model）驱动 extract/merge/groundedness/keywords/novelty/draft-claims，
 * nuo-patent 检索驱动 search；无 atom 阶段（preprocess/report）透传输入文本。
 *
 * 审批门语义：disclosure manifest 的 review_gate 阶段（approval-gate 原子）执行时
 * 抛 InterruptStageError → 工作流**暂停**（返回 interrupted，后续阶段不执行）。
 * 注意：本工具**无断点续跑能力**——再次调用会从零重跑全部阶段并再次在
 * 审批门暂停。人工确认后的 draft_claims 等后续阶段，应由主代理基于
 * interrupted 结果 + 收口语义（patent_workflow 工具）或自定义 manifest 继续。
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
      "patent_disclosure_v1 (PFE extraction → prior-art search → per-feature novelty → review gate → claims draft). " +
      "Graph path (graph=novelty|inventiveness|enablement): runs a full domain graph (LLM nodes + patent search + " +
      "deterministic rule gate) in one call — e.g. graph=inventiveness runs the A22.3 three-step analysis end-to-end. " +
      "Provide the input as 'input'. The review gate pauses the run (reports interrupted + checkpointId); re-invoking " +
      "with resumeCheckpointId continues from the pause point (the gate pauses again), while approveCheckpointId " +
      "grants the gate and resumes past it. Manifest path: approveStageIds skips approved gates on rerun. " +
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
      });

      // 无 atom 阶段（preprocess/report）：透传输入文本（等价"未预处理"），不 degraded。
      const executor = async (): Promise<string> => input.input;

      // caseId 持久化（复用收口工具目录约定）：runWorkflow 内 saveRun JSON，执行后补 .mmd。
      const persistTarget = resolveRunPersistTarget(input.caseId, manifest.id, context?.cwd ?? process.cwd());
      const result = await runWorkflow(manifest, workflowCtx, executor, {
        handlers: deps.handlers ?? globalStageHandlerRegistry,
        atoms: globalAtomRegistry,
        provider,
        persist: persistTarget ? new JsonFileWorkflowRunStore(persistTarget.runsDir) : undefined,
        runId: persistTarget?.runId,
        // 已人工批准的审批门：重跑时跳过（放行），未批准的照常中断。
        ...(input.approveStageIds !== undefined && input.approveStageIds.length > 0
          ? { approvalGrants: input.approveStageIds }
          : {}),
      });

      const persistNote = persistTarget
        ? await writeRunArtifacts(persistTarget, manifest, result)
        : "持久化: 未启用（未提供 caseId）";

      const lines = result.stages.map(s => {
        const flag = s.degraded ? "⚠️ 降级" : "✅";
        const preview = s.output.length > 0 ? `${s.output.slice(0, 80)}${s.output.length > 80 ? "…" : ""}` : "(无输出)";
        return `- ${flag} ${s.stageId}${s.atom !== undefined ? ` [atom:${s.atom}]` : ""}: ${preview}`;
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

// ---------------------------------------------------------------------------
// 图模式：领域子图自动执行（graph=novelty|inventiveness|enablement）
// ---------------------------------------------------------------------------

type GraphExecuteContext = {
  model?: SatiToolModelClient;
  cwd?: string;
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
      const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
      const preview = text.length > 0 ? `${text.slice(0, 80)}${text.length > 80 ? "…" : ""}` : "(空)";
      return `- ${key}: ${preview}`;
    });
  const degraded = opts.result.degraded.map(d => `- ${d.severity} [${d.reason}] ${d.message}`);
  return [
    `patent_workflow_run(graph=${opts.graph}): 图引擎执行 ${opts.result.steps} 超步，完成状态: ${completion}`,
    ...keyLines,
    ...(opts.result.degraded.length > 0 ? ["", "⚠️ 降级标记:", ...degraded] : ["", "✅ 无降级"]),
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
  });

  // HITL 反馈回流（P2-4）：同 case 历史人工反馈注入 conclude 提示（仅提示，不强制）。
  if (graphName === "inventiveness" && input.caseId !== undefined) {
    const feedbackPath = join(context.cwd ?? process.cwd(), caseInventivenessFeedbackPath(input.caseId));
    const history = await loadInventivenessFeedback(feedbackPath).catch(() => []);
    const summary = summarizeInventivenessFeedback(history);
    if (summary.length > 0) workflowCtx.inventiveness_feedback_history = summary;
  }

  // 检查点：caseId 提供时持久化到 <caseDir>/workflow-runs/checkpoints/，否则内存。
  const graph = def
    .build({
      handlers: deps.handlers ?? globalStageHandlerRegistry,
      // 检索反思回路开关：retrievalRounds 透传给 inventiveness 图的 retrieval.maxRounds
      // （缺省 2 = 最多重检 2 次；0 = 关闭回路保持旧行为）。novelty/enablement 忽略该选项。
      ...(graphName === "inventiveness" && input.retrievalRounds !== undefined
        ? { retrieval: { maxRounds: input.retrievalRounds } }
        : {}),
    })
    .compile(def.entry);
  const graphId = `patent_${graphName}`;
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

  // 审批/续跑：approveCheckpointId 优先——批准审批门（写入放行标记）后从该检查点
  // 继续，审批门节点重放时放行、后续节点执行；否则 resumeCheckpointId 直接续跑
  // （不改变审批门状态，门会再次暂停等待审批）。
  const resumeSpec =
    input.approveCheckpointId !== undefined
      ? { checkpointId: input.approveCheckpointId, grant: true }
      : input.resumeCheckpointId !== undefined
        ? { checkpointId: input.resumeCheckpointId, grant: false }
        : undefined;
  let resumeFrom: GraphCheckpoint | undefined;
  if (resumeSpec !== undefined) {
    resumeFrom = resumeSpec.grant
      ? await grantApproval(store, resumeSpec.checkpointId)
      : await store.load(resumeSpec.checkpointId);
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

  const { result, checkpointId } = await runGraphWithCheckpoints(graph, workflowCtx, {
    store,
    graphId,
    provider,
    resumeFrom,
  });

  const checkpointNote = checkpointId
    ? `检查点: ${checkpointId}${result.interrupted !== undefined ? "（中断可续跑）" : ""}`
    : "检查点: 无";

  // LLM Judge 双轨质量分（P2-3）：judgeSamples > 0 且未中断时对结论报告打分，
  // 仅作交付参考，不改变规则门判级；评分失败/无结论报告时输出说明不报错。
  let judgeNote = "";
  const judgeSamples = input.judgeSamples;
  if (judgeSamples !== undefined && judgeSamples > 0 && result.interrupted === undefined) {
    const report = String(result.state.inventiveness_conclusion ?? "");
    if (report.trim().length === 0) {
      judgeNote = "\n🧭 LLM Judge：无结论报告（结论节点降级），跳过评分";
    } else {
      const score = await llmJudge(
        { callLLM: (prompt, opts) => provider.callLLM!(prompt, opts) },
        input.input,
        report,
        undefined,
        { samples: judgeSamples, temperature: 0 },
      );
      judgeNote =
        score !== undefined
          ? `\n🧭 LLM Judge 质量分（双轨参考，不影响规则门判级）: ${score.toFixed(3)}`
          : "\n🧭 LLM Judge：评分失败（采样解析异常）";
    }
  }

  return {
    content: [
      {
        type: "text",
        text: renderGraphResultText({ graph: graphName, result, persistNote, checkpointNote }) + judgeNote,
      },
    ],
  };
}
