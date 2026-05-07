import type { AgentParityStatus } from "./contractScenarios.js";

export type AgentExecutionScenario = {
  id: string;
  status: AgentParityStatus;
  feature: string;
  reason?: string;
};

export const agentExecutionScenarios: AgentExecutionScenario[] = [
  {
    id: "agent-exec-no-tool-turn",
    status: "compare",
    feature: "no-tool scripted model turn completes successfully",
  },
  {
    id: "agent-exec-tool-continuation",
    status: "compare",
    feature: "scripted tool call executes and produces a follow-up request",
  },
  {
    id: "agent-exec-project-resume",
    status: "compare",
    feature: "project JSONL transcript can rebuild main session messages",
  },
  {
    id: "agent-exec-fallback-model",
    status: "compare",
    feature: "retryable model error can switch to fallback model once",
  },
  {
    id: "agent-exec-streaming-tools",
    status: "deferred",
    feature: "tool execution while model stream is still open",
    reason: "PolitDeck main agent currently uses the sequential tool scheduler after assistant message assembly.",
  },
  {
    id: "agent-exec-hooks",
    status: "deferred",
    feature: "pre/post/stop hooks affect continuation",
    reason: "Hooks belong to the extension phase and are not part of main agent core.",
  },
];
