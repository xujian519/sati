/**
 * 项目级 hook 信任的装配期上报（1.2a：只报告，不阻断）。
 *
 * 每个工作区只在**报告内容变化时**输出一次：信任评估发生在会话装配点，同一份声明
 * 会被每个新会话重新评估一次，逐会话重复同一行会把它变成没人看的噪音。
 */
import { logger, type Logger } from "../../../telemetry/index.js";
import type { HookTrustEntry, HookTrustEvaluation } from "./protocol.js";

export class HookTrustReporter {
  private readonly lastSignature = new Map<string, string>();

  constructor(private readonly log: Logger = logger) {}

  /** 报告一次；与上次报告内容相同则跳过并返回 false。 */
  report(evaluation: HookTrustEvaluation): boolean {
    const signature = signatureOf(evaluation.entries);
    const previous = this.lastSignature.get(evaluation.workspaceIdentityKey);
    this.lastSignature.set(evaluation.workspaceIdentityKey, signature);
    if (previous === signature) return false;
    if (evaluation.entries.length === 0) return false;

    const workspace = evaluation.workspaceIdentityKey.slice(0, 12);
    const unreviewed = evaluation.entries.filter(entry => entry.status !== "trusted");
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
}

function signatureOf(entries: HookTrustEntry[]): string {
  return entries.map(entry => `${entry.pluginId}:${entry.status}:${entry.digest ?? "-"}`).join("|");
}
