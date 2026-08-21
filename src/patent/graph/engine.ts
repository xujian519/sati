/**
 * src/patent/graph — SuperStep 执行引擎（移植自 Mady graph/pregel.go + graph/graph.go）。
 *
 * 执行模型（BSP 批量同步并行）：
 *   1. 并行执行当前超步所有 active 节点（Promise.all），每节点收到 state 深拷贝快照；
 *   2. 节点失败：failFast=true 立即终止；否则写入节点级降级标记（_graph_error）继续；
 *   3. 节点增量按 Reducer + 节点名字典序确定性合并回共享 state；
 *   4. 计算下一超步 active：静态边目标 ∪ 条件边 router 返回；任一含 GRAPH_END 即终止；
 *   5. 去重后进入下一轮；maxSteps（默认 100）防死循环。
 *
 * 无拓扑排序、无环检测：允许条件边形成受控循环（一致性回退、ReAct 循环）。
 * 中断（GraphInterruptError，如审批门）：引擎捕获后暂停返回，completed=false。
 */

import type {
  EdgeRouter,
  GraphCheckpoint,
  GraphNode,
  GraphRunResult,
  GraphState,
  NodeDuration,
  NodePolicy,
  Reducer,
  RunOptions,
  StateDelta,
} from "./types.js";
import { GRAPH_END, GraphEngineError, GraphInterruptError, isGraphInterruptError } from "./types.js";
import { cloneState } from "./state.js";
import { DEGRADATION_SUFFIX, degradationSummary } from "./degradation.js";
import { mergeWithSchema, type MergeSchema } from "./merge.js";
import { runNodeWithPolicy } from "./node-policy.js";

/** 编译快照（不可变）。 */
export type CompiledGraphDef = {
  nodes: Map<string, GraphNode>;
  edges: Map<string, string[]>;
  conditionalEdges: Map<string, EdgeRouter>;
  nodePolicies: Map<string, NodePolicy>;
  schema: MergeSchema;
  entry: string;
  maxSteps: number;
};

/** 链式图构建 API（对齐 Mady PregelGraph）。 */
export type GraphBuilderOptions = {
  /**
   * 节点注册统一入口钩子（溯源包装用）：每次 addNode 注册前调用，
   * 返回包装后的节点（含裸箭头函数节点，评审 P9）；缺省原样注册。
   */
  onAddNode?: (name: string, node: GraphNode) => GraphNode;
};

export class GraphBuilder {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, string[]>();
  private readonly conditionalEdges = new Map<string, EdgeRouter>();
  private readonly nodePolicies = new Map<string, NodePolicy>();
  private schema: MergeSchema = {};
  private readonly onAddNode?: (name: string, node: GraphNode) => GraphNode;

  constructor(options?: GraphBuilderOptions) {
    this.onAddNode = options?.onAddNode;
  }

  /** 注册节点（GRAPH_END 为保留哨兵，不可注册）。 */
  addNode(name: string, node: GraphNode): this {
    if (name === GRAPH_END) throw new GraphEngineError(`"${GRAPH_END}" 为保留哨兵，不可注册为节点`);
    if (!name.trim()) throw new GraphEngineError("节点名不能为空");
    const effective = this.onAddNode?.(name, node) ?? node;
    this.nodes.set(name, effective);
    return this;
  }

  /** 静态边：from → to（to 可为 GRAPH_END）。 */
  addEdge(from: string, to: string): this {
    this.assertNode(from);
    const targets = this.edges.get(from) ?? [];
    if (!targets.includes(to)) targets.push(to);
    this.edges.set(from, targets);
    return this;
  }

  /** 条件边：运行时 router 决定目标节点列表（与静态边叠加；实践上二选一）。 */
  setConditionalEdge(from: string, router: EdgeRouter): this {
    this.assertNode(from);
    this.conditionalEdges.set(from, router);
    return this;
  }

  /** 节点策略（重试/超时/副作用）；编译时快照。 */
  setNodePolicy(name: string, policy: NodePolicy): this {
    this.assertNode(name);
    this.nodePolicies.set(name, { ...policy });
    return this;
  }

  /** 合并 schema：key → Reducer（多次调用叠加）。 */
  setSchema(entries: Record<string, Reducer>): this {
    this.schema = { ...this.schema, ...entries };
    return this;
  }

  /** 编译为不可变可执行图。 */
  compile(entry: string, maxSteps = 100): CompiledGraph {
    this.assertNode(entry);
    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
      throw new GraphEngineError("maxSteps 必须为正整数");
    }
    // 静态边目标校验：拼错的节点名在构建期暴露，而非运行时静默降级。
    for (const [from, targets] of this.edges) {
      for (const to of targets) {
        if (to !== GRAPH_END && !this.nodes.has(to)) {
          throw new GraphEngineError(`边 "${from}" → "${to}" 指向未注册节点（${GRAPH_END} 除外）`);
        }
      }
    }
    return new CompiledGraph({
      nodes: new Map(this.nodes),
      edges: new Map([...this.edges].map(([k, v]) => [k, [...v]])),
      conditionalEdges: new Map(this.conditionalEdges),
      nodePolicies: new Map(this.nodePolicies),
      schema: { ...this.schema },
      entry,
      maxSteps,
    });
  }

  private assertNode(name: string): void {
    if (!this.nodes.has(name)) throw new GraphEngineError(`节点 "${name}" 未注册`);
  }
}

/** 可执行图（编译后不可变）。 */
export class CompiledGraph {
  constructor(private readonly def: CompiledGraphDef) {}

