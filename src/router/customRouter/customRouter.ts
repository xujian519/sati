import type { RouterDecision, RouterDecisionInput } from "../protocol/decision.js";

export type CustomRouterContext = {
  sessionId: string;
  isMainAgent: boolean;
  scenarios: ReadonlyArray<string>;
};

export type CustomRouterDecideInput = RouterDecisionInput & {
  context: CustomRouterContext;
};

export type PolitDeckCustomRouter = {
  id: string;
  decide(input: CustomRouterDecideInput): Promise<Partial<RouterDecision> | undefined>;
};

export type CustomRouterRegistry = {
  lookupRouter(extensionId: string): PolitDeckCustomRouter | undefined;
};

export const noopCustomRouterRegistry: CustomRouterRegistry = {
  lookupRouter: () => undefined,
};
