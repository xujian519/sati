import type { TokenBudgetSnapshot } from "../budget/TokenBudgetManager.js";

export type AutoCompactionDecision =
  | { type: "skip"; snapshot: TokenBudgetSnapshot }
  | { type: "warn"; snapshot: TokenBudgetSnapshot }
  | { type: "trigger"; snapshot: TokenBudgetSnapshot; reason: "warning_threshold" | "blocking_threshold" };

/**
 * Decides when the loop should call `CompactionEngine` proactively. Mirrors
 * legacy `autoCompactIfNeeded` thresholds (warn 80% / block 95%) but pushes
 * the actual model call out to AgentLoop (decision §3.2).
 */
export class AutoCompactionPolicy {
  evaluateSnapshot(snapshot: TokenBudgetSnapshot): AutoCompactionDecision {
    if (snapshot.state === "blocking") {
      return { type: "trigger", snapshot, reason: "blocking_threshold" };
    }
    if (snapshot.state === "warning") {
      return { type: "trigger", snapshot, reason: "warning_threshold" };
    }
    return { type: "skip", snapshot };
  }
}
