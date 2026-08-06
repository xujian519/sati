import type { BackgroundTaskRuntime } from "../../task/runtime/BackgroundTaskRuntime.js";
import { createAgentTool, type CreateAgentToolOptions } from "../builtin/agent.js";
import { createAskUserQuestionTool } from "../builtin/askUserQuestion.js";
import { createBashTool, type CreateBashToolOptions } from "../builtin/bash.js";
import { createEditFileTool } from "../builtin/editFile.js";
import { createEgoBrowserTool, type CreateEgoBrowserToolOptions } from "../builtin/egoBrowser.js";
import { createEditNotebookTool } from "../builtin/editNotebook.js";
import { createExecuteCodeTool } from "../builtin/executeCode.js";
import { createGlobTool } from "../builtin/glob.js";
import { createGrepTool } from "../builtin/grep.js";
import { createGetCurrentTimeTool } from "../builtin/getCurrentTime.js";
import { createReadFileTool } from "../builtin/readFile.js";
import { createSendAttachmentTool } from "../builtin/sendAttachment.js";
import { createEnterPlanModeTool, createExitPlanModeTool } from "../builtin/planMode.js";
import { createStructuredOutputTool } from "../builtin/structuredOutput.js";
import { createTodoWriteTool } from "../builtin/todoWrite.js";
import {
  createTaskCreateTool,
  createTaskListTool,
  createTaskOutputTool,
  createTaskStopTool,
  createTaskWaitTool,
} from "../builtin/taskTools.js";
import { createWebFetchTool, type CreateWebFetchToolOptions } from "../builtin/webFetch.js";
import { createWebSearchTool, type CreateWebSearchToolOptions } from "../builtin/webSearch.js";
import { createReadSkillTool, type ReadSkillDeps } from "../builtin/readSkill.js";
import { createRuleCheckTool, type RuleCheckDeps } from "../builtin/ruleCheck.js";
import { createPatentEvalTool } from "../builtin/patentEval.js";
import { createDraftClaimsTool } from "../builtin/draftClaims.js";
import { createDraftSpecificationTool } from "../builtin/draftSpecification.js";
import { createValidateSpecificationTool } from "../builtin/validateSpecification.js";
import { createPatentWorkflowTool } from "../builtin/patentWorkflowTool.js";
import { createPatentWorkflowRunTool } from "../builtin/patentWorkflowRunTool.js";
import { createPatentPlanTaskTool } from "../builtin/patentPlanTaskTool.js";
import { createPatentMetadataTool } from "../builtin/patentMetadata.js";
import { createPatentLegalStatusTool } from "../builtin/patentLegalStatus.js";
import { createPatentSearchTool } from "../builtin/patentSearch.js";
import { registerBuiltinAtoms } from "../../patent/atoms/index.js";
import { createPatentWorkerValidateTool } from "../builtin/patentWorkerValidateTool.js";
import { createPatentWikiSearchTool } from "../builtin/patentWikiSearch.js";
import { createPatentKgQueryTool } from "../builtin/patentKgQuery.js";
import { createAnalyzePatentFigureTool } from "../builtin/analyzePatentFigure.js";
import { createSearchPatentFigureTool } from "../builtin/searchPatentFigure.js";
import { createEvaluateEvidenceTool } from "../builtin/evaluateEvidence.js";
import { createWriteFileTool } from "../builtin/writeFile.js";
import { createLawSearchTool } from "../../knowledge/legal/law-search-tool.js";
import type { EmbeddingClient } from "../../model/embedding/index.js";
import {
  createLiteratureRegistry,
  createPaperListSourcesTool,
  createPaperSearchTool,
  type CreateLiteratureRegistryOptions,
} from "../../literature/index.js";
import type { SatiToolDefinition, ToolDomain } from "../protocol/types.js";
import { ToolRegistry } from "./ToolRegistry.js";

/** 标注工具业务域（工具定义处未标注时使用注册表集中标注）。 */
function annotate(tool: SatiToolDefinition, domain: ToolDomain): SatiToolDefinition {
  return tool.domain === undefined ? { ...tool, domain } : tool;
}

