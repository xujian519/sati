/**
 * gateway 运行期选项装配（P4a 第三刀）：从 createLocalGateway.ts 的工厂函数搬出，
 * 除捕获绑定改写为 `deps.` 寻址外，选项对象文本逐字保留（AST 规范化对比等价）。
 *
 * 被搬走的是一整块"网关面对外能力"声明——22 个选项字段，其中 17 个是闭包回调
 * （edit/regenerate 最后一条、团队面板快照与特权直调、配置/扩展热重载、每回合
 * 配置复查、回合结束收尾等）。它们原本闭包捕获工厂内的 18 个局部绑定；现在改为显式
 * `deps` 字段，其中 gateway（构造中）、teamDb（声明在其后）、boundServer（bindServer
 * 晚绑定）三个绑定无法按值传入，改为取数函数——与原闭包的"延迟求值"语义一致。
 */

import { TeamDb } from "../agent/team/index.js";
import {
  InProcessGateway,
  type InProcessGatewayOptions,
  KanbanBoardManager,
  SessionRouter,
  logGatewayMemoryDiagnostic,
  summarizeCanonicalMessages,
} from "../gateway/index.js";
import { SessionPresence } from "../gateway/server/sessionPresence.js";
import { buildTeamPanelSnapshot } from "../gateway/teamPanel.js";
import { SatiToolRuntimeError } from "../tool/protocol/errors.js";
import { type PilotConfigStore } from "../pilot/config/PilotConfigStore.js";
import { createAgentProjectSessionStorage } from "../session/index.js";
import { readSubagentWebMessages, readWebSessionMessages } from "../web/server/readSessionMessages.js";
import { forkWebSession } from "../web/server/forkSession.js";
import { rewriteLastTurn } from "../web/server/editLastTurn.js";
import { describeWebProject, listWebProjects } from "../web/server/listProjects.js";
import { type SatiToolRuntimeContext } from "../tool/index.js";
import { SkillManager } from "../extension/skills/index.js";
import { logger } from "../telemetry/index.js";
import { ProjectRuntimeRegistry } from "./ProjectRuntimeRegistry.js";

export type GatewayRuntimeOptionsDeps = {
  router: SessionRouter;
  projectRoot: string;
  fallbackProjectRoot: string;
  pilotHome: string;
  now: () => Date;
  telemetry: InProcessGatewayOptions["telemetry"];
  kanbanBoardManager: KanbanBoardManager;
  skillManager: SkillManager;
  cron: InProcessGatewayOptions["cron"];
  sessionPresence: SessionPresence;
  registry: ProjectRuntimeRegistry;
  configStore: PilotConfigStore;
  /** 会话消息读取的上下文/输出上限（来自 defaultRuntime.snapshot.config.agent）。 */
  agentMaxContextTokens: number | undefined;
  agentMaxOutputTokens: number | undefined;
  memoryDiagnosticsEnabled: boolean;
  /** gateway 自身（edit/regenerate 的挂起审批预检读它的 approval bus）——构造期不可直接引用，故取数。 */
  getGateway: () => InProcessGateway;
  /** teams.db 声明在 gateway 之后，闭包延迟取数。 */
  getTeamDb: () => TeamDb;
  /** 由 bindServer 晚绑定，闭包取数。 */
  getBoundServer: () => { broadcastNotification(name: string, payload?: unknown): void } | undefined;
};

