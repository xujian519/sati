export type SatiPermissionHookDecision =
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

export type SatiHookSpecificOutput = {
  hookEventName: string;
  additionalContext?: string;
  initialUserMessage?: string;
  watchPaths?: string[];
  permissionDecision?: "allow" | "deny" | "ask" | "passthrough";
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  updatedMCPToolOutput?: unknown;
  decision?: SatiPermissionHookDecision;
  retry?: boolean;
  worktreePath?: string;
};

export type SatiHookSyncOutput = {
  type: "sync";
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  reason?: string;
  systemMessage?: string;
  specific?: SatiHookSpecificOutput;
  raw?: unknown;
};

export type SatiHookAsyncOutput = {
  type: "async";
  raw?: unknown;
};

export type SatiHookOutput = SatiHookSyncOutput | SatiHookAsyncOutput;
