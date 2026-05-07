import type { PermissionMode } from "../../../../src/permission/index.js";
import type { PolitDeckToolErrorCode } from "../../../../src/tool/index.js";

export type PolitDeckToolParityStatus =
  | "must_match"
  | "intentional_difference"
  | "deferred"
  | "not_applicable";

export type LegacyBehaviorSource = {
  path: string;
  symbol?: string;
  summary: string;
};

export type PolitDeckToolBehaviorScenario = {
  name: string;
  legacyToolName: string;
  politdeckToolName: string;
  input: unknown;
  permissionMode: PermissionMode;
  parity: PolitDeckToolParityStatus;
  source: LegacyBehaviorSource[];
  expectedDecision?: "allow" | "deny" | "ask" | "cancel";
  expectedResultType?: "success" | "error";
  expectedErrorCode?: PolitDeckToolErrorCode;
  expectedContentIncludes?: string[];
  expectedData?: unknown;
  intentionalDifferenceReason?: string;
  deferredUntil?: string;
  notes?: string;
};

export type PolitDeckIntentionalDifference = {
  id: string;
  legacyBehavior: string;
  politdeckBehavior: string;
  reason: string;
  risk: "lower" | "same" | "higher";
  reviewRequiredBeforeRelease: boolean;
};
