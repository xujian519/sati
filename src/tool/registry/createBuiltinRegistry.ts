import type { BackgroundTaskRuntime } from "../../task/runtime/BackgroundTaskRuntime.js";
import { createAgentTool, type CreateAgentToolOptions } from "../builtin/agent.js";
import { createAskUserQuestionTool } from "../builtin/askUserQuestion.js";
import { createBashTool, type CreateBashToolOptions } from "../builtin/bash.js";
import { createEditFileTool } from "../builtin/editFile.js";
import { createGlobTool } from "../builtin/glob.js";
import { createGrepTool } from "../builtin/grep.js";
import { createReadFileTool } from "../builtin/readFile.js";
import { createStructuredOutputTool } from "../builtin/structuredOutput.js";
import {
  createTaskCreateTool,
  createTaskListTool,
  createTaskOutputTool,
  createTaskStopTool,
} from "../builtin/taskTools.js";
import { createWebFetchTool, type CreateWebFetchToolOptions } from "../builtin/webFetch.js";
import { createWebSearchTool, type CreateWebSearchToolOptions } from "../builtin/webSearch.js";
import { createWriteFileTool } from "../builtin/writeFile.js";
import { ToolRegistry } from "./ToolRegistry.js";

export type CreateBuiltinRegistryOptions = {
  bash?: CreateBashToolOptions;
  /**
   * web_search defaults to the serp.hk provider (matches the openclaw
   * `serp-search` extension). Pass `false` to skip registering web_search;
   * pass an options object to customize apiKey / region / endpoint.
   *
   * When omitted the tool is registered with default options and reads the
   * API key from the `SERP_API_KEY` env var at execution time.
   */
  webSearch?: CreateWebSearchToolOptions | false;
  /**
   * `agent` subagent tool. **Opt-in** because it requires a model client at
   * execution time — the AgentLoop forwards the loop's model client through
   * `PolitDeckToolRuntimeContext.model`, but stand-alone tool runtimes (e.g.
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
   * `task_stop`). **Opt-in** — pass `{ runtime }` to register; absent or
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
   * `PolitDeckElicitationChannel` at execution time causes the tool to
   * return a runtime error rather than crash the loop. Pass `false` to
   * skip registration in headless contexts.
   */
  askUserQuestion?: false;
};

export function createBuiltinRegistry(options?: CreateBuiltinRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createGlobTool());
  registry.register(createGrepTool());
  registry.register(createEditFileTool());
  registry.register(createWriteFileTool());
  registry.register(createBashTool(options?.bash));
  if (options?.webSearch !== false) {
    registry.register(createWebSearchTool(options?.webSearch));
  }
  if (options?.webFetch !== false) {
    registry.register(createWebFetchTool(options?.webFetch));
  }
  if (options?.agent !== false) {
    const agentOpts = options?.agent === true || options?.agent === undefined ? undefined : options.agent;
    registry.register(createAgentTool(agentOpts));
  }
  if (options?.backgroundTasks) {
    const runtime = options.backgroundTasks.runtime;
    registry.register(createTaskCreateTool(runtime));
    registry.register(createTaskListTool(runtime));
    registry.register(createTaskOutputTool(runtime));
    registry.register(createTaskStopTool(runtime));
  }
  if (options?.structuredOutput !== false) {
    registry.register(createStructuredOutputTool());
  }
  if (options?.askUserQuestion !== false) {
    registry.register(createAskUserQuestionTool());
  }
  return registry;
}
