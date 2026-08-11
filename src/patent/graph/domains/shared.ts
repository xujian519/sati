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
};

export function llmNode({ outputKey, buildPrompt, schema, temperature = 0.2 }: LlmNodeOptions): GraphNode {
  return async ({ state, provider }) => {
    if (!provider?.callLLM) {
      const delta: StateDelta = {};
      markDegraded(delta, outputKey, "", "llm_unavailable", `${outputKey} 需要 LLM（provider.callLLM 缺失）`);
      return delta;
    }
    const prompt = buildPrompt(state);
    try {
      const raw = await provider.callLLM(prompt, {
        ...(schema !== undefined ? { jsonSchema: schema } : {}),
        temperature,
      });
      return { [outputKey]: raw };
    } catch (err) {
      const delta: StateDelta = {};
      markDegraded(
        delta,
        outputKey,
        "",
        "llm_unavailable",
        `${outputKey} LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return delta;
    }
  };
}

/** 规则门收口节点：汇总 state 文本 → checker RuleEngine 按域评估 → verdict 写入 state。 */
export function ruleGateNode(domains: readonly string[]): GraphNode {
  return async ({ state }) => {
    const text = collectStateText(state);
    const engine = new RuleEngine();
    engine.registerMany(defaultPatentRules());
    const failures = engine.evaluate(text, { domain: domains });
    const verdict = aggregate(failures);
    return {
      rule_gate_verdict: verdict,
      rule_gate_domains: [...domains],
      rule_gate_failures: failures.map(f => f.ruleId),
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
