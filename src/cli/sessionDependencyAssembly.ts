/**
 * 会话依赖装配（P4a 第七刀，类内拆分）：从 ProjectRuntimeRegistry.prepareSessionRuntime 搬出。
 *
 * 两件事：① `baseDependencies`——会话创建期就绪的运行时依赖（router / 本会话工具表 /
 * lifecycle / 时间源 / 事件缓冲 / token 账本 / 模型能力查询三件套）；②
 * `extendDependencies(storage)`——拿到本会话 storage 后再补的运行时（上下文运行时、
 * 文件历史、子代理转录钩子、elicitation 通道、plan 文件与 todo 管理器）。
 *
 * 输入面只有 5 个值 + 3 个对象 + 1 个取数函数：`getGateway` 是**取数函数而非值**是有意的
 * ——gateway 由 `setGateway` 晚绑定，原闭包在 `extendDependencies(storage)` 真正被调用时
 * （即建会话时）才读它。`lifecycle` / `extension` 由调用方装配后传入，因为权限 hook 就注册在
 * 同一个 `HookRuntime` 上（见 `prepareSessionRuntime`），本模块不持有也不得重建它。
 */

import { createAgentEventBuffer, type CreateAgentSessionOptions } from "../agent/index.js";
import type { AgentSubagentTranscriptHooks } from "../agent/runtime/AgentRuntimeDependencies.js";
import { createPlanTodoStateManager } from "../agent/runtime/PlanTodoState.js";
import { resolveRoutedModelMaxContextTokens } from "../agent/runtime/modelContextWindow.js";
import {
  AutoCompactionPolicy,
  CachedMicroCompactionEngine,
  CompactionEngine,
  ContextOverflowRecovery,
  DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
  DefaultContextRuntime,
  InstructionDiscovery,
  type MemoryResolver,
  MicroCompactionEngine,
  type PluginRuntimeExtensionResolver,
  SnipEngine,
  type TokenAccountingRuntime,
  TokenBudgetManager,
  ToolResultBudget,
} from "../context/index.js";
import { GatewayElicitationChannel, type InProcessGateway } from "../gateway/index.js";
import type { LifecycleRuntime } from "../lifecycle/index.js";
import type { ModelRuntime } from "../model/index.js";
import type { loadPilotConfig } from "../pilot/index.js";
import type { RouterRuntime } from "../router/index.js";
import { createAgentProjectSessionStorage } from "../session/index.js";
import { FileHistoryStore } from "../session/filesystem/FileHistoryStore.js";
import type { ResumeSessionDependencyExtension } from "../session/resume/resumeAgentSession.js";
import { createPlanFileManager, type ToolRegistry } from "../tool/index.js";
import { createAutoElicitationChannel } from "./gatewaySupport.js";

/** buildSessionDependencies 需要读的 ProjectRuntime 投影（类内 ProjectRuntime 不导出）。 */
export type SessionDependenciesRuntimeView = {
  projectRoot: string;
  snapshot: ReturnType<typeof loadPilotConfig>;
  model: ModelRuntime;
  tokenAccounting: TokenAccountingRuntime;
  router: RouterRuntime;
  /** 未启用记忆时为 undefined（原闭包取 `runtime.memory`）。 */
  memory?: MemoryResolver;
};

export type SessionDependenciesInput = {
  sessionKey: string;
  /** router.stream 的 projectPath；未指定时沿用会话默认。 */
  projectKey?: string;
  runtime: SessionDependenciesRuntimeView;
  /** 本会话的工具表（`provisionSessionTools` 裁剪后的结果，逐会话不同）。 */
  sessionTools: ToolRegistry;
  /** 调用方已装配的 lifecycle（权限 hook 注册在同一 HookRuntime 上，不可替换）。 */
  lifecycle: LifecycleRuntime;
  /** 插件/MCP 指令解析器。 */
  extension: PluginRuntimeExtensionResolver;
  now: () => Date;
  pilotHome: string;
  autoElicitation?: boolean;
  /** 取数函数而非值：gateway 由调用方 setGateway 晚绑定。 */
  getGateway: () => InProcessGateway | undefined;
};

