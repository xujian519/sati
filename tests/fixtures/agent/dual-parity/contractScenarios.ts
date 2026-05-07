export type AgentParityStatus = "compare" | "intentional_difference" | "deferred" | "not_applicable";

export type AgentContractScenario = {
  id: string;
  status: AgentParityStatus;
  feature: string;
  compareFields: Array<
    | "eventTypes"
    | "terminalStatus"
    | "stopReason"
    | "turnCount"
    | "modelRequestCount"
    | "toolResultPairing"
    | "permissionDenialCount"
  >;
  reason?: string;
};

export const agentContractScenarios: AgentContractScenario[] = [
  {
    id: "agent-no-tool-turn",
    status: "compare",
    feature: "single model response without tools",
    compareFields: ["eventTypes", "terminalStatus", "stopReason", "turnCount", "modelRequestCount"],
  },
  {
    id: "agent-single-tool-continuation",
    status: "compare",
    feature: "assistant tool call, tool_result projection, follow-up model request",
    compareFields: ["eventTypes", "terminalStatus", "stopReason", "toolResultPairing", "modelRequestCount"],
  },
  {
    id: "agent-project-jsonl-resume",
    status: "compare",
    feature: "accepted input and durable messages survive project transcript resume",
    compareFields: ["eventTypes", "terminalStatus"],
  },
  {
    id: "agent-context-compaction-advanced",
    status: "deferred",
    feature: "snip, microcompact, autocompact and context collapse",
    compareFields: ["eventTypes"],
    reason: "PolitDeck currently has a bounded NullContextRuntime; advanced compaction remains a context phase.",
  },
  {
    id: "agent-subagent-fork",
    status: "deferred",
    feature: "forked/subagent loop with sidechain transcript",
    compareFields: ["eventTypes"],
    reason: "Subagent/fork runtime is intentionally outside the complete main-agent core checkpoint.",
  },
  {
    id: "agent-remote-bridge",
    status: "not_applicable",
    feature: "legacy bridge/CCR transport integration inside query runtime",
    compareFields: ["eventTypes"],
    reason: "PolitDeck keeps remote transport as an adapter layer rather than main agent core behavior.",
  },
];
