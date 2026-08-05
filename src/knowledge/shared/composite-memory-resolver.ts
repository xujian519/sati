import type {
  MemoryCaptureTurnInput,
  MemoryDiagnostic,
  MemoryResolver,
  MemoryRetrieveInput,
  MemoryRetrieveResult,
} from "../../context/memory/MemoryResolver.js";

/**
 * CompositeMemoryResolver — 组合多个 MemoryResolver。
 *
 * retrieve 并发调用所有子 resolver，拼接 systemContext（XML 块），
 * 聚合 diagnostics；单个子 resolver 失败不影响其他（catch 降级）。
 * captureTurn 广播到所有子 resolver（逐个 await，失败降级）。
 */

export type CompositeMemoryResolverOptions = {
  /** 捕获/检索降级日志（可选；不传则静默降级）。 */
  logger?: { warn?: (...args: unknown[]) => void };
};

export class CompositeMemoryResolver implements MemoryResolver {
  private readonly resolvers: MemoryResolver[];
  private readonly logger?: { warn?: (...args: unknown[]) => void };

  constructor(resolvers: MemoryResolver[], options: CompositeMemoryResolverOptions = {}) {
    this.resolvers = resolvers;
    this.logger = options.logger;
  }

  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult> {
    const results = await Promise.all(
      this.resolvers.map(resolver =>
        resolver.retrieve(input).catch((error: unknown) => ({
          systemContext: undefined,
          diagnostics: [
            {
              code: "memory_provider_error" as const,
              message: `knowledge resolver failed: ${error instanceof Error ? error.message : String(error)}`,
              severity: "warning" as const,
            },
          ],
        })),
      ),
    );

    const contexts = results
      .map(r => r.systemContext)
      .filter((ctx): ctx is string => typeof ctx === "string" && ctx.trim().length > 0);
    const diagnostics: MemoryDiagnostic[] = results.flatMap(r => r.diagnostics);

    return {
      systemContext: contexts.length > 0 ? contexts.join("\n\n") : undefined,
      diagnostics,
    };
  }

  async captureTurn(input: MemoryCaptureTurnInput): Promise<void> {
    for (const resolver of this.resolvers) {
      try {
        await resolver.captureTurn(input);
      } catch (error) {
        // 记忆捕获失败不阻断主流程，但需可观测（此前静默吞掉）
        this.logger?.warn?.(
          `[composite-memory] captureTurn 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
