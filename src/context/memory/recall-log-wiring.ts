/**
 * 召回日志运行期接线（WS1）：承载 DefaultContextRuntime 侧的日志动作，
 * 使宿主文件保持零净增长（架构棘轮）。职责：
 *
 *  - prepareForModel 注入/预算 deferred 两条路径的记录（builder 内部的
 *    注入/空/超时/取消路径由 MemoryAttachmentBuilder 自己记录）；
 *  - captureTurn 收尾的保守引用回填（宁可漏标不可瞎标）。
 *
 * 全部动作 best-effort：任何失败都不打断 agent turn（fail-open 语义由
 * FileRecallLogSink 承载，降级注册表 memory-recall-log-db 条目登记）。
 */

import type { CanonicalMessage } from "../../model/index.js";
import type { MemoryHit } from "./MemoryResolver.js";
import { collectAssistantText, matchCitedHits } from "./recall-log.js";
import type { RecallLogSink } from "./recall-log.js";

export type { RecallLogSink } from "./recall-log.js";

export class RecallLogWiring {
  private readonly injectedHitsBySession = new Map<string, MemoryHit[]>();

  constructor(private readonly sink: RecallLogSink) {}

  /** 检索完成（预算内）：记录本轮结构化命中，供引用判定使用。 */
  noteInjected(sessionId: string, hits: MemoryHit[]): void {
    this.injectedHitsBySession.set(sessionId, hits);
  }

  /** 预算到期 deferred：builder 尚未结算，由 runtime 侧补记（不重复记 timeout）。 */
  recordDeferred(input: { sessionId: string; turnId: string; query: string }): void {
    try {
      this.sink.log({ ...input, hits: undefined, injected: false, skipReason: "deferred" });
    } catch {
      // 可观测旁路失败不阻断装配（fail-open）。
    }
  }

  /** turn 收尾：assistant 输出命中最近注入条目 → 回填引用；失败不抛。 */
  cite(input: { sessionId: string; messages: CanonicalMessage[] }): void {
    try {
      const hits = this.injectedHitsBySession.get(input.sessionId);
      if (!hits || hits.length === 0) return;
      const citedIds = matchCitedHits(collectAssistantText(input.messages), hits);
      if (citedIds.length > 0) {
        this.sink.cite({ sessionId: input.sessionId, citedIds });
      }
    } catch {
      // 引用回填是 best-effort 旁路：失败由 sink 的降级 warn 承载。
    }
  }
}
