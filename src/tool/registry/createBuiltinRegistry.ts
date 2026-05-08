import { createAgentTool, type CreateAgentToolOptions } from "../builtin/agent.js";
import { createBashTool, type CreateBashToolOptions } from "../builtin/bash.js";
import { createEditFileTool } from "../builtin/editFile.js";
import { createGlobTool } from "../builtin/glob.js";
import { createGrepTool } from "../builtin/grep.js";
import { createReadFileTool } from "../builtin/readFile.js";
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
  if (options?.agent !== false) {
    const agentOpts = options?.agent === true || options?.agent === undefined ? undefined : options.agent;
    registry.register(createAgentTool(agentOpts));
  }
  return registry;
}
