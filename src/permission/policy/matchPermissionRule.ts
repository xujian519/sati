import type { PermissionRule } from "../protocol/types.js";

export function matchPermissionRule(rule: PermissionRule, toolName: string): boolean {
  if (rule.toolName === toolName) {
    return true;
  }

  if (!rule.toolName.includes("*")) {
    return false;
  }

  return wildcardToRegExp(rule.toolName).test(toolName);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
