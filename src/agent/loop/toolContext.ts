/**
 * 工具运行上下文工厂（从 AgentLoop.ts 拆出）。
 *
 * 负责组装每轮 `SatiToolRuntimeContext`（含子代理 fork API）。
 * 依赖经 host 注入，与 AgentLoop 实例解耦。
 */

import type {
  SatiReadFileStateMap,
  SatiSubagentForkApi,
  SatiToolRuntimeContext,
  SatiWriteSnapshotMap,
} from "../../tool/index.js";
import type { CanonicalUsage } from "../../model/index.js";
import { getSubagentDefinition, listAllSubagentDefinitions } from "../sub/builtinSubagentTypes.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import type { AgentLoopInput } from "../protocol/input.js";
import { renderWorkspaceCoreDirective } from "../../session/workspace/WorkspaceLedger.js";
import { buildTurnEnvironment, composeAbortSignal, type LifecycleDispatcher } from "./misc.js";

/** ToolContextFactory 宿主依赖（由 AgentLoop 组装注入）。 */
export type ToolContextFactoryHost = {
  config: AgentRuntimeConfig;
  dependencies: AgentRuntimeDependencies;
  readFileState: SatiReadFileStateMap;
  writeSnapshots: SatiWriteSnapshotMap;
  allowedReadFiles: Set<string>;
  now: () => Date;
  dispatchLifecycle: LifecycleDispatcher;
};

export class ToolContextFactory {
  constructor(private readonly host: ToolContextFactoryHost) {}

