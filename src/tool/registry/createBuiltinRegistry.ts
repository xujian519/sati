import type { BackgroundTaskRuntime } from "../../task/runtime/BackgroundTaskRuntime.js";
import { createAgentTool, type CreateAgentToolOptions } from "../builtin/agent.js";
import { createAskUserQuestionTool } from "../builtin/askUserQuestion.js";
import { createBashTool, type CreateBashToolOptions } from "../builtin/bash.js";
import { createEditFileTool } from "../builtin/editFile.js";
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
import { createWriteFileTool } from "../builtin/writeFile.js";
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
   * `validate_specification`). Registered by default — pure read-only
   * deterministic tools. Pass `false` to keep them out of the registry.
   */
  patent?: false;
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
    registry.register(annotate(createPatentEvalTool(), "patent"));
    registry.register(annotate(createDraftClaimsTool(), "patent"));
    registry.register(annotate(createDraftSpecificationTool(), "patent"));
    registry.register(annotate(createValidateSpecificationTool(), "patent"));
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
