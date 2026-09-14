import { join } from "node:path";
import { globalStageHandlerRegistry } from "../../../patent/atoms/index.js";
import {
  DOMAIN_GRAPHS,
  DOMAIN_INPUT_DECLARATIONS,
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  caseInventivenessFeedbackPath,
  caseSessionBindingPath,
  grantApproval,
  loadInventivenessFeedback,
  runGraphWithCheckpoints,
  saveSessionCaseBinding,
  summarizeInventivenessFeedback,
} from "../../../patent/index.js";
import {
  buildWorkflowProvider,
  buildWorkflowRunContext,
  previewText,
  resolveRunPersistTarget,
} from "../patentWorkflowTool.js";
import type { DomainGraphName, GraphCheckpoint, GraphNode, GraphRunResult } from "../../../patent/index.js";
import type { SatiToolModelClient } from "../../protocol/types.js";
import { assembleGraphJudges, buildJudgeSection } from "./judges.js";
import { openProvenanceCollector } from "./provenance.js";
import type { PatentWorkflowRunDeps, PatentWorkflowRunInput } from "./types.js";

// ---------------------------------------------------------------------------
// 图模式：领域子图自动执行（graph=novelty|inventiveness|enablement）
// ---------------------------------------------------------------------------

export type GraphExecuteContext = {
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
export async function executeGraphRun(
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