  /** 组装单轮工具运行上下文。 */
  createToolContext(input: AgentLoopInput): SatiToolRuntimeContext {
    const { config, dependencies } = this.host;
    const planDirectoryPath = dependencies.planFileManager?.getPlanDirectoryPath();
    const planTodo = dependencies.planTodoManager?.forSession(input.sessionId);
    const canPrompt = input.canPrompt ?? config.permissionContext.canPrompt;
    const permissionContext = {
      ...config.permissionContext,
      cwd: config.cwd,
      canPrompt,
      ...(planDirectoryPath ? { planDirectoryPath } : {}),
    };
    return {
      sessionId: input.sessionId,
      turnId: input.turnId,
      // 主路径经 context runtime 的 ToolResultBudget 落盘替换大结果，
      // ToolRuntime 不得截断原文（spill 需要完整 body）；无该能力时
      // 由 ToolRuntime 自行按 maxResultBytes 头尾截断兜底。
      spillLayerActive: typeof dependencies.context?.applyToolResults === "function",
      // Group key for `FileHistoryStore.trackEdit` (C4). Our canonical
      // assistant messages don't carry an id, so the turn id is the closest
      // stable scope: every edit/write produced inside this turn rewinds as
      // a single batch — semantic match to legacy "rewind by messageId".
      messageId: input.turnId,
      cwd: config.cwd,
      abortSignal: input.abortSignal,
      subagentTimeoutMs: config.subagentTimeoutMs,
      toolAliases: config.toolAliases,
      runMode: config.runMode ?? "agent",
      permissionMode: config.permissionMode,
      permissionContext,
      auditRecorder: dependencies.auditRecorder,
      now: this.host.now,
      env: buildTurnEnvironment(config.env, config.cwd, input.sessionId, input.turnId),
      // Tools that need a secondary model call (e.g. `agent` subagents in
      // fallback mode, `web_fetch` extraction) get a thin adapter that
      // funnels into the router's stream so subagents inherit fallback /
      // zero-usage retry.
      model: {
        stream: (request, signal) =>
          dependencies.router.stream(request, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            projectPath: config.cwd,
            abortSignal: signal,
            isMainAgent: false,
          }),
      },
      // 会话主模型标识：工具二次模型调用（patent_workflow_run 原子执行等）继承，
      // 避免回退到默认 provider（openrouter）导致未配置时恒降级。
      provider: config.provider,
      modelId: config.model,
      elicitation: dependencies.elicitation,
      fileHistory: dependencies.fileHistory,
      workspaceLedger: dependencies.workspaceLedger,
      subagentDepth: config.subagentDepth ?? 0,
      subagent: this.buildSubagentForkApi(input),
      modelMultimodal: config.modelMultimodal,
      maxOutputTokens: config.maxOutputTokens,
      readFileState: this.host.readFileState,
      allowedReadFiles: [...this.host.allowedReadFiles],
      writeSnapshots: this.host.writeSnapshots,
      fileUpdateNotifier: dependencies.fileUpdateNotifier,
      ...(planTodo ? { planTodo } : {}),
      ...(planDirectoryPath
        ? {
            planDirectory: {
              path: planDirectoryPath,
              resolve: (filePath: string) => dependencies.planFileManager?.resolvePlanFilePath(filePath, config.cwd),
              read: (filePath: string) => dependencies.planFileManager?.readPlanFile(filePath, config.cwd),
            },
          }
        : {}),
    };
  }

  /**
   * 渲染父会话工作区账本的 live Core 作为子代理指令前缀（broadcast hub）。
   * 无账本 provider / 无 live core 时返回 undefined（指令不变）。
   */
  private async buildWorkspaceCoreDirective(): Promise<string | undefined> {
    const provider = this.host.dependencies.workspaceLedger;
    if (!provider) return undefined;
    try {
      const state = await provider.read();
      if (!state) return undefined;
      return renderWorkspaceCoreDirective(state);
    } catch {
      return undefined;
    }
  }

  /** 子代理 fork API（agent 工具的回调面）。 */
  buildSubagentForkApi(input: AgentLoopInput): SatiSubagentForkApi {
    const { config, dependencies } = this.host;
    const depth = config.subagentDepth ?? 0;
    const maxDepth = config.maxSubagentDepth ?? 1;
    return {
      depth,
      maxSubagentDepth: maxDepth,
      listDefinitions: () =>
        listAllSubagentDefinitions().map(d => ({
          id: d.id,
          description: d.description,
        })),
      isAllowedDefinition: (id: string) => getSubagentDefinition(id) !== undefined,
      fork: async ({ definitionId, directive, subagentId, toolCallId, abortSignal, timeoutMs }) => {
        // Defer SubAgentSession import to avoid the runtime cycle (sub → loop → sub).
        const { SubAgentSession } = await import("../sub/SubAgentSession.js");
        const def = getSubagentDefinition(definitionId);
        if (!def) throw new Error(`Unknown subagent type: ${definitionId}`);
        const composedAbort = composeAbortSignal({
          parent: abortSignal,
          timeoutMs,
        });

        const subagentSessionId = `${config.cwd}::sub::${subagentId}`;
        const transcriptHooks = dependencies.subagentTranscript;
        const sidechain = transcriptHooks?.subagentTranscriptResolver?.(subagentId);
        const transcriptRelativePath = sidechain?.transcriptRelativePath ?? "";

        await transcriptHooks?.recordSubagentStarted?.({
          sessionId: input.sessionId,
          turnId: input.turnId,
          subagentId,
          subagentType: def.id,
          prompt: directive,
          transcriptRelativePath,
          subagentSessionId,
        });
        await this.host.dispatchLifecycle(input, "SubagentStart", {
          subagentId,
          subagentType: def.id,
        });
        dependencies.eventEmitter?.({
          type: "subagent_started",
          sessionId: input.sessionId,
          turnId: input.turnId,
          subagentId,
          subagentType: def.id,
          toolCallId,
        });

        const workspaceCoreDirective = await this.buildWorkspaceCoreDirective();
        const effectiveDirective = workspaceCoreDirective ? `${workspaceCoreDirective}\n\n${directive}` : directive;
        const subSession = new SubAgentSession({
          definition: def,
          directive: effectiveDirective,
          parentConfig: {
            ...config,
            subagentDepth: depth + 1,
            isSubagent: true,
          },
          parentDependencies: dependencies,
          parentReadFileState: this.host.readFileState,
          parentWriteSnapshots: this.host.writeSnapshots,
          parentSessionId: input.sessionId,
          parentTurnId: input.turnId,
          subagentSessionId,
          subagentId,
          abortSignal: composedAbort.signal,
          sidechainTranscript: sidechain
            ? {
                recordAcceptedInput: sidechain.recordAcceptedInput.bind(sidechain),
                recordDurableMessage: sidechain.recordDurableMessage.bind(sidechain),
              }
            : undefined,
        });

        let report;
        try {
          report = await subSession.run();
          if (composedAbort.timedOut()) {
            throw new Error(`Subagent timed out after ${timeoutMs}ms.`);
          }
        } catch (err) {
          composedAbort.cleanup();
          // 失败也排空 sidechain 写缓冲：子代理异常中断时已记录的 durable
          // 消息必须落盘（父 turn 的 subagent_completed 落盘前 sidechain 完整）。
          await sidechain?.flush?.();
          await this.finalizeSubagent(input, {
            subagentId,
            subagentType: def.id,
            success: false,
            summary: err instanceof Error ? err.message : String(err),
            turns: 0,
            durationMs: 0,
          });
          throw err;
        }
        composedAbort.cleanup();
        // 成功收尾：排空 sidechain 写缓冲（无 turn_result 强制 flush，仅靠
        // 50ms 兜底定时器——进程在间隔内退出会丢 sidechain 尾条）。
        await sidechain?.flush?.();

        await this.finalizeSubagent(input, {
          subagentId,
          subagentType: def.id,
          success: true,
          summary: report.markdown,
          usage: report.usage,
          turns: report.turns,
          durationMs: report.durationMs,
        });

        return {
          markdown: report.markdown,
          usage: report.usage,
          turns: report.turns,
          durationMs: report.durationMs,
          // SubagentReport.parsed 为固定 5 键结构（CanonicalAssistantTextSummary），
          // fork API 契约声明为 Record<string, string>（tool 层不依赖 sub 层类型，
          // 避免 tool → agent/sub 依赖反转）；双重 cast 是解耦的必要转换。
          parsed: report.parsed as unknown as Record<string, string> | undefined,
        };
      },
    };
  }

  /** 子代理终结三连：记录完成、生命周期钩子、事件发射（成功/失败共用）。 */
  private async finalizeSubagent(
    input: AgentLoopInput,
    args: {
      subagentId: string;
      subagentType: string;
      success: boolean;
      summary: string;
      usage?: CanonicalUsage;
      turns: number;
      durationMs: number;
    },
  ): Promise<void> {
    const { dependencies } = this.host;
    await dependencies.subagentTranscript?.recordSubagentCompleted?.({
      sessionId: input.sessionId,
      turnId: input.turnId,
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      summary: args.summary,
      ...(args.usage !== undefined ? { usage: args.usage } : {}),
      turns: args.turns,
      durationMs: args.durationMs,
      errored: !args.success,
    });
    await this.host.dispatchLifecycle(input, "SubagentStop", {
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      success: args.success,
    });
    dependencies.eventEmitter?.({
      type: "subagent_completed",
      sessionId: input.sessionId,
      turnId: input.turnId,
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      success: args.success,
      durationMs: args.durationMs,
    });
  }
}
