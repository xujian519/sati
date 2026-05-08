export type PolitDeckPermissionHookDecision =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: unknown[];
    }
  | {
      behavior: "deny";
      message?: string;
      interrupt?: boolean;
    };

export type PolitDeckHookSpecificOutput = {
  hookEventName: string;
  additionalContext?: string;
  initialUserMessage?: string;
  watchPaths?: string[];
  permissionDecision?: "allow" | "deny" | "ask" | "passthrough";
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  updatedMCPToolOutput?: unknown;
  decision?: PolitDeckPermissionHookDecision;
  retry?: boolean;
};

export type PolitDeckHookSyncOutput = {
  type: "sync";
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  reason?: string;
  systemMessage?: string;
  specific?: PolitDeckHookSpecificOutput;
  raw?: unknown;
};

export type PolitDeckHookAsyncOutput = {
  type: "async";
  raw?: unknown;
};

export type PolitDeckHookOutput = PolitDeckHookSyncOutput | PolitDeckHookAsyncOutput;
