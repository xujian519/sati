/**
 * 项目工具表装配（P2.7 从 `projectRuntimeFactory.ts` 的 `createProjectRuntimeResolver` 内嵌闭包
 * 搬出，逐 token 未改）。
 *
 * 顺序有语义，别挪：`createBuiltinRegistry` 先按可选开关决定注册哪些内置组（段缺失 = 保持
 * 历史默认注册、显式 `enabled: false` 才不注册），随后 `register` 逐个并入宿主 extraTools，
 * 最后才按工作区专利判据与 `tools.visibleDomains` / `tools.hiddenDomains` **裁剪已建成的
 * 注册表**——裁剪放在最后，主会话/子代理/团队成员从同一份注册表派生，配置对三者一致生效。
 */

import { brandEnv, ENV_KEY } from "../env.js";
import type { KanbanBoardManager } from "../gateway/index.js";
import type { PluginRuntime } from "../extension/index.js";
import type { PilotConfigSnapshot } from "../pilot/config/types.js";
import { isBuiltinToolGroupEnabled, isOptionalFeatureEnabled } from "../pilot/config/optionalFeature.js";
import { detectPatentWorkspace, PATENT_DOMAIN } from "../pilot/workspace/patentSignals.js";
import { getPilotProjectChatDir } from "../shared/paths/pilotPaths.js";
import type { BackgroundTaskRuntime } from "../task/runtime/BackgroundTaskRuntime.js";
import { logger } from "../telemetry/index.js";
import { createBuiltinRegistry, type SatiToolDefinition, type ToolRegistry } from "../tool/index.js";
import type { TeamToolsOptions } from "../tool/builtin/team/index.js";
import type { ProjectMemoryLayer } from "./projectRuntimeKnowledge.js";

export type ProjectToolsLayer = {
  tools: ToolRegistry;
  patentVerdict: ReturnType<typeof detectPatentWorkspace>;
};

export type ProjectToolsDeps = {
  snapshot: PilotConfigSnapshot;
  projectRoot: string;
  pilotHome: string;
  env: Record<string, string | undefined>;
  backgroundTasks: BackgroundTaskRuntime;
  embeddingClient: ProjectMemoryLayer["embeddingClient"];
  memory: ProjectMemoryLayer["memory"];
  pluginRuntime: PluginRuntime;
  /** 取数：extraTools 可被 updateSubsystems 整体替换。 */
  getExtraTools: () => SatiToolDefinition[];
  /** 取数：team_* 工具装配由 setTeamTools 晚绑定。 */
  getTeamTools: () => TeamToolsOptions | undefined;
  /** 取数：kanban 装配由 setKanbanBoardManager 晚绑定。 */
  getKanbanBoardManager: () => KanbanBoardManager | undefined;
};

