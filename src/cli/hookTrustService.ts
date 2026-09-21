/**
 * 项目级 hook 信任的服务面（协议 1.11 与 CLI 共用）。
 *
 * 与报告期共用同一套评估与存储：`list` = 评估结果 + 声明投影；`decide` = 以
 * **当前内容摘要**写入授权（或撤销记录）。授权对象是内容摘要而非路径：声明或目录内
 * 任何文件事后被改，该授权自动作废（`stale`）并须重新评审。
 */
import type {
  GatewayHookTrustDecideInput,
  GatewayHookTrustDecideResult,
  GatewayHookTrustEntry,
  GatewayHookTrustListInput,
  GatewayHookTrustListResult,
} from "../gateway/protocol/types.js";
import { logger, type TelemetryClient } from "../telemetry/index.js";
import type { PluginRuntime } from "../extension/plugins/runtime/PluginRuntime.js";
import type { SatiLoadedPlugin } from "../extension/plugins/protocol/plugin.js";
import {
  computeHookBundleDigest,
  computeWorkspaceIdentityKey,
  evaluateProjectHookTrust,
  HookTrustStore,
  summarizeHookDeclarations,
  type HookTrustEntry,
  type HookTrustStatus,
} from "../extension/plugins/trust/index.js";

export type HookTrustService = {
  list(input: GatewayHookTrustListInput): Promise<GatewayHookTrustListResult>;
  decide(input: GatewayHookTrustDecideInput): Promise<GatewayHookTrustDecideResult>;
};

export function createHookTrustService(deps: {
  /** 项目键 → 该项目的插件运行时与根目录（`ProjectRuntimeRegistry.resolve`）。 */
  resolveProject: (projectKey: string) => { projectRoot: string; pluginRuntime: PluginRuntime };
  store: HookTrustStore;
  /**
   * 决策遥测。可选：`sati hooks approve|revoke` 是一次性进程、无常驻 flush 时机，
   * 只有 gateway 侧（`createLocalGateway` 注入的常驻 collector）上报；
   * 决策本身已持久化在信任存储里，CLI 路径不因缺遥测而丢事实。
   */
  telemetry?: TelemetryClient;
}): HookTrustService {
  async function evaluate(projectKey: string) {
    const project = deps.resolveProject(projectKey);
    await project.pluginRuntime.refresh();
    const plugins = project.pluginRuntime.snapshotContributions().plugins;
    const workspaceIdentityKey = await computeWorkspaceIdentityKey(project.projectRoot);
    const evaluation = await evaluateProjectHookTrust({
      plugins,
      workspaceIdentityKey,
      trustFile: deps.store.read(),
    });
    return { workspaceIdentityKey, plugins, evaluation };
  }

  function toEntry(entry: HookTrustEntry, plugins: SatiLoadedPlugin[]): GatewayHookTrustEntry {
    const plugin = plugins.find(candidate => `${candidate.name}@${candidate.source}` === entry.pluginId);
    return {
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      pluginRoot: plugin?.path ?? "",
      status: entry.status,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      ...(entry.digest === undefined ? {} : { digest: entry.digest }),
      hooks: plugin ? summarizeHookDeclarations(plugin) : [],
    };
  }

  /**
   * 决策遥测：`verdict` 区分「授权」与「撤销」，`applied=false` 时 `reason` 说明
   * 授权失败（它不是撤销，混在一起会让撤销率变成噪声）。插件名/路径/命令不上报。
   */
  function reportDecision(input: {
    verdict: GatewayHookTrustDecideInput["verdict"];
    applied: boolean;
    reason?: GatewayHookTrustDecideResult["reason"];
    status?: HookTrustStatus;
  }): void {
    deps.telemetry?.trackFeatureLoopStage({
      module: "session",
      phase: "hook_trust_decide",
      loopStage: "module_event",
      outcome: input.applied ? "success" : "denied",
      metadata: {
        verdict: input.verdict,
        applied: input.applied,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
    });
  }

  return {
    async list(input) {
      const { workspaceIdentityKey, plugins, evaluation } = await evaluate(input.projectKey);
      return {
        workspaceIdentityKey,
        entries: evaluation.entries.map(entry => toEntry(entry, plugins)),
      };
    },

    async decide(input) {
      const project = deps.resolveProject(input.projectKey);
      await project.pluginRuntime.refresh();
      const plugins = project.pluginRuntime.snapshotContributions().plugins;
      const workspaceIdentityKey = await computeWorkspaceIdentityKey(project.projectRoot);
      const rejected = (reason: NonNullable<GatewayHookTrustDecideResult["reason"]>) => {
        reportDecision({ verdict: input.verdict, applied: false, reason });
        return { applied: false as const, reason };
      };
      const plugin = plugins.find(
        candidate => candidate.source === "project" && `${candidate.name}@${candidate.source}` === input.pluginId,
      );
      if (!plugin) {
        return rejected("unknown_plugin");
      }
      const bundle = await computeHookBundleDigest(plugin.path, plugin.manifest);
      if (bundle.kind === "blocked") {
        // 无法建立摘要 ⇒ 授权无对象（授权的是摘要，不是路径），fail-closed 拒绝写入。
        return rejected("blocked");
      }
      try {
        await deps.store.record(workspaceIdentityKey, {
          pluginId: input.pluginId,
          decision: input.verdict === "grant" ? "granted" : "revoked",
          digest: bundle.digest,
          grantedAt: new Date().toISOString(),
          sourcePath: plugin.path,
        });
      } catch (error) {
        logger.warn(`Hook trust: failed to persist ${input.verdict} for ${input.pluginId}: ${String(error)}`);
        return rejected("write_failed");
      }
      const evaluation = await evaluateProjectHookTrust({
        plugins,
        workspaceIdentityKey,
        trustFile: deps.store.read(),
      });
      const entry = evaluation.entries.find(candidate => candidate.pluginId === input.pluginId);
      reportDecision({ verdict: input.verdict, applied: true, status: entry?.status });
      return { applied: true, ...(entry ? { entry: toEntry(entry, plugins) } : {}) };
    },
  };
}
