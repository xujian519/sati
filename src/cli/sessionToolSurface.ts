/**
 * 会话工具面供给（P4a 第五刀）：从 ProjectRuntimeRegistry.prepareSessionRuntime 抽出的
 * 「这个会话能看到哪些工具」阶段，逐字搬出（捕获绑定改写为 `input.` 字段）。
 *
 * 涵盖四层筛选，顺序即语义：
 * 1. **每会话 MCP runtime**——`perSession: true` 的 server（如 browser-use）为每个会话
 *    起独立进程：改写其参数（截图目录 cwd、代理透传）、启动并把工具注册进会话注册表；
 *    实例数上限内 LRU 式驱逐、启动失败降级为共享项目级实例。
 * 2. **unattended 会话的 excludeTools**——无人值守场景剔除需要交互的工具。
 * 3. **always_on_* 剥离**——非 Always-On 会话不暴露需要 AlwaysOnRunContext 的工具。
 * 4. **可用性过滤 + 成员角色裁剪**——`filterAvailableTools` 按环境探测；成员会话再按
 *    角色定义（allowedTools/visibleDomains/omitTools）裁剪，并保留 team 作业面。
 *
 * 被抽出的动因（TD-GOD-002 (c)）：browser-use 专属逻辑（截图目录 mkdir、逐 spec 参数
 * 改写）此前混在通用会话装配里，读装配要先读完这段特例。
 */

import { mkdirSync as mkdirSyncFs } from "node:fs";
import { join as joinPath } from "node:path";
import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import { type ScopeToolsOptions, scopeToolsForDefinition } from "../agent/sub/scopeTools.js";
import { parseMemberSessionKey } from "../agent/team/index.js";
import { McpRuntime, createMcpToolDefinitionsFromRuntime } from "../mcp/index.js";
import { sanitizeSessionIdForPath } from "../session/storage/ProjectSessionStorage.js";
import { type SatiToolDefinition, type ToolRegistry, filterAvailableTools } from "../tool/index.js";
import type { SatiUnavailableToolDiagnostic } from "../tool/index.js";
import { logger } from "../telemetry/index.js";
import { buildBrowserUseArgs } from "./browserLaunchArgs.js";

export type SessionToolSurfaceInput = {
  sessionKey: string;
  /** 项目级共享工具注册表；本函数只读它（需要裁剪时先 clone）。 */
  projectTools: ToolRegistry;
  projectRoot: string;
  env: Record<string, string | undefined>;
  proxy: Parameters<typeof buildBrowserUseArgs>[3];
  /** `perSession: true` 的 MCP server 规格（无则为 undefined）。 */
  perSessionServerSpecs: import("../mcp/protocol/types.js").SatiMcpServerSpec[] | undefined;
  maxPerSessionMcpInstances: number;
  /** 每会话 MCP runtime 表：本函数会驱逐旧实例并登记新实例。 */
  sessionMcpRuntimes: Map<string, McpRuntime>;
  evictSessionMcp: (sessionKey: string) => void;
  sessionOverrides: SessionConfigOverrides | undefined;
  extraTools: SatiToolDefinition[];
  memberToolScopeResolver: ((memberId: string) => ScopeToolsOptions | undefined) | undefined;
};

export type SessionToolSurface = {
  tools: ToolRegistry;
  unavailableTools: SatiUnavailableToolDiagnostic[];
};

