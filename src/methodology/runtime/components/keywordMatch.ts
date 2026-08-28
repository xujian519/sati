/**
 * Shared keyword-matching helpers for methodology components.
 * Pure rule scoring — no LLM calls.
 */

import type { MethodologyContext } from "../../protocol/types.js";

/**
 * Score in [0, 1] = matched trigger tokens / total trigger tokens.
 * Case-insensitive; single-token triggers count as partial matches.
 */
export function keywordScore(context: MethodologyContext, triggers: readonly string[]): number {
  if (triggers.length === 0) return 0;
  const haystack = context.goal.toLowerCase();
  let matched = 0;
  for (const trigger of triggers) {
    if (haystack.includes(trigger.toLowerCase())) matched++;
  }
  return matched / triggers.length;
}
