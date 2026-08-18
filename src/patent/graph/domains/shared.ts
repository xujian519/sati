/**
 * src/patent/graph/domains — 三性领域子图公共设施。
 *
 * - handlerNode：现有 StageHandler → 图节点（可注入固定 params）；
 * - llmNode：通用 LLM 节点工厂（JSON schema + 降级标记，复用 atoms llm 语义）；
 * - ruleGateNode：确定性规则门收口节点（复用 checker RuleEngine + aggregate）；
 * - collectStateText：汇总 state 文本供规则门评估。
 */

import type { GraphNode, GraphState, StateDelta } from "../types.js";
import { markDegraded } from "../degradation.js";
import { runStageHandler } from "../adapter.js";
import type { StageHandler } from "../../atoms/index.js";
import { RuleEngine, aggregate, defaultPatentRules, type Verdict } from "../../checker/index.js";
import type { RuleCheckResult } from "../../checker/types.js";
import { tryParseJson } from "../../llm-json.js";

/** 现有 StageHandler → 图节点（注入固定 params，合并进执行态，不污染共享 state）。 */
export function handlerNode(handler: StageHandler, params?: Record<string, unknown>): GraphNode {
  return async ({ state, provider }) => {
    const execState = params !== undefined ? { ...state, ...params } : state;
    return runStageHandler(handler, execState, provider);
  };
}

/** LLM 节点工厂：JSON schema 结构化输出，LLM 缺失/失败 → markDegraded（不中断全图）。 */
export type LlmNodeOptions = {
  outputKey: string;
  buildPrompt: (state: GraphState) => string;
  schema?: unknown;
  temperature?: number;
  /** 最大尝试次数（缺省 1 = 不重试，保持旧行为）。瞬时错误/JSON 校验失败会重试。 */
  maxAttempts?: number;
  /** 单次调用超时（毫秒，缺省 0 = 不超时）。经 Promise.race 实现，不扩展 callLLM 接口。 */
  timeoutMs?: number;
  /** 模型分层标识（如 "cheap"/"strong"），透传 callLLM 的 modelHint；宿主未配置映射时忽略。 */
  modelHint?: string;
};

/** 单次调用超时包装：超时 reject，返回前清理 timer（不阻塞事件循环）。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 调用超时（${timeoutMs}ms）`)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 结构化输出校验：文本可 JSON.parse 且 schema.required 字段全部存在（无 required 声明 = 不校验）。 */
function validateStructuredOutput(raw: string, schema: unknown): boolean {
  const parsed = tryParseJson(raw);
  if (parsed === undefined) return false;
  const required = (schema as { required?: unknown } | undefined)?.required;
  if (!Array.isArray(required)) return true;
  return required.every(key => typeof key === "string" && parsed[key] !== undefined);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function llmNode({
  outputKey,
  buildPrompt,
  schema,
  temperature = 0.2,
  maxAttempts = 1,
  timeoutMs = 0,
  modelHint,
}: LlmNodeOptions): GraphNode {
  return async ({ state, provider }) => {
    if (!provider?.callLLM) {
      const delta: StateDelta = {};
      markDegraded(delta, outputKey, "", "llm_unavailable", `${outputKey} 需要 LLM（provider.callLLM 缺失）`);
      return delta;
    }
    const prompt = buildPrompt(state);
    const attempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(100 * 2 ** (attempt - 1)); // 指数退避 100ms × 2^attempt
      try {
        const raw = await withTimeout(
          provider.callLLM(prompt, {
            ...(schema !== undefined ? { jsonSchema: schema } : {}),
            temperature,
            ...(modelHint !== undefined ? { modelHint } : {}),
          }),
          timeoutMs,
          outputKey,
        );
        if (schema !== undefined && !validateStructuredOutput(raw, schema)) {
          lastError = new Error("结构化输出 JSON 校验失败（非 JSON 或缺少 required 字段）");
          continue;
        }
        return { [outputKey]: raw };
      } catch (err) {
        lastError = err;
      }
    }
    const delta: StateDelta = {};
    markDegraded(
      delta,
      outputKey,
      "",
      "llm_unavailable",
      `${outputKey} LLM 调用失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    return delta;
  };
}

/**
 * 规则门收口节点：汇总 state 文本 → checker RuleEngine 按域评估 → verdict 写入 state。
 * precomputedFailures：预先计算的失败列表（如 citation_gate 的未接地引用），缺省空数组
 * （novelty/enablement 不传时行为不变）。合并规则：既有 blocked 保持 blocked；既有
 * needs_revision 保持；既有 pass 且存在预计算失败 → needs_revision；无预计算失败不影响原判级。
 */
export function ruleGateNode(domains: readonly string[], precomputedFailures: string[] = []): GraphNode {
  return async ({ state }) => {
    const text = collectStateText(state);
    const engine = new RuleEngine();
    engine.registerMany(defaultPatentRules());
    const failures = engine.evaluate(text, { domain: domains });
    const verdict = aggregate(failures);
    const ruleFailures = failures.map(f => f.ruleId);
    let finalVerdict = verdict;
    if (precomputedFailures.length > 0 && verdict !== "blocked" && verdict !== "needs_revision") {
      finalVerdict = "needs_revision";
    }
    return {
      rule_gate_verdict: finalVerdict,
      rule_gate_domains: [...domains],
      rule_gate_failures: [...new Set([...ruleFailures, ...precomputedFailures])],
      rule_gate_text_length: text.length,
    };
  };
}

export type RuleGateState = {
  verdict: Verdict;
  failures: RuleCheckResult[];
};

/** 汇总 state 中的业务文本（跳过元数据键：_ 前缀 / __degradation 后缀 / 内部键）。 */
export function collectStateText(state: GraphState): string {
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith("_")) continue;
    if (key.endsWith("__degradation")) continue;
    if (key === "rule_gate_verdict" || key === "rule_gate_domains" || key === "rule_gate_failures") continue;
    if (typeof value === "string" && value.trim().length > 0) {
      blocks.push(`## ${key}\n${value}`);
    } else if (Array.isArray(value) && value.length > 0) {
      blocks.push(`## ${key}\n${JSON.stringify(value, null, 2)}`);
    }
  }
  return blocks.join("\n\n");
}

/** 通用：从 state 读取输入文本（对齐 workflowCtx 映射的多键回退）。 */
export function resolveInput(state: GraphState, keys: string[]): string {
  for (const key of keys) {
    const value = state[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}
