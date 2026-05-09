import type { PermissionMode } from "../../../../src/permission/index.js";
import type { PilotDeckToolErrorCode } from "../../../../src/tool/index.js";

export type PilotDeckToolParityStatus =
  | "must_match"
  | "intentional_difference"
  | "deferred"
  | "not_applicable";

export type LegacyBehaviorSource = {
  path: string;
  symbol?: string;
  summary: string;
};

export type PilotDeckToolBehaviorScenario = {
  name: string;
  legacyToolName: string;
  pilotdeckToolName: string;
  input: unknown;
  permissionMode: PermissionMode;
  parity: PilotDeckToolParityStatus;
  source: LegacyBehaviorSource[];
  expectedDecision?: "allow" | "deny" | "ask" | "cancel";
  expectedResultType?: "success" | "error";
  expectedErrorCode?: PilotDeckToolErrorCode;
  expectedContentIncludes?: string[];
  expectedData?: unknown;
  intentionalDifferenceReason?: string;
  deferredUntil?: string;
  notes?: string;
};

export type PilotDeckIntentionalDifference = {
  id: string;
  legacyBehavior: string;
  pilotdeckBehavior: string;
  reason: string;
  risk: "lower" | "same" | "higher";
  reviewRequiredBeforeRelease: boolean;
};
