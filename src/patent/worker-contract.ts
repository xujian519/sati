/**
 * 声明式 Worker 契约系统（移植自 Mady agentcore/worker/contract.go + catalog.go）。
 *
 * Worker 是带显式 Input/Output 契约的专利专业子任务单元：
 *   - 五层 tier 分类（work/provision/reasoning/domain/checker）
 *   - Input/Output 契约声明（contentSchema 字段必须出现）
 *   - ContractLevel（hard 必须满足 / soft 可协商 / structured 结构化格式）
 *   - 校验失败写降级标记（DegradationMark）而非中断执行
 *   - Registry 注册完备性校验 + 懒激活
 */

export type WorkerTier = "work" | "provision" | "reasoning" | "domain" | "checker";

export type ContractLevel = "hard" | "soft" | "structured";

export type WorkerInputContract = {
  /** 期望输入（路径或描述，可含 {caseId} 占位） */
  path: string;
  /** 输入中必须出现的字段/内容模式 */
  contentSchema?: string[];
  /** 关联质量检查 ID */
  qualityGate?: string;
  /** 是否可选输入（默认 false） */
  optional?: boolean;
  description?: string;
};

export type WorkerOutputContract = {
  /** 期望输出路径（可含 {caseId} 占位） */
  path: string;
  /** 输出格式："markdown" | "json" */
  format?: "markdown" | "json";
  /** 输出中必须出现的字段（contentSchema 的硬性版本） */
  requiredFields?: string[];
  /** 契约严格度 */
  contractLevel?: ContractLevel;
};

export type WorkerContract = {
  name: string;
  tier: WorkerTier;
  description: string;
  /** 允许调用的工具（空 = 不限制） */
  allowedTools?: string[];
  inputs?: WorkerInputContract[];
  outputs?: WorkerOutputContract[];
  /** 禁止行为 */
  forbiddenActions?: string[];
  /** 可委派的其他 worker */
  canInvoke?: string[];
  /** 输出是否要求人工审批 */
  triggersHITL?: boolean;
  /** 是否启动时注册（false = 懒激活） */
  preRegister?: boolean;
};

export type WorkerOutputValidation = {
  workerName: string;
  valid: boolean;
  /** 硬性契约缺失字段（contractLevel=hard 或 requiredFields 未满足） */
  missingHardFields: string[];
  /** 软性契约缺失字段 */
  missingSoftFields: string[];
  /** 输出是否被降级标记（不中断执行） */
  degraded: boolean;
  degradationReason?: string;
};

export type WorkerExecutionRecord = {
  workerName: string;
  inputValid: boolean;
  outputValid: boolean;
  degraded: boolean;
  startedAt: number;
  durationMs: number;
  note?: string;
};

export const TIER_LABELS: Record<WorkerTier, string> = {
  work: "工序",
  provision: "条款",
  reasoning: "推理",
  domain: "领域",
  checker: "复核",
};

export class WorkerRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerRegistryError";
  }
}

/** Worker 注册表：注册、查询、完整性校验、懒激活。 */
export class WorkerRegistry {
  private readonly workers = new Map<string, WorkerContract>();
  private readonly active = new Set<string>();

  register(definition: WorkerContract): void {
    if (this.workers.has(definition.name)) {
      throw new WorkerRegistryError(`Worker "${definition.name}" already registered`);
    }
    if (!definition.name.trim() || !definition.tier || !definition.description.trim()) {
      throw new WorkerRegistryError(`Worker "${definition.name ?? "(unnamed)"}" missing name/tier/description`);
    }
    this.workers.set(definition.name, definition);
    if (definition.preRegister !== false) {
      this.active.add(definition.name);
    }
  }

  get(name: string): WorkerContract | undefined {
    return this.workers.get(name);
  }

  /** 懒激活：首次使用时注册（未预注册的 worker）。 */
  activate(name: string): WorkerContract | undefined {
    const def = this.workers.get(name);
    if (def) this.active.add(name);
    return def;
  }

  isActive(name: string): boolean {
    return this.active.has(name);
  }

  listByTier(tier: WorkerTier): WorkerContract[] {
    return [...this.workers.values()].filter(w => w.tier === tier);
  }

  list(): WorkerContract[] {
    return [...this.workers.values()];
  }

  /** 注册完备性校验：返回所有 worker 的契约缺陷（不抛出）。 */
  verify(): string[] {
    const issues: string[] = [];
    for (const w of this.workers.values()) {
      if (!w.outputs || w.outputs.length === 0) {
        issues.push(`Worker "${w.name}" 未声明 outputs 契约`);
      }
      const hardOutputs = (w.outputs ?? []).filter(o => o.contractLevel === "hard" || o.contractLevel === undefined);
      for (const o of hardOutputs) {
        if (!o.requiredFields || o.requiredFields.length === 0) {
          issues.push(`Worker "${w.name}" 的 hard 输出契约缺少 requiredFields（${o.path}）`);
        }
      }
    }
    return issues;
  }
}

/**
 * 校验 worker 输出：按契约检查 requiredFields 是否出现在输出文本中。
 * 硬性缺失 → 降级标记（degraded），不抛错不中断。
 */
