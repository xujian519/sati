/**
 * 依赖环检测（质量审阅 I3）：为「新增任务」在既有任务图上检测依赖成环。
 *
 * 图论事实：create_task 的依赖只能指向既有任务，而既有任务在各自 create 时已通过
 * 本检测（同一归纳过程）——因此当前运行期新增边必然不成环（环需要一条从直接依赖
 * 回到新增任务自身的传递路径，而新增任务不在既有图中）。本检测是防御性纯函数：
 * 一旦依赖关系未来支持可变（update dependencies）或数据被外部导入，它立即成为
 * 唯一防线；对既有环（历史脏数据）不误报——仅报告包含新增任务的环。
 */
export type TaskDependencyRow = { id: string; dependencies: readonly string[] };

export type DependencyCycle = readonly string[];

export function detectDependencyCycle(
  existing: readonly TaskDependencyRow[],
  newTaskId: string,
  newDependencies: readonly string[],
): DependencyCycle | undefined {
  const depsOf = new Map<string, string[]>();
  for (const task of existing) {
    depsOf.set(task.id, [...task.dependencies]);
  }
  depsOf.set(newTaskId, [...newDependencies]);
  // 从新增任务的每个直接依赖沿依赖链 DFS：可达 newTaskId 即成环（返回路径，供错误消息）。
  // inPath 防重（既有环不误报：命中在路径上的节点即既有环，不属于本次新增引入）。
  const inPath = new Set<string>();
  const dfs = (id: string): DependencyCycle | undefined => {
    if (id === newTaskId) return [newTaskId];
    if (inPath.has(id)) return undefined;
    inPath.add(id);
    for (const dep of depsOf.get(id) ?? []) {
      const cycle = dfs(dep);
      if (cycle !== undefined) return [id, ...cycle];
    }
    inPath.delete(id);
    return undefined;
  };
  for (const dep of newDependencies) {
    const cycle = dfs(dep);
    // 返回完整闭环（起点 = 新任务，经直接依赖回到新任务），错误消息可直接表达 t4 → t2 → t4。
    if (cycle !== undefined) return [newTaskId, ...cycle];
  }
  return undefined;
}
