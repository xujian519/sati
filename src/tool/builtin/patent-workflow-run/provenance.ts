import { join } from "node:path";
import { caseProvenanceDir } from "../../../patent/paths.js";
import {
  ProvenanceCollector,
  ProvenanceStore,
  isProvenanceEnabled,
  resolveProvenanceRunId,
} from "../../../patent/provenance/index.js";

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
