/**
 * Methodology protocol types — the contract for reasoning-methodology prompt
 * injection.
 *
 * Adapted from XiaoNuo Agent's
 * `packages/agent-core/src/reasoning/super-engine/v2/methodology/types/`.
 * Each component is a pure rule implementation: `identify()` scores how well
 * the methodology fits a task, `execute()` produces a structured prompt
 * template (no LLM calls). The LLM performs the actual reasoning once the
 * prompt is injected into the system message.
 */

export type MethodologyCategory = "analytical" | "classical" | "creative" | "dialectical";

/** Domain tags used for applicability filtering. */
export type MethodologyDomain = "patent" | "legal" | "coding" | "general";

export type MethodologyContext = {
  /** The user's task/goal text. */
  goal: string;
  /** Lowercased keyword tokens extracted from the goal. */
  keywords: string[];
};

export type MethodologyExecutionResult = {
  /** The structured prompt text to inject. */
  prompt: string;
};

export interface MethodologyComponent {
  /** Stable identifier, e.g. "five-whys". */
  name: string;
  /** One-line description shown to the model. */
  description: string;
  category: MethodologyCategory;
  /** Domains the methodology applies to. */
  applicableDomains: MethodologyDomain[];
  /** Optional prerequisite component names (informational only). */
  dependencies?: string[];

  /** Match score in [0, 1] — how well this methodology fits the task. */
  identify(context: MethodologyContext): number;
  /** Produce the injection prompt for the task. */
  execute(context: MethodologyContext): MethodologyExecutionResult;
}

export type MethodologyMatch = {
  component: MethodologyComponent;
  score: number;
};