export async function provisionSessionTools(input: SessionToolSurfaceInput): Promise<SessionToolSurface> {
  // -- per-session MCP runtime (e.g. browser-use) --------------------
  let sessionTools: ToolRegistry = input.projectTools;
  const perSpecs = input.perSessionServerSpecs;
  const maxInstances = input.maxPerSessionMcpInstances ?? 5;
  if (perSpecs && perSpecs.length > 0 && input.sessionMcpRuntimes.size < maxInstances) {
    input.evictSessionMcp(input.sessionKey);
    const patchedPerSpecs = perSpecs.map(spec => {
      if (spec.transport === "stdio" && spec.id === "browser-use") {
        const outDir = joinPath(
          input.projectRoot,
          ".sati",
          "browser_screenshots",
          sanitizeSessionIdForPath(input.sessionKey),
        );
        mkdirSyncFs(outDir, { recursive: true });
        return {
          ...spec,
          cwd: outDir,
          args: buildBrowserUseArgs(spec.args ?? [], outDir, input.env, input.proxy),
        };
      }
      return spec;
    });
    const sessionMcp = new McpRuntime(patchedPerSpecs);
    input.sessionMcpRuntimes.set(input.sessionKey, sessionMcp);
    try {
      await sessionMcp.start();
      const defs = await createMcpToolDefinitionsFromRuntime(sessionMcp);
      if (defs.length > 0) {
        sessionTools = input.projectTools.clone();
        for (const def of defs) {
          if (sessionTools.has(def.name)) {
            sessionTools.replace(def);
          } else {
            sessionTools.register(def);
          }
        }
      }
    } catch (error) {
      logger.warn(
        `Per-session MCP startup failed for ${input.sessionKey}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (perSpecs && perSpecs.length > 0) {
    logger.warn(
      `Per-session MCP limit reached (${maxInstances}). ` +
        `Session ${input.sessionKey} will share the project-level browser instance.`,
    );
  }

  // -- excludeTools filtering (unattended sessions) -------------------
  const override = input.sessionOverrides?.get(input.sessionKey);
  if (override?.excludeTools && override.excludeTools.length > 0) {
    if (sessionTools === input.projectTools) {
      sessionTools = input.projectTools.clone();
    }
    for (const name of override.excludeTools) {
      sessionTools.unregister(name);
    }
  }

  // -- Strip always_on_* tools from non-Always-On sessions -------------
  // These tools require an AlwaysOnRunContext to execute; surfacing them
  // in regular user sessions just pollutes the model's tool list.
  const isAlwaysOnSession = input.sessionKey.startsWith("always-on/");
  if (!isAlwaysOnSession) {
    const alwaysOnNames = input.extraTools.filter(t => t.name.startsWith("always_on_")).map(t => t.name);
    if (alwaysOnNames.length > 0) {
      if (sessionTools === input.projectTools) {
        sessionTools = input.projectTools.clone();
      }
      for (const name of alwaysOnNames) {
        sessionTools.unregister(name);
      }
    }
  }

  const availability = await filterAvailableTools(sessionTools, {
    cwd: input.projectRoot,
    env: input.env,
  });
  sessionTools = availability.registry;

  // P0-1：成员会话工具隔离——按成员角色裁剪工具集（allowedTools/visibleDomains/
  // omitTools），使自动唤醒成员只暴露角色专业工具，而非保有队长全工具，
  // 同时剥离 never-expose 的 HARD_BLOCKED/open_ai/always_on_* 等工具
  //（scopeToolsForDefinition 已内置该剔除）。未注册角色/未命中成员降级不裁。
  const parsedMember = parseMemberSessionKey(input.sessionKey);
  if (parsedMember) {
    const scope = input.memberToolScopeResolver?.(parsedMember.memberId);
    if (scope) {
      const scopedDefs = scopeToolsForDefinition(sessionTools.list(), scope);
      const keep = new Set(scopedDefs.map(tool => tool.name));
      // 成员作业面保留：domain === "team"（job-surface：team_update_task/team_status/
      // team_send_message/team_share_write/team_share_read）是成员完成任务所必需的运行面，
      // 不受角色 subject domains 裁剪——角色 domains 描述专业主题域（patent/search/legal…），
      // 不覆盖团队作业面；management 面（team:manage，captain-only）仍被裁剪隐藏。
      for (const tool of sessionTools.list()) {
        if (tool.domain === "team") {
          keep.add(tool.name);
        }
      }
      const scoped = sessionTools.clone();
      for (const tool of sessionTools.list()) {
        if (!keep.has(tool.name)) {
          scoped.unregister(tool.name);
        }
      }
      sessionTools = scoped;
    }
  }
  return { tools: sessionTools, unavailableTools: availability.unavailable };
}