export function createProjectTools(deps: ProjectToolsDeps): ProjectToolsLayer {
  const { snapshot } = deps;
  const toolsConfig = snapshot.config.tools;
  const webSearchConfig = toolsConfig?.webSearch;
  const paperSearchConfig = toolsConfig?.paperSearch;

  // 内置工具组按需注册（tools.team / tools.kanban / tools.documentStyle）：
  // 段缺失 = 保持历史默认（注册），显式 enabled: false 才不注册——这三组是既有
  // 内置能力，默认翻转会让升级用户静默失去功能（与搜索工具的三态语义相反）。
  const teamTools = isBuiltinToolGroupEnabled(toolsConfig?.team) ? deps.getTeamTools() : undefined;
  const kanbanManager = isBuiltinToolGroupEnabled(toolsConfig?.kanban) ? deps.getKanbanBoardManager() : undefined;
  const tools = createBuiltinRegistry({
    ...(teamTools ? { team: teamTools } : {}),
    ...(kanbanManager ? { kanban: kanbanManager } : {}),
    backgroundTasks: { runtime: deps.backgroundTasks },
    searchPatentFigure: { embeddingClient: deps.embeddingClient },
    // 文书排版调参面板工具（opt-in：无参注册会破坏 llm-replay fixture 工具集匹配）
    ...(isBuiltinToolGroupEnabled(toolsConfig?.documentStyle) ? { documentStyle: {} } : {}),
    // knowledge_note_save 草稿闸门模式（WS2）：默认 draft；schema 不变、只改运行时行为
    knowledgeNoteSaveMode: snapshot.config.memory?.knowledgeNoteSaveMode,
    // J-Space 工作区工具（opt-in：与工作区账本开关联动，避免破坏 fixture 工具集匹配）
    workspaceLedgerTools: brandEnv(deps.env, ENV_KEY.WORKSPACE_LEDGER_ENABLED) === "1",
    ...(deps.memory?.service ? { memory: { service: deps.memory.service } } : {}),
    readSkill: {
      loader: name => deps.pluginRuntime.loadSkillPrompt(name),
      lister: () => deps.pluginRuntime.getAllSkills(),
    },
    // Pass the YAML-configured web-search provider through to the built-in
    // `web_search` tool. An absent or explicitly disabled section keeps search
    // out of the registry, even when provider credentials are available in the
    // environment（上游 #588）：未配置的搜索不再凭 GLM_WEB_SEARCH_API_KEY /
    // TAVILY_API_KEY 自我唤醒。
    ...(isOptionalFeatureEnabled(webSearchConfig)
      ? {
          webSearch: {
            ...(webSearchConfig.provider ? { provider: webSearchConfig.provider } : {}),
            ...(webSearchConfig.searchEngine ? { searchEngine: webSearchConfig.searchEngine } : {}),
            ...(webSearchConfig.apiKey ? { apiKey: webSearchConfig.apiKey } : {}),
            ...(webSearchConfig.endpoint ? { endpoint: webSearchConfig.endpoint } : {}),
            ...(webSearchConfig.customProvider ? { customProvider: webSearchConfig.customProvider } : {}),
          },
        }
      : { webSearch: false as const }),
    // Pass the YAML-configured literature sources through to the built-in
    // `paper_search` / `paper_list_sources` tools. Config shape matches
    // CreateLiteratureRegistryOptions; undefined fields fall back to defaults
    // (all sources enabled, free no-key).
    // 段缺失 = 关（上游 #588 语义外延到 paperSearch）：注意这不只影响两个 paper 工具，
    // `patent_workflow_run` 的多源检索以同一 registry 作为文献源，禁用后回退 nuo 单源。
    ...(isOptionalFeatureEnabled(paperSearchConfig)
      ? {
          paperSearch: {
            arxiv: paperSearchConfig.arxiv,
            openalex: paperSearchConfig.openalex,
            semanticScholar: paperSearchConfig.semanticScholar,
            crossref: paperSearchConfig.crossref,
            openalexMailto: paperSearchConfig.openalexMailto,
            semanticScholarApiKey: paperSearchConfig.semanticScholarApiKey,
          },
        }
      : { paperSearch: false as const }),
    // Pass the YAML-configured patents.downloadDir through to the built-in
    // `patent_pdf_download` tool (runtime-live: read at every execution).
    ...(snapshot.config.patents?.downloadDir
      ? { patentPdfDownload: { patentsConfigProvider: () => snapshot.config.patents } }
      : {}),
    // Pass the YAML-configured patents.modelHints through to
    // `patent_workflow_run` (judgeModels multi-judge consensus + per-node
    // model tiering). Absent → hints ignored, everything uses the session model.
    ...(snapshot.config.patents?.modelHints ? { patentModelHints: snapshot.config.patents.modelHints } : {}),
  });
  for (const tool of deps.getExtraTools()) {
    tools.register(tool);
  }

  // 工作区专利判据（#450 构件①）：patent 域是**工作区级**事实，而 tools 段是机器级配置。
  // 判据为否时把 `patent` 并入隐藏域——28 个专利工具（~13.7k tokens schema）不再推给
  // 每个非专利工作区；判据为是时行为与改动前逐字一致。显式 `tools.patentDomain` 最高优先。
  const patentVerdict = detectPatentWorkspace({
    projectRoot: deps.projectRoot,
    explicit: toolsConfig?.patentDomain,
    hasPatentsConfig: snapshot.config.patents !== undefined,
    projectChatsDir: getPilotProjectChatDir(deps.projectRoot, deps.pilotHome),
  });

  // 项目级工具域裁剪（tools.visibleDomains / tools.hiddenDomains）：注册表构建完成后
  // 统一收窄——主会话、子代理与团队成员会话都从这份注册表派生，配置对三者一致生效。
  // 域语义复用 `ToolRegistry.listByDomains`（hidden 优先；未标注 domain 的工具不受约束）。
  const visibleDomains = toolsConfig?.visibleDomains;
  const configuredHiddenDomains = toolsConfig?.hiddenDomains;
  const hiddenDomains = [...(configuredHiddenDomains ?? []), ...(patentVerdict.enabled ? [] : [PATENT_DOMAIN])];
  logger.info(
    `patent domain ${patentVerdict.enabled ? "enabled" : "hidden"} for ${deps.projectRoot} (signal: ${
      patentVerdict.signal
    }${patentVerdict.evidence ? `, evidence: ${patentVerdict.evidence}` : ""})`,
  );
  if (visibleDomains?.length || hiddenDomains.length) {
    const knownDomains = new Set<string>(
      tools
        .list()
        .map(tool => tool.domain)
        .filter(domain => domain !== undefined),
    );
    const kept = new Set(
      tools
        .listByDomains({
          visible: new Set(visibleDomains ?? []),
          hidden: new Set(hiddenDomains ?? []),
        })
        .map(tool => tool.name),
    );
    const removed = tools.list().filter(tool => !kept.has(tool.name));
    for (const tool of removed) {
      tools.unregister(tool.name);
    }
    if (removed.length > 0) {
      logger.info(
        `tools domain filter removed ${removed.length} tool(s): ${removed.map(tool => tool.name).join(", ")}`,
      );
    }
    // 配置的域没有任何工具命中：通常是拼写错误，或该域工具已被上游开关关闭。
    // 只检查**用户写的**域名：判据推导出的 `patent` 被上游开关关掉时不该报警（不是配置问题）。
    const unmatched = [...new Set([...(visibleDomains ?? []), ...(configuredHiddenDomains ?? [])])].filter(
      domain => !knownDomains.has(domain),
    );
    if (unmatched.length > 0) {
      logger.warn(`tools domain filter matched no tool for domain(s): ${unmatched.join(", ")}`);
    }
  }

  return { tools, patentVerdict };
}