export type CreateBuiltinRegistryOptions = {
  bash?: CreateBashToolOptions;
  /**
   * `web_search` defaults to the GLM/Z.AI provider. Pass `false` to skip
   * registering web_search; pass an options object to select GLM or Tavily
   * and customize apiKey / endpoint.
   */
  webSearch?: CreateWebSearchToolOptions | false;
  /**
   * `agent` subagent tool. **Opt-in** because it requires a model client at
   * execution time — the AgentLoop forwards the loop's model client through
   * `SatiToolRuntimeContext.model`, but stand-alone tool runtimes (e.g.
   * tests) may not have one. Pass `true` (default) to register; pass `false`
   * to skip; pass an options object to customize the subagent presets or
   * lock the provider/model.
   */
  agent?: CreateAgentToolOptions | boolean;
  /**
   * `web_fetch` builtin tool. **Opt-in** (default: registered) because it
   * issues HTTP requests and a secondary model call. Pass `false` to skip.
   * Pass an options object to override the provider / model id used for the
   * secondary model call. Without a model client the tool returns the raw
   * markdown without summarization.
   */
  webFetch?: CreateWebFetchToolOptions | false;
  /**
   * `ego_browser` builtin tool (drives the ego-browser CLI / ego lite real
   * Chromium). Registered by default on macOS; the tool's `checkAvailability`
   * filters it out when the ego-browser CLI is not installed. Pass `false` to
   * skip registration entirely.
   */
  egoBrowser?: CreateEgoBrowserToolOptions | false;
  /**
   * Background task tools (`task_create` / `task_list` / `task_output` /
   * `task_wait` / `task_stop`). **Opt-in** — pass `{ runtime }` to register; absent or
   * `false` keeps them out of the registry. Stand-alone runtimes that do
   * not provide a `BackgroundTaskRuntime` would otherwise see every call
   * fail with `unsupported_tool`.
   */
  backgroundTasks?: { runtime: BackgroundTaskRuntime } | false;
  /**
   * `structured_output` builtin (A3). Registered by default — the tool is
   * inert without a model client requesting it via `tool_choice`, but the
   * registry must contain it so non-interactive hosts can opt in. Pass
   * `false` to skip.
   */
  structuredOutput?: false;
  /**
   * `ask_user_question` builtin (B1). Registered by default; an absent
   * `SatiElicitationChannel` at execution time causes the tool to
   * return a runtime error rather than crash the loop. Pass `false` to
   * skip registration in headless contexts.
   */
  askUserQuestion?: false;
  /**
   * `read_skill` builtin. **Opt-in** — pass `{ loader, lister }` to
   * register; absent or `false` keeps it out of the registry. The loader
   * fetches skill content by name; the lister enumerates available skill
   * names for the "not found" diagnostic message.
   */
  readSkill?: ReadSkillDeps | false;
  /**
   * `enter_plan_mode` / `exit_plan_mode` builtins. Registered by default —
   * these lightweight skeleton tools let the model request a permission-mode
   * switch to plan (read-only) and back. Pass `false` to skip.
   */
  planMode?: false;
  /**
   * `rule_check` builtin (constitutional rule engine). Registered by default —
   * read-only deterministic check over the bundled rule assets. Pass `false`
   * to skip, or pass `{ loader }` to supply a custom scope→RuleSet loader.
   */
  ruleCheck?: RuleCheckDeps | false;
  /**
   * Patent-domain tools (`patent_eval` / `draft_claims` / `draft_specification` /
   * `validate_specification` / `patent_wiki_search` / `analyze_patent_figure` /
   * `search_patent_figure`). Registered by default — pure read-only
   * deterministic tools. Pass `false` to keep them out of the registry.
   */
  patent?: false;
  /**
   * `search_patent_figure` builtin（附图检索）。Registered by default — pure
   * read-only retrieval over the figure analysis index
   * (`.sati/figures-index.json`). Pass `{ embeddingClient }` to enable
   * hybrid keyword + vector retrieval; absent → keyword-only.
   */
  searchPatentFigure?: { embeddingClient?: EmbeddingClient };
  /**
   * Legal-domain tools (`law_search` — 中国法律法规全文检索，宝宸知识库）。
   * Registered by default. 数据库缺失时工具返回 setup_required 状态。
   * Pass `false` to keep them out of the registry.
   */
  legal?: false;
  /**
   * Literature-domain tools (`paper_search` / `paper_list_sources` — 学术论文
   * 检索，免费无 key）。Registered by default：arXiv / OpenAlex / Semantic
   * Scholar / Crossref 全部零配置可用。Pass `false` 关闭；传配置对象可
   * 按源开关 / 设置 OpenAlex polite pool 邮箱 / Semantic Scholar 提额 key。
   */
  paperSearch?: CreateLiteratureRegistryOptions | false;
};