export function validateWorkerOutput(
  worker: WorkerContract,
  outputText: string,
  outputPath?: string,
): WorkerOutputValidation {
  const missingHard: string[] = [];
  const missingSoft: string[] = [];

  for (const out of worker.outputs ?? []) {
    const fields = out.requiredFields ?? [];
    if (out.contractLevel === "soft") {
      missingSoft.push(...fields.filter(f => !outputText.includes(f)));
      continue;
    }
    // hard / structured（默认）都必须出现
    missingHard.push(...fields.filter(f => !outputText.includes(f)));
  }

  const degraded = missingHard.length > 0;
  return {
    workerName: worker.name,
    valid: missingHard.length === 0,
    missingHardFields: missingHard,
    missingSoftFields: missingSoft,
    degraded,
    degradationReason: degraded
      ? `硬性契约字段缺失: ${missingHard.join("、")}（输出 ${outputPath ?? "?"}）`
      : undefined,
  };
}

/** Worker 执行监控：记录执行记录并聚合统计。 */
export class WorkerMonitor {
  private readonly records: WorkerExecutionRecord[] = [];

  record(record: WorkerExecutionRecord): void {
    this.records.push(record);
  }

  /** 按 worker 聚合统计（成功率 / 违约计数 / P99 时延）。 */
  stats(): Record<string, { runs: number; successRate: number; degradedCount: number; p99Ms: number }> {
    const byWorker = new Map<string, WorkerExecutionRecord[]>();
    for (const r of this.records) {
      const list = byWorker.get(r.workerName) ?? [];
      list.push(r);
      byWorker.set(r.workerName, list);
    }
    const result: Record<string, { runs: number; successRate: number; degradedCount: number; p99Ms: number }> = {};
    for (const [name, list] of byWorker) {
      const runs = list.length;
      const ok = list.filter(r => r.outputValid).length;
      const degraded = list.filter(r => r.degraded).length;
      const sorted = list.map(r => r.durationMs).sort((a, b) => a - b);
      const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
      result[name] = { runs, successRate: ok / runs, degradedCount: degraded, p99Ms: p99 };
    }
    return result;
  }

  summary(): string {
    const st = this.stats();
    const lines = Object.entries(st).map(
      ([name, s]) =>
        `  ${name}: ${s.runs} 次, 成功率 ${Math.round(s.successRate * 100)}%, 降级 ${s.degradedCount} 次, P99 ${s.p99Ms}ms`,
    );
    return `Worker 执行监控 (${this.records.length} 条记录):\n${lines.join("\n")}`;
  }
}

/** 内置专利 worker 目录（移植 Mady DefaultWorkers 的专利相关条目，工具名适配 Sati）。 */
export function defaultPatentWorkers(): WorkerContract[] {
  return [
    {
      name: "patent-technical-analyzer",
      tier: "work",
      description: "分析技术交底书，提取技术三要素（问题/特征/效果）PFE 三元组",
      allowedTools: ["read_file", "web_fetch"],
      inputs: [{ path: "data/cases/{caseId}/disclosure/*.md", description: "技术交底书" }],
      outputs: [
        {
          path: "data/cases/{caseId}/outputs/technical-analysis.md",
          format: "markdown",
          contractLevel: "hard",
          requiredFields: ["技术问题", "技术特征", "技术效果"],
        },
      ],
      forbiddenActions: ["draft_claims", "draft_specification"],
      triggersHITL: false,
    },
    {
      name: "patent-search-commander",
      tier: "domain",
      description: "制定检索策略并执行专利检索，输出检索报告",
      allowedTools: ["web_search", "web_fetch", "patent_eval"],
      outputs: [
        {
          path: "data/cases/{caseId}/outputs/search-report.md",
          format: "markdown",
          contractLevel: "hard",
          requiredFields: ["检索式", "对比文件", "公开日"],
        },
      ],
      triggersHITL: false,
    },
    {
      name: "patent-novelty-analyzer",
      tier: "reasoning",
      description: "新颖性（A22.2）逐特征比对，输出结论与置信度",
      allowedTools: ["patent_eval", "read_file"],
      canInvoke: ["patent-search-commander", "patent-technical-analyzer"],
      outputs: [
        {
          path: "data/cases/{caseId}/outputs/novelty-analysis.md",
          format: "markdown",
          contractLevel: "hard",
          requiredFields: ["新颖性结论", "置信度"],
        },
      ],
      triggersHITL: true,
    },
    {
      name: "patent-inventiveness-analyzer",
      tier: "reasoning",
      description: "创造性（A22.3）三步法分析：最接近现有技术→区别技术特征→技术启示，输出结论与置信度",
      allowedTools: ["patent_eval", "read_file"],
      canInvoke: ["patent-search-commander", "patent-technical-analyzer"],
      outputs: [
        {
          path: "data/cases/{caseId}/outputs/inventiveness-analysis.md",
          format: "markdown",
          contractLevel: "hard",
          requiredFields: [
            "最接近的现有技术",
            "区别技术特征",
            "实际解决的技术问题",
            "技术启示",
            "创造性结论",
            "置信度",
          ],
        },
      ],
      triggersHITL: true,
    },
    {
      name: "patent-oa-writer",
      tier: "work",
      description: "审查意见答复：解析 OA、制定策略、撰写意见陈述书",
      allowedTools: ["read_file", "write_file", "patent_eval"],
      outputs: [
        {
          path: "data/cases/{caseId}/outputs/oa-response.md",
          format: "markdown",
          contractLevel: "hard",
          requiredFields: ["意见陈述", "修改对照"],
        },
      ],
      triggersHITL: true,
    },
    {
      name: "quality_checker",
      tier: "checker",
      description: "专利产出质量复核：patent_eval 预检 + 评分判定",
      allowedTools: ["patent_eval"],
      outputs: [
        {
          path: "data/cases/{caseId}/outputs/quality-report.md",
          format: "markdown",
          contractLevel: "hard",
          requiredFields: ["质量评分", "通过"],
        },
      ],
      triggersHITL: false,
    },
  ];
}
