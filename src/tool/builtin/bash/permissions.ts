import type { PermissionResult } from "../../../permission/index.js";

const DENY_PATTERNS: RegExp[] = [
  /\brm\s+-[^&|;]*r[^&|;]*f\s+\//,
  /\bsudo\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bchown\s+-R\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[^\s]*f/,
  /\bdd\s+if=/,
  /\b(curl|wget)\b[^|;&]*\|\s*(sh|bash)\b/,
];

const SAFE_READ_PATTERNS: RegExp[] = [
  /^\s*pwd\s*$/,
  /^\s*ls(?:\s|$)/,
  /^\s*git\s+status(?:\s|$)/,
  /^\s*git\s+diff(?:\s|$)/,
  /^\s*git\s+log(?:\s|$)/,
  /^\s*printf(?:\s|$)/,
  /^\s*echo(?:\s|$)/,
  /^\s*node\s+-e\s+/,
  /^\s*sh\s+-c\s+["']exit\s+\d+["']\s*$/,
];

export function classifyBashPermission(command: string): PermissionResult {
  if (DENY_PATTERNS.some((pattern) => pattern.test(command))) {
    return {
      type: "deny",
      reason: { type: "safety", message: "Dangerous shell command denied." },
      message: "Dangerous shell command denied.",
    };
  }

  if (isReadOnlyShellCommand(command)) {
    return { type: "passthrough" };
  }

  return {
    type: "ask",
    reason: { type: "tool", toolName: "bash", message: "Shell command may have side effects." },
    request: {
      toolCallId: "",
      toolName: "bash",
      inputSummary: command,
      reason: { type: "tool", toolName: "bash", message: "Shell command may have side effects." },
      options: [
        { id: "allow_once", label: "Allow once" },
        { id: "deny", label: "Deny" },
        { id: "cancel", label: "Cancel" },
      ],
    },
  };
}

export function isReadOnlyShellCommand(command: string): boolean {
  return SAFE_READ_PATTERNS.some((pattern) => pattern.test(command));
}