export type SessionDependencies = {
  baseDependencies: CreateAgentSessionOptions["dependencies"];
  extendDependencies: ResumeSessionDependencyExtension;
};

export function buildSessionDependencies(deps: SessionDependenciesInput): SessionDependencies {
  const { runtime, lifecycle, extension, sessionTools } = deps;
  const projectRoot = runtime.projectRoot;
  const memoryResolver = runtime.memory;
  const now = deps.now;
  const eventBuf = createAgentEventBuffer();

  const baseDependencies: CreateAgentSessionOptions["dependencies"] = {
    router: runtime.router,
    tools: { registry: sessionTools },
    lifecycle,
    now: deps.now,
    eventEmitter: eventBuf.emitter,
    drainEvents: eventBuf.drain,
    tokenAccounting: runtime.tokenAccounting,
    getModelMaxContextTokens: (provider, model) =>
      resolveRoutedModelMaxContextTokens({
        modelRuntime: runtime.model,
        agentModel: runtime.snapshot.config.agent.model,
        agentMaxContextTokens: runtime.snapshot.config.agent.maxContextTokens,
        provider,
        model,
      }),
    getProviderProtocol: providerId => {
      try {
        return runtime.model.getProviderProtocol(providerId);
      } catch {
        // provider 未知时无协议可查 → 返回 undefined，调用方按默认协议处理。
        return undefined;
      }
    },
    getModelMaxOutputTokens: (provider, model) => {
      try {
        return runtime.model.getCapabilities(provider, model).maxOutputTokens;
      } catch {
        // provider/model 未知 → 输出上限未知，返回 undefined 走环境变量/默认兜底。
        return undefined;
      }
    },
    getModelTokenLimits: (provider, model) => {
      try {
        const caps = runtime.model.getCapabilities(provider, model);
        return { maxContextTokens: caps.maxContextTokens, maxOutputTokens: caps.maxOutputTokens };
      } catch {
        // 同上：能力查询失败即返回 undefined，由调用方兜底，不阻断启动。
        return undefined;
      }
    },
  };
  const extendDependencies = (storage: ReturnType<typeof createAgentProjectSessionStorage>) => {
    const toolResultBudget = new ToolResultBudget({ toolResultsDir: storage.toolResultsDir });
    const tokenBudget = new TokenBudgetManager();
    const compactionEngine = new CompactionEngine({
      model: {
        stream: (request, signal) =>
          runtime.router.stream(request, {
            sessionId: deps.sessionKey,
            turnId: "compact",
            projectPath: deps.projectKey,
            abortSignal: signal,
            isMainAgent: false,
          }),
      },
      tokenBudget,
      tokenAccounting: runtime.tokenAccounting,
      lifecycle: {
        async dispatch(input) {
          await lifecycle.dispatch({
            event: input.event,
            baseInput: {
              sessionId: deps.sessionKey,
              transcriptPath: "",
              cwd: projectRoot,
              permissionMode: "default",
            },
            payload: input.payload,
            matchQuery: input.event,
          });
        },
      },
      provider: runtime.snapshot.config.agent.model.provider,
      model_: runtime.snapshot.config.agent.model.model,
      protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
      now,
      eventEmitter: eventBuf.emitter,
    });
    const autoCompactionPolicy = new AutoCompactionPolicy();
    const microcompactEngine = new CachedMicroCompactionEngine({ enabled: true });
    const microCompaction = new MicroCompactionEngine({
      protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
    });
    const snipEngine = new SnipEngine({
      protectedToolNames: DEFAULT_PROTECTED_TOOL_RESULT_NAMES,
    });
    const overflowRecovery = new ContextOverflowRecovery();
    const caps = runtime.model.getCapabilities(
      runtime.snapshot.config.agent.model.provider,
      runtime.snapshot.config.agent.model.model,
    );
    const instructionDiscovery = new InstructionDiscovery(projectRoot, projectRoot, deps.pilotHome);
    const contextRuntime = new DefaultContextRuntime({
      extension,
      projectRoot,
      memoryResolver,
      memoryRetrievalTimeoutMs: runtime.snapshot.config.memory?.retrievalTimeoutMs,
      // 项目知识偏好透传：knowledge provider 据此强制注入/加权审查标准
      knowledgeProfile: runtime.snapshot.config.memory?.knowledgeProfile,
      instructionDiscovery,
      toolResultBudget,
      tokenBudget,
      compactionEngine,
      autoCompactionPolicy,
      microcompactEngine,
      microCompaction,
      snipEngine,
      overflowRecovery,
      maxContextTokens: runtime.snapshot.config.agent.maxContextTokens ?? caps.maxContextTokens,
      now,
    });
    const fileHistory = new FileHistoryStore({
      backupDir: storage.fileHistoryDir,
      now: deps.now,
    });
    const gw = deps.getGateway();
    const elicitation = deps.autoElicitation
      ? createAutoElicitationChannel()
      : gw
        ? new GatewayElicitationChannel({
            sessionKey: deps.sessionKey,
            bus: gw.getElicitationBus(),
            emit: event => gw.emitForSession(deps.sessionKey, event),
            dispatchHook: (hookEvent, payload) => {
              lifecycle
                .dispatch({
                  event: hookEvent as import("../extension/hooks/protocol/events.js").SatiHookEvent,
                  baseInput: { sessionId: deps.sessionKey, transcriptPath: "", cwd: projectRoot },
                  payload,
                  matchQuery: hookEvent,
                })
                .catch(() => {});
            },
            emitAgentEvent: (_type, payload) => {
              eventBuf.emitter({
                type: "elicitation_requested",
                sessionId: deps.sessionKey,
                turnId: "",
                requestId: payload.requestId,
                toolName: payload.toolName,
              });
            },
          })
        : undefined;
    const subagentTranscript: AgentSubagentTranscriptHooks = {
      recordSubagentStarted: args =>
        storage.transcript.recordSubagentStarted(args.sessionId, args.turnId, {
          subagentId: args.subagentId,
          subagentType: args.subagentType,
          prompt: args.prompt,
          transcriptRelativePath: args.transcriptRelativePath,
          subagentSessionId: args.subagentSessionId,
        }),
      recordSubagentCompleted: args =>
        storage.transcript.recordSubagentCompleted(args.sessionId, args.turnId, {
          subagentId: args.subagentId,
          subagentType: args.subagentType,
          summary: args.summary,
          usage: args.usage,
          turns: args.turns,
          durationMs: args.durationMs,
          errored: args.errored,
        }),
      subagentTranscriptResolver: subagentId => {
        const handle = storage.transcript.forSubagent(subagentId, deps.now);
        return {
          recordAcceptedInput: (sessionId, turnId, messages) =>
            handle.writer.recordAcceptedInput(sessionId, turnId, messages),
          recordDurableMessage: (sessionId, turnId, message) =>
            handle.writer.recordDurableMessage(sessionId, turnId, message),
          // 子代理收尾时排空 sidechain 写缓冲：sidechain 无 turn_result 强制
          // flush，仅靠 50ms 兜底定时器（unref）——进程在间隔内退出丢尾条。
          flush: () => handle.writer.flushCheckpoint(),
          transcriptRelativePath: storage.transcript.relativeSubagentPath(subagentId),
        };
      },
    };
    const planFileManager = createPlanFileManager({ projectRoot });
    const planTodoManager = createPlanTodoStateManager();
    return {
      context: contextRuntime,
      fileHistory,
      subagentTranscript,
      elicitation,
      planFileManager,
      planTodoManager,
    };
  };
  return { baseDependencies, extendDependencies };
}
