/**
 * FlowGraph + DagExecutor — DAG topology utilities for workflow plans.
 *
 * Adapted from XiaoNuo Agent's `dag-engine.ts`. The workflow engine itself
 * computes readiness from `dependsOn`; this module offers explicit graph
 * construction, cycle detection, topological layering, and a wave-parallel
 * executor for callers that want direct graph control.
 */

export type FlowNodeType = "agent" | "tool" | "quality-check" | "human-approval" | "code" | "sub-workflow";

export type FlowNode = {
  id: string;
  type: FlowNodeType;
  name: string;
};

export type FlowEdge = {
  from: string;
  to: string;
};

export class FlowGraph {
  private readonly nodes = new Map<string, FlowNode>();
  private readonly edges: FlowEdge[] = [];

  addNode(node: FlowNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: FlowEdge): void {
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) {
      throw new Error(`FlowGraph: edge ${edge.from} -> ${edge.to} references an unknown node`);
    }
    this.edges.push(edge);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  outgoing(nodeId: string): FlowEdge[] {
    return this.edges.filter(edge => edge.from === nodeId);
  }

  incoming(nodeId: string): FlowEdge[] {
    return this.edges.filter(edge => edge.to === nodeId);
  }

  /** Returns the cycle path (ids) if a cycle exists, else null. */
  detectCycle(): string[] | null {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];
    const visit = (id: string): string[] | null => {
      if (visiting.has(id)) {
        const start = stack.indexOf(id);
        return [...stack.slice(start), id];
      }
      if (visited.has(id)) return null;
      visiting.add(id);
      stack.push(id);
      for (const edge of this.outgoing(id)) {
        const cycle = visit(edge.to);
        if (cycle) return cycle;
      }
      stack.pop();
      visiting.delete(id);
      visited.add(id);
      return null;
    };
    for (const id of this.nodes.keys()) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
    return null;
  }

  /** Kahn's algorithm — returns node ids grouped by topological level. */
  topologicalLevels(): string[][] {
    const indegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    for (const id of this.nodes.keys()) {
      indegree.set(id, 0);
      outgoing.set(id, []);
    }
    for (const edge of this.edges) {
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
      outgoing.get(edge.from)?.push(edge.to);
    }
    const levels: string[][] = [];
    let frontier = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
    while (frontier.length > 0) {
      levels.push(frontier);
      const next: string[] = [];
      for (const id of frontier) {
        for (const to of outgoing.get(id) ?? []) {
          const degree = (indegree.get(to) ?? 1) - 1;
          indegree.set(to, degree);
          if (degree === 0) next.push(to);
        }
      }
      frontier = next;
    }
    const scheduled = levels.flat().length;
    if (scheduled !== this.nodes.size) {
      throw new Error(`FlowGraph: cycle detected — ${this.nodes.size - scheduled} nodes unschedulable`);
    }
    return levels;
  }

  /** Cycle + orphan checks; returns a list of problems (empty when valid). */
  validate(): string[] {
    const problems: string[] = [];
    const cycle = this.detectCycle();
    if (cycle) problems.push(`Cycle: ${cycle.join(" -> ")}`);
    for (const node of this.nodes.values()) {
      const incoming = this.incoming(node.id);
      const outgoing = this.outgoing(node.id);
      if (incoming.length === 0 && outgoing.length === 0 && this.nodes.size > 1) {
        problems.push(`Orphan node: ${node.id}`);
      }
    }
    return problems;
  }

  formatMermaid(): string {
    const lines = ["flowchart TD"];
    for (const node of this.nodes.values()) {
      lines.push(`  ${node.id}["${node.name}"]`);
    }
    for (const edge of this.edges) {
      lines.push(`  ${edge.from} --> ${edge.to}`);
    }
    return lines.join("\n");
  }
}

export type DagExecutorOptions = {
  /** Maximum steps executing concurrently per wave. */
  maxParallel?: number;
};

export type DagExecutionResult = {
  completed: string[];
  failed: string[];
  durationMs: number;
};

/**
 * Wave-parallel executor: runs nodes level by level (topological order),
 * executing each level's nodes concurrently, bounded by `maxParallel`.
 */
export class DagExecutor {
  constructor(
    private readonly graph: FlowGraph,
    private readonly options: DagExecutorOptions = {},
  ) {}

  async execute(
    executeNode: (nodeId: string) => Promise<void>,
    onNodeComplete?: (nodeId: string) => void,
  ): Promise<DagExecutionResult> {
    const startedAt = Date.now();
    const levels = this.graph.topologicalLevels();
    const maxParallel = this.options.maxParallel ?? levels[0]?.length ?? 1;
    const completed: string[] = [];
    const failed: string[] = [];

    for (const level of levels) {
      const queue = [...level];
      let cursor = 0;
      const workers = Array.from({ length: Math.min(maxParallel, queue.length) }, async () => {
        while (cursor < queue.length) {
          const nodeId = queue[cursor++]!;
          try {
            await executeNode(nodeId);
            completed.push(nodeId);
            onNodeComplete?.(nodeId);
          } catch {
            // 失败→计入 failed 列表继续后续层（fail-open 收集，不中断整体执行；
            // 错误对象按本执行器契约不上抛，由调用方按 nodeId 维度处理）。
            failed.push(nodeId);
          }
        }
      });
      await Promise.all(workers);
    }
    return { completed, failed, durationMs: Date.now() - startedAt };
  }
}