export function createBuiltinRegistry(options?: CreateBuiltinRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(annotate(createGetCurrentTimeTool(), "session"));
  registry.register(annotate(createReadFileTool(), "filesystem"));
  registry.register(annotate(createSendAttachmentTool(), "session"));
  registry.register(annotate(createGlobTool(), "filesystem"));
  registry.register(annotate(createGrepTool(), "filesystem"));
  registry.register(annotate(createEditFileTool(), "filesystem"));
  registry.register(annotate(createEditNotebookTool(), "filesystem"));
  registry.register(annotate(createWriteFileTool(), "filesystem"));
  registry.register(annotate(createBashTool(options?.bash), "shell"));
  registry.register(
    annotate(
      createExecuteCodeTool({
        webSearch: options?.webSearch !== false,
      }),
      "shell",
    ),
  );
  if (options?.webSearch !== false) {
    registry.register(annotate(createWebSearchTool(options?.webSearch), "search"));
  }
  if (options?.webFetch !== false) {
    registry.register(annotate(createWebFetchTool(options?.webFetch), "network"));
  }
  if (options?.egoBrowser !== false) {
    registry.register(annotate(createEgoBrowserTool(options?.egoBrowser), "network"));
  }
  if (options?.agent !== false) {
    const agentOpts = options?.agent === true || options?.agent === undefined ? undefined : options.agent;
    registry.register(annotate(createAgentTool(agentOpts), "agent"));
  }
  if (options?.backgroundTasks) {
    const runtime = options.backgroundTasks.runtime;
    registry.register(annotate(createTaskCreateTool(runtime), "session"));
    registry.register(annotate(createTaskListTool(runtime), "session"));
    registry.register(annotate(createTaskOutputTool(runtime), "session"));
    registry.register(annotate(createTaskWaitTool(runtime), "session"));
    registry.register(annotate(createTaskStopTool(runtime), "session"));
  }
  if (options?.structuredOutput !== false) {
    registry.register(annotate(createStructuredOutputTool(), "custom"));
  }
  if (options?.askUserQuestion !== false) {
    registry.register(annotate(createAskUserQuestionTool(), "session"));
  }
  if (options?.planMode !== false) {
    registry.register(annotate(createEnterPlanModeTool(), "session"));
    registry.register(annotate(createExitPlanModeTool(), "session"));
  }
  registry.register(annotate(createTodoWriteTool(), "session"));
  if (options?.patent !== false) {
    // 内置 Pipeline 原子（Atom 契约 + StageHandler）装配：幂等，同名覆盖。
    registerBuiltinAtoms();
    registry.register(annotate(createPatentEvalTool(), "patent"));
    registry.register(annotate(createDraftClaimsTool(), "patent"));
    registry.register(annotate(createDraftSpecificationTool(), "patent"));
    registry.register(annotate(createValidateSpecificationTool(), "patent"));
    registry.register(annotate(createPatentWorkflowTool(), "patent"));
    registry.register(annotate(createPatentWorkflowRunTool(), "patent"));
    registry.register(annotate(createPatentPlanTaskTool(), "patent"));
    registry.register(annotate(createPatentWorkerValidateTool(), "patent"));
    registry.register(annotate(createEvaluateEvidenceTool(), "patent"));
    registry.register(annotate(createPatentMetadataTool(), "patent"));
    registry.register(annotate(createPatentLegalStatusTool(), "patent"));
    registry.register(annotate(createPatentSearchTool(), "patent"));
    registry.register(annotate(createPatentWikiSearchTool(), "patent"));
    registry.register(annotate(createPatentKgQueryTool(), "patent"));
    registry.register(annotate(createAnalyzePatentFigureTool(), "patent"));
    registry.register(
      annotate(
        createSearchPatentFigureTool({ embeddingClient: options?.searchPatentFigure?.embeddingClient }),
        "patent",
      ),
    );
  }
  if (options?.legal !== false) {
    registry.register(annotate(createLawSearchTool(), "legal"));
  }
  if (options?.paperSearch !== false) {
    // 学术文献检索：两个工具共享同一注册表实例。外层条件已排除 false，
    // 此处类型为 CreateLiteratureRegistryOptions | undefined。
    const literatureOptions = options?.paperSearch;
    const literatureRegistry = createLiteratureRegistry(literatureOptions);
    registry.register(annotate(createPaperListSourcesTool({ registry: literatureRegistry }), "literature"));
    registry.register(annotate(createPaperSearchTool({ registry: literatureRegistry }), "literature"));
  }
  if (options?.ruleCheck !== false) {
    registry.register(
      annotate(createRuleCheckTool(options?.ruleCheck === undefined ? undefined : options.ruleCheck), "quality"),
    );
  }
  if (options?.readSkill) {
    registry.register(annotate(createReadSkillTool(options.readSkill), "session"));
  }
  return registry;
}
