/**
 * src/patent/provenance — 审计导出（CSV 时间线 / JSON 完整图）。
 *
 * 对齐方案 §3.4：csv 为人工审查时间线（客户/审查员视角：谁、何时、基于什么、
 * 得出什么）；json 为机器消费 / 回归快照。rdf（PROV-O Turtle）为三期条件触发，
 * 本期不实现。
 *
 * caseId=null 导出全局审批审计库（approval-audit.db）；否则导出 per-case 决策链库。
 * CSV 按 RFC 4180 转义（值含逗号/双引号/换行时引号包裹、内部引号加倍）。
 */

import { join } from "node:path";
import { provenanceAuditDir, caseProvenanceDir } from "../paths.js";
import { APPROVAL_AUDIT_DB } from "./approval-store.js";
import { ProvenanceStore } from "./provenance-store.js";
import type { ProvenanceActivity, ProvenanceEntity } from "./types.js";

export type ProvenanceExportFormat = "json" | "csv";

export type ExportProvenanceOptions = {
  /** null = 全局审批审计库；string = per-case 决策链库。 */
  caseId: string | null;
  format: ProvenanceExportFormat;
  /** per-case 路径解析 cwd（缺省 process.cwd）。 */
  cwd?: string;
  /** 全局库路径解析 env（缺省 process.env）。 */
  env?: NodeJS.ProcessEnv;
};

/** CSV 列：时间, 来源, 活动, 执行者, 输入(used), 产出, 审批结论。 */
const CSV_HEADER = ["时间", "来源", "活动", "执行者", "输入(used)", "产出", "审批结论"];

/** RFC 4180 转义：含逗号/双引号/换行时双引号包裹，内部引号加倍。 */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 审批结论短描述：approval_gate → kind（pending/granted）；output_gate → verdict（adopted/...）。 */
function approvalConclusion(entity: ProvenanceEntity | undefined, activity: ProvenanceActivity): string {
  if (entity === undefined || entity.kind !== "approval") return "";
  try {
    const parsed = JSON.parse(entity.value) as { kind?: unknown; verdict?: unknown };
    if (activity.source === "approval_gate" && typeof parsed.kind === "string") return parsed.kind;
    if (activity.source === "output_gate" && typeof parsed.verdict === "string") return parsed.verdict;
    return "";
  } catch {
    return "";
  }
}

/** 按 caseId 打开对应库（不存在时创建空库，导出空结果——幂等）。 */
function openStore(options: ExportProvenanceOptions): ProvenanceStore {
  const env = options.env ?? process.env;
  if (options.caseId === null) {
    return new ProvenanceStore(join(provenanceAuditDir(env), APPROVAL_AUDIT_DB));
  }
  return new ProvenanceStore(join(caseProvenanceDir(options.caseId, options.cwd ?? process.cwd()), "provenance.db"));
}

/** 导出审计（JSON 完整图 / CSV 时间线），返回 Buffer。 */
export function exportProvenance(options: ExportProvenanceOptions): Buffer {
  const store = openStore(options);
  try {
    const activities = store.listActivities(undefined);
    const entities = store.listEntities(undefined);
    const agents = store.listAgents();

    if (options.format === "json") {
      return Buffer.from(JSON.stringify({ activities, entities, agents }, null, 2), "utf8");
    }

    // csv：时间线视图（每 activity 一行；产出 = 该活动生成的 entity 值）
    const byActivity = new Map<string, ProvenanceEntity>();
    for (const entity of entities) {
      if (entity.generatedByActivityId !== undefined && !byActivity.has(entity.generatedByActivityId)) {
        byActivity.set(entity.generatedByActivityId, entity);
      }
    }
    const lines = [CSV_HEADER.map(csvEscape).join(",")];
    for (const activity of activities) {
      const entity = byActivity.get(activity.id);
      const row = [
        new Date(activity.startedAt).toISOString(),
        activity.source,
        activity.name,
        activity.agentId,
        activity.inputIds.join(" "),
        entity?.value ?? "",
        approvalConclusion(entity, activity),
      ];
      lines.push(row.map(csvEscape).join(","));
    }
    return Buffer.from(lines.join("\n"), "utf8");
  } finally {
    store.close();
  }
}
