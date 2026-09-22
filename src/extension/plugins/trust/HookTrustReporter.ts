/**
 * 项目级 hook 信任的装配期上报（1.2a 报告期 → 1.2b 强制期）。
 *
 * 每个工作区只在**报告内容变化时**输出一次：信任评估发生在会话装配点，同一份声明
 * 会被每个新会话重新评估一次，逐会话重复同一行会把它变成没人看的噪音。
 * 遥测与日志共用这一次变化判定（同一份信号，不重复判两次）。
 */
import { logger, type Logger, type TelemetryClient } from "../../../telemetry/index.js";
import type { HookTrustEntry, HookTrustEvaluation, HookTrustStatus } from "./protocol.js";

export class HookTrustReporter {
  private readonly lastSignature = new Map<string, string>();

  constructor(
    private readonly log: Logger = logger,
    private readonly telemetry?: TelemetryClient,
  ) {}

  /** 报告一次；与上次报告内容相同则跳过并返回 false。 */
  report(evaluation: HookTrustEvaluation): boolean {
    const signature = signatureOf(evaluation.entries);
    const previous = this.lastSignature.get(evaluation.workspaceIdentityKey);
    this.lastSignature.set(evaluation.workspaceIdentityKey, signature);
    if (previous === signature) return false;
    if (evaluation.entries.length === 0) return false;

    const workspace = evaluation.workspaceIdentityKey.slice(0, 12);
    const unreviewed = evaluation.entries.filter(entry => entry.status !== "trusted");
    this.reportTelemetry(evaluation.entries, unreviewed.length);
    if (unreviewed.length === 0) {
      this.log.info(`Hook trust: workspace=${workspace} projectPlugins=${evaluation.entries.length} all reviewed`);
      return true;
    }
    const summary = unreviewed.map(entry => `${entry.pluginName}=${entry.status}`).join(", ");
    this.log.warn(
      `Hook trust: workspace=${workspace} projectPlugins=${evaluation.entries.length} ` +
        `disabled=${unreviewed.length} [${summary}] — unreviewed project hooks are not loaded; ` +
        "review them with `sati hooks list` (or the hook-trust panel) to enable.",
    );
    return true;
  }

  /**
   * 只上计数（总数、被挡住的数量、按状态分布）：工作区身份键是 canonical 路径的
   * sha256，路径空间可穷举、摘要等同于弱化路径；插件名、命令与目录都属用户内容。
   * 三者都不出本机（`sourcePath` 注释同此纪律）。
   */
  private reportTelemetry(entries: HookTrustEntry[], disabled: number): void {
    const counts: Record<HookTrustStatus, number> = { trusted: 0, pending: 0, stale: 0, revoked: 0, blocked: 0 };
    for (const entry of entries) counts[entry.status] += 1;
    this.telemetry?.trackFeatureLoopStage({
      module: "session",
      phase: "hook_trust",
      loopStage: "module_event",
      outcome: disabled > 0 ? "denied" : "success",
      metadata: { projectPlugins: entries.length, disabled, ...counts },
    });
  }
}

function signatureOf(entries: HookTrustEntry[]): string {
  return entries.map(entry => `${entry.pluginId}:${entry.status}:${entry.digest ?? "-"}`).join("|");
}
