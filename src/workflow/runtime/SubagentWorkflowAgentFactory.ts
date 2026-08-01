/**
 * Sati-side implementation of {@link WorkflowAgentFactory} — bridges the
 * workflow engine to `SubAgentSession`. Each step runs as a subagent fork
 * with a per-step directive (the resolved input template) and a system prompt
 * from the worker definition.
 */

import { SubAgentSession, type SubagentReport } from "../../agent/sub/SubAgentSession.js";
import type { AgentRuntimeConfig } from "../../agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../agent/runtime/AgentRuntimeDependencies.js";
import type { WorkflowAgentFactory, WorkflowStepOutput } from "../protocol/types.js";

export type SubagentWorkflowAgentFactoryOptions = {
  parentConfig: AgentRuntimeConfig;
  parentDependencies: AgentRuntimeDependencies;
  parentSessionId: string;
  parentTurnId: string;
  /** Factory for fresh session/turn ids; defaults to a random hex suffix. */
  createSubagentIds?: () => { subagentSessionId: string; subagentId: string };
};

/**
 * Create a {@link WorkflowAgentFactory} that runs each workflow step through
 * `SubAgentSession` (reusing the parent's router, tool registry, permission
 * runtime and transcript writer).
 */
export function createSubagentWorkflowAgentFactory(options: SubagentWorkflowAgentFactoryOptions): WorkflowAgentFactory {
  const createIds =
    options.createSubagentIds ??
    (() => {
      const suffix = Math.random().toString(36).slice(2, 10);
      return {
        subagentSessionId: `wf-${suffix}`,
        subagentId: `wf-sub-${suffix}`,
      };
    });

  return config => {
    let session: SubAgentSession | undefined;
    let ran = false;
    return {
      prompt: async (input: string, signal?: AbortSignal): Promise<WorkflowStepOutput> => {
        if (ran) {
          // One-shot: a step agent runs exactly one prompt.
          throw new Error("Workflow step agent already ran its prompt");
        }
        ran = true;
        const { subagentSessionId, subagentId } = createIds();
        session = new SubAgentSession({
          definition: {
            id: "general-purpose",
            description: config.systemPrompt.slice(0, 120),
            allowedTools: config.allowedTools ?? ["*"],
            omitProjectInstructions: false,
            omitGitStatus: false,
            isReadOnly: false,
            systemPromptSuffix: config.systemPrompt,
          },
          directive: input,
          parentConfig: options.parentConfig,
          parentDependencies: options.parentDependencies,
          parentSessionId: options.parentSessionId,
          parentTurnId: options.parentTurnId,
          subagentSessionId,
          subagentId,
          abortSignal: signal,
        });
        const report: SubagentReport = await session.run();
        return {
          summary: report.markdown,
          data: { usage: report.usage, turns: report.turns },
          artifacts: [],
        };
      },
      destroy: () => {
        session = undefined;
      },
    };
  };
}
