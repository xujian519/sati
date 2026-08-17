// dream-review 的 trace 追踪基建（从 dream-review.ts 拆出，G3 聚类，逐字搬移）。
// createDreamTrace/mutation 含 Math.random 与 Date.now（非确定性但无 IO），
// pushStep 只改传入 trace 对象。
import type { DreamTraceMutation, DreamTraceRecord, DreamTraceStep, TraceI18nText } from "../types.js";
import { hashText, nowIso } from "../utils/id.js";

function createDreamTrace(trigger: DreamTraceRecord["trigger"]): DreamTraceRecord {
  const startedAt = nowIso();
  return {
    dreamTraceId: `dream_trace_${hashText(`${trigger}:${startedAt}:${Math.random().toString(36).slice(2, 10)}`)}`,
    trigger,
    startedAt,
    status: "running",
    isNoOp: false,
    displayStatus: "Running",
    snapshotSummary: {
      projectMetaPresent: false,
      projectFileCount: 0,
      feedbackFileCount: 0,
      hasUserProfile: false,
    },
    steps: [],
    mutations: [],
    outcome: {
      rewrittenProjects: 0,
      deletedProjects: 0,
      deletedFiles: 0,
      profileUpdated: false,
      summary: "",
    },
  };
}

function pushStep(
  trace: DreamTraceRecord,
  kind: DreamTraceStep["kind"],
  title: string,
  status: DreamTraceStep["status"],
  inputSummary: string,
  outputSummary: string,
  options: {
    refs?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    details?: DreamTraceStep["details"];
    promptDebug?: DreamTraceStep["promptDebug"];
    titleI18n?: TraceI18nText;
    inputSummaryI18n?: TraceI18nText;
    outputSummaryI18n?: TraceI18nText;
  } = {},
): void {
  trace.steps.push({
    stepId: `${trace.dreamTraceId}:step:${trace.steps.length + 1}`,
    kind,
    title,
    status,
    inputSummary,
    outputSummary,
    ...(options.refs ? { refs: options.refs } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.details ? { details: options.details } : {}),
    ...(options.promptDebug ? { promptDebug: options.promptDebug } : {}),
    ...(options.titleI18n ? { titleI18n: options.titleI18n } : {}),
    ...(options.inputSummaryI18n ? { inputSummaryI18n: options.inputSummaryI18n } : {}),
    ...(options.outputSummaryI18n ? { outputSummaryI18n: options.outputSummaryI18n } : {}),
  });
}

function mutation(
  action: DreamTraceMutation["action"],
  relativePath: string,
  options: {
    candidateType?: DreamTraceMutation["candidateType"];
    name?: string;
    description?: string;
    preview?: string;
  } = {},
): DreamTraceMutation {
  return {
    mutationId: `mutation_${hashText(`${action}:${relativePath}:${Date.now()}:${Math.random()}`)}`,
    action,
    relativePath,
    ...(options.candidateType ? { candidateType: options.candidateType } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.preview ? { preview: options.preview } : {}),
  };
}

export { createDreamTrace, mutation, pushStep };