  /** 从入口节点运行。 */
  run(initial: GraphState, opts: RunOptions = {}): Promise<GraphRunResult> {
    return runSuperSteps(this.def, initial, opts);
  }

  /** 从检查点恢复（从 checkpoint.activeNodes 继续，超步序号续接）。 */
  resume(checkpoint: GraphCheckpoint, opts: RunOptions = {}): Promise<GraphRunResult> {
    return runSuperSteps(this.def, {}, opts, {
      state: checkpoint.state,
      active: checkpoint.activeNodes,
      stepIndex: checkpoint.stepIndex,
    });
  }

  /** 图元数据（诊断/可视化用）。 */
  describe(): { entry: string; maxSteps: number; nodes: string[]; edges: [string, string[]][] } {
    return {
      entry: this.def.entry,
      maxSteps: this.def.maxSteps,
      nodes: [...this.def.nodes.keys()],
      edges: [...this.def.edges].map(([from, to]) => [from, [...to]]),
    };
  }
}

/** 单节点执行结果打包（含节点名）。 */
type NamedOutcome = { name: string; delta: StateDelta } | { name: string; error: unknown };

/** 恢复起点（resume 用）：state + active + 超步序号。 */
export type ResumePoint = { state: GraphState; active: string[]; stepIndex: number };

/** 节点耗时按节点名排序（确定性输出；纯字节序，不依赖运行环境 locale）。 */
function sortedNodeDurations(durations: NodeDuration[]): NodeDuration[] {
  return [...durations].sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
}

/** SuperStep 主循环（resumeFrom 提供时从指定超步继续）。 */
async function runSuperSteps(
  def: CompiledGraphDef,
  initial: GraphState,
  opts: RunOptions,
  resumeFrom?: ResumePoint,
): Promise<GraphRunResult> {
  const state = cloneState(resumeFrom?.state ?? initial);
  let active: string[] = resumeFrom?.active ?? [def.entry];
  let steps = resumeFrom?.stepIndex ?? 0;
  let completed = false;
  let interrupted: GraphRunResult["interrupted"];
  const durations: NodeDuration[] = [];

  for (let step = steps; step < def.maxSteps; step += 1) {
    steps = step;
    if (active.length === 0) {
      completed = true;
      break;
    }
    await opts.onSuperStepStart?.(step, active, state);

    const snapshot = cloneState(state);
    const outcomes = await Promise.all(
      active.map(async name => {
        const startedAt = Date.now();
        try {
          const node = def.nodes.get(name);
          if (node === undefined) {
            return { name, error: new GraphEngineError(`节点 "${name}" 未注册（图定义不一致）`) } as NamedOutcome;
          }
          const policy = def.nodePolicies.get(name);
          try {
            const outcome = await runNodeWithPolicy(node, policy, { state: snapshot, provider: opts.provider });
            return outcome.ok
              ? ({ name, delta: outcome.delta } as NamedOutcome)
              : ({ name, error: outcome.error } as NamedOutcome);
          } catch (err) {
            // runNodeWithPolicy 不抛普通错误；中断错误穿透至此。
            return { name, error: err } as NamedOutcome;
          }
        } finally {
          durations.push({ node: name, durationMs: Date.now() - startedAt });
        }
      }),
    );
    steps = step + 1;

    // 中断（审批门等）：立即暂停，不执行后续超步。
    for (const outcome of outcomes) {
      if ("error" in outcome && isGraphInterruptError(outcome.error)) {
        const interrupt = outcome.error as GraphInterruptError;
        interrupted = { node: outcome.name, message: interrupt.message, data: interrupt.data };
        return {
          state,
          completed: false,
          steps,
          degraded: degradationSummary(state),
          interrupted,
          nodeDurations: sortedNodeDurations(durations),
        };
      }
    }

    // 失败处理：failFast 终止 / 否则节点级降级标记。
    const results: Array<{ node: string; delta: StateDelta }> = [];
    let failed = false;
    for (const outcome of outcomes) {
      if ("delta" in outcome) {
        results.push({ node: outcome.name, delta: outcome.delta });
      } else if (opts.failFast) {
        failed = true;
        break;
      } else {
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        state[`${outcome.name}${DEGRADATION_SUFFIX}`] = {
          reason: "node_failed",
          message,
          severity: "critical",
        };
      }
    }
    if (failed) {
      return {
        state,
        completed: false,
        steps,
        degraded: degradationSummary(state),
        nodeDurations: sortedNodeDurations(durations),
      };
    }

    // 确定性合并（Reducer + 节点名字典序）。
    mergeWithSchema(state, results, def.schema);

    // 计算下一超步 active。
    const next = new Set<string>();
    let sawEnd = false;
    for (const name of active) {
      for (const target of def.edges.get(name) ?? []) {
        if (target === GRAPH_END) sawEnd = true;
        else next.add(target);
      }
      const router = def.conditionalEdges.get(name);
      if (router !== undefined) {
        const targets = await router(state);
        for (const target of targets) {
          if (target === GRAPH_END) sawEnd = true;
          else next.add(target);
        }
      }
    }
    if (sawEnd) {
      completed = true;
      break;
    }
    active = [...next];
  }

  // 循环因 maxSteps 耗尽退出（active 非空）→ 未正常完成（护栏触发）。
  if (!completed && active.length > 0) {
    return {
      state,
      completed: false,
      steps,
      degraded: degradationSummary(state),
      nodeDurations: sortedNodeDurations(durations),
    };
  }
  return {
    state,
    completed,
    steps,
    degraded: degradationSummary(state),
    nodeDurations: sortedNodeDurations(durations),
  };
}