export function buildGatewayRuntimeOptions(deps: GatewayRuntimeOptionsDeps): InProcessGatewayOptions {
  return {
    serverInfo: { mode: "in_process", projectKey: deps.projectRoot },
    telemetry: deps.telemetry,
    kanban: deps.kanbanBoardManager,
    cron: deps.cron,
    skillManager: deps.skillManager,
    setSessionCwd: (sessionKey, cwd) => deps.registry.setSessionCwd(sessionKey, cwd),
    readSessionMessages: input =>
      readWebSessionMessages(input, {
        projectRoot: input.projectKey ? input.projectKey : deps.fallbackProjectRoot,
        pilotHome: deps.pilotHome,
        maxContextTokens: deps.agentMaxContextTokens,
        maxOutputTokens: deps.agentMaxOutputTokens,
        now: deps.now,
      }),
    readSubagentMessages: input =>
      readSubagentWebMessages(input, {
        projectRoot: input.projectKey ? input.projectKey : deps.fallbackProjectRoot,
        pilotHome: deps.pilotHome,
        now: deps.now,
      }),
    forkSession: input =>
      forkWebSession(input, {
        projectRoot: input.projectKey ? input.projectKey : deps.fallbackProjectRoot,
        pilotHome: deps.pilotHome,
        now: deps.now,
      }),
    // 编辑/重新生成最后一条用户消息（协议 1.7）：预检 in-flight turn 与挂起审批
    // （内存 bus + 团队持久化表），通过后经 rewriteLastTurn 追加 turn_rewrite 遮蔽
    // 条目；新输入由调用方随后走标准 submit_turn。
    editLastTurn: async input => {
      if (deps.router.hasInFlightTurn(input.sessionKey)) {
        return { rewritten: false, reason: "active_turn" };
      }
      if (
        deps.getGateway().getApprovalBus().list(input.sessionKey).length > 0 ||
        deps.getTeamDb().hasPendingApproval(input.sessionKey)
      ) {
        return { rewritten: false, reason: "pending_approval" };
      }
      return rewriteLastTurn(
        { sessionKey: input.sessionKey, reason: "edit_last_turn", newText: input.text },
        {
          projectRoot: input.projectKey ? input.projectKey : deps.fallbackProjectRoot,
          pilotHome: deps.pilotHome,
          now: deps.now,
        },
      );
    },
    regenerateLastTurn: async input => {
      if (deps.router.hasInFlightTurn(input.sessionKey)) {
        return { rewritten: false, reason: "active_turn" };
      }
      if (
        deps.getGateway().getApprovalBus().list(input.sessionKey).length > 0 ||
        deps.getTeamDb().hasPendingApproval(input.sessionKey)
      ) {
        return { rewritten: false, reason: "pending_approval" };
      }
      return rewriteLastTurn(
        { sessionKey: input.sessionKey, reason: "regenerate_last_turn" },
        {
          projectRoot: input.projectKey ? input.projectKey : deps.fallbackProjectRoot,
          pilotHome: deps.pilotHome,
          now: deps.now,
        },
      );
    },
    async recordAgentStatusMessage(input) {
      const storage = createAgentProjectSessionStorage({
        projectRoot: input.projectKey ? input.projectKey : deps.fallbackProjectRoot,
        pilotHome: deps.pilotHome,
        sessionId: input.sessionKey,
        now: deps.now,
      });
      await storage.transcript.recordAgentStatusMessage(input.sessionKey, input.turnId, input.status);
      return { recorded: true };
    },
    listProjects: () => listWebProjects({ pilotHome: deps.pilotHome }),
    describeProject: input => describeWebProject(input.projectKey, { pilotHome: deps.pilotHome }),
    knowledgeCapabilities: input => Promise.resolve(deps.registry.knowledgeCapabilitiesReport(input?.projectKey)),
    // M4（Web 下线判定）：面板心跳 → SessionPresence.panelTouch（浏览器经 ui/server
    // relay 周期上报；浏览器关闭不触发 gateway onClose，以心跳停 + 宽限窗判离线）。
    panelHeartbeat: async (input: { sessionKeys: string[] }) => {
      for (const key of input.sessionKeys) {
        deps.sessionPresence.panelTouch(key);
      }
      return { touched: input.sessionKeys.length };
    },
    // M4（团队活动面板，T6）：数据面——TeamDb 直查 + presence 在线态快照，
    // 不触发模型回路。teamDb 声明于 gateway 之后（团队子系统区块），闭包延迟引用。
    // 信任边界（T6 评审 M2）：与 list_sessions 同层——ws token 持有者即可枚举团队
    // 快照；单用户桌面场景可接受，不校验 sessionKey（无独立敏感数据，成员已全退休
    // 时仅剩团队壳）。
    teamPanelSnapshot: async (_input: { sessionKey?: string }) => {
      return buildTeamPanelSnapshot(deps.getTeamDb(), deps.sessionPresence);
    },
    // M4（团队活动面板，T6）：操作面——直调既有 team_* 工具。权限自守
    // （requireTeamCaptain/requireTeamMember 基于 context.sessionId）、TeamEvent
    // 广播走工具层既有链（emit 经 TeamToolsOptions 注入），面板不重复实现语义。
    // 工具经 registry.resolve(fallbackProjectRoot).tools 取当前项目 runtime 注册表
    // （setTeamTools 注入后含 9 个 team_* 工具；面板操作在启动扫描后发生，时序安全）。
    // 首次调用可能触发一次性的同步 runtime 构建（resolve 无缓存命中时），之后命中缓存
    // （T6 评审 M3）。
    // 信任边界（T6 评审 M1）：仅暴露 team_* 前缀工具——面板操作面是特权的直调通道
    // （不经 ToolRuntime 的权限/校验/审计链），白名单之外的工具一律 fail-closed 拒绝。
    teamToolCall: async (input: { tool: string; input: Record<string, unknown>; sessionKey?: string }) => {
      if (!input.tool.startsWith("team_")) {
        return {
          ok: false,
          error: { code: "team_unknown_tool", message: `工具 ${input.tool} 不在面板操作面（仅 team_* 域）` },
        };
      }
      const tool = deps.registry.resolve(deps.fallbackProjectRoot).tools.get(input.tool);
      if (!tool) {
        return { ok: false, error: { code: "team_unknown_tool", message: `工具 ${input.tool} 不存在` } };
      }
      try {
        // 特权直调不经 ToolRuntime 的权限/校验/审计链，context 仅需满足
        // SatiToolRuntimeContext 形状（team_* 工具实际消费 sessionId/cwd/turnId）。
        const context: SatiToolRuntimeContext = {
          sessionId: input.sessionKey ?? "",
          turnId: `team-panel-${crypto.randomUUID()}`,
          cwd: deps.fallbackProjectRoot,
          permissionMode: "default",
          permissionContext: {
            mode: "default",
            rules: { allow: [], deny: [], ask: [] },
            cwd: deps.fallbackProjectRoot,
            additionalWorkingDirectories: [],
            canPrompt: false,
            bypassAvailable: false,
          },
        };
        const out = await tool.execute(input.input, context);
        return { ok: true, data: out.data };
      } catch (error) {
        const code = error instanceof SatiToolRuntimeError ? error.code : "tool_execution_failed";
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: { code, message } };
      }
    },
    async reloadConfig() {
      let changedPaths: string[] = [];
      const unsubscribe = deps.configStore.subscribe(event => {
        changedPaths = event.changedPaths;
      });
      try {
        await deps.configStore.reload("rpc");
      } finally {
        unsubscribe();
      }
      return { reloaded: true, changedPaths };
    },
    async reloadExtensions(input) {
      const changedPaths = input?.changedPaths ?? [];
      if (input?.projectKey) {
        logger.info(
          `Extensions reload requested for project ${input.projectKey}:`,
          changedPaths.join(", ") || "(manual)",
        );
        deps.registry.invalidate(input.projectKey);
        deps.router?.markProjectDirty(input.projectKey, "extension_changed");
      } else {
        logger.info("Extensions reload requested for all runtimes:", changedPaths.join(", ") || "(manual)");
        deps.registry.invalidate();
        deps.router?.markAllDirty("extension_changed");
      }
      deps.getBoundServer()?.broadcastNotification("config_changed", {
        changedPaths,
        changeClasses: ["extension-changed"],
      });
      return { reloaded: true, changedPaths };
    },
    // Defensive: re-check the on-disk config at the start of every
    // turn so an apiKey/url edit applied between two messages takes
    // effect on the next one, even if the fs watcher missed it.
    // Singleton-deduped inside PilotConfigStore.reload — concurrent
    // turns share a single in-flight read, and unchanged config is a
    // no-op (no invalidation, no session recreation).
    async refreshConfigBeforeTurn() {
      await deps.configStore.reload("turn-start");
    },
    afterTurnCompleted: ({ sessionKey, projectKey, runId }) => {
      if (deps.memoryDiagnosticsEnabled) {
        const snapshot = deps.router?.snapshotSession(sessionKey);
        logGatewayMemoryDiagnostic({
          event: "turn_completed",
          sessionCount: deps.router?.cachedSessionCount(),
          session: {
            sessionKey,
            projectKey,
            runId,
            ...(snapshot ? summarizeCanonicalMessages(snapshot.messages) : {}),
          },
        });
      }
      deps.registry.scheduleMemoryMaintenance(projectKey ?? deps.fallbackProjectRoot);
    },
  };
}
