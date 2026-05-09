import type { CanonicalMessage } from "../../model/index.js";
import type { RouterModelRef, RouterScenariosConfig } from "../config/schema.js";
import type { RouterDecisionInput, RouterScenarioType } from "../protocol/decision.js";
import { decideLongContext } from "./longContextThreshold.js";
import { detectSubagent } from "./subagentDetector.js";

export type ScenarioResolution = {
  scenarioType: RouterScenarioType;
  selection: RouterModelRef | undefined;
  isSubagent: boolean;
  subagentModelHint?: string;
  longContextMatched: boolean;
};

const HAIKU_BACKGROUND_PATTERN = /haiku/i;

export function decideScenario(
  input: RouterDecisionInput,
  scenarios: RouterScenariosConfig,
): ScenarioResolution {
  const { request, isMainAgent, metadata } = input;
  const explicit = readExplicit(input);
  if (explicit) {
    return {
      scenarioType: "explicit",
      selection: explicit,
      isSubagent: !isMainAgent,
      longContextMatched: false,
    };
  }

  const subagent = detectSubagent(request.messages, request.tools, isMainAgent);
  const isSubagent = subagent.isSubagent;

  const messages: CanonicalMessage[] = request.messages;
  const longContext = decideLongContext(
    {
      tokenCount: typeof metadata?.lastUsage?.totalTokens === "number"
        ? metadata.lastUsage.totalTokens
        : undefined,
      lastUsageInputTokens: metadata?.lastUsage?.inputTokens,
    },
    scenarios.longContextThreshold,
    messages,
  );
  if (longContext.matched && scenarios.longContext) {
    return {
      scenarioType: "longContext",
      selection: scenarios.longContext,
      isSubagent,
      subagentModelHint: subagent.modelHint,
      longContextMatched: true,
    };
  }

  if (subagent.modelHint) {
    return {
      scenarioType: "subagent",
      selection: undefined,
      isSubagent: true,
      subagentModelHint: subagent.modelHint,
      longContextMatched: longContext.matched,
    };
  }

  if (HAIKU_BACKGROUND_PATTERN.test(request.model) && scenarios.background) {
    return {
      scenarioType: "background",
      selection: scenarios.background,
      isSubagent,
      longContextMatched: false,
    };
  }

  const webSearchHint = readBooleanMetadata(request.metadata, "webSearch");
  if (webSearchHint && scenarios.webSearch) {
    return {
      scenarioType: "webSearch",
      selection: scenarios.webSearch,
      isSubagent,
      longContextMatched: false,
    };
  }

  if (request.thinking?.enabled && scenarios.think) {
    return {
      scenarioType: "think",
      selection: scenarios.think,
      isSubagent,
      longContextMatched: false,
    };
  }

  return {
    scenarioType: "default",
    selection: scenarios.default,
    isSubagent,
    subagentModelHint: subagent.modelHint,
    longContextMatched: false,
  };
}

function readBooleanMetadata(metadata: Record<string, unknown> | undefined, key: string): boolean {
  if (!metadata) {
    return false;
  }
  return metadata[key] === true;
}

function readExplicit(input: RouterDecisionInput): RouterModelRef | undefined {
  const provider = input.metadata?.explicitProvider;
  const model = input.metadata?.explicitModel;
  if (provider && model) {
    return { id: `${provider}/${model}`, provider, model };
  }
  return undefined;
}
