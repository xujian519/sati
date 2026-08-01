/**
 * MethodologyInjector — decide whether to inject a methodology prompt into a
 * system message, and produce the prompt text.
 */

import type { MethodologyContext, MethodologyDomain, MethodologyMatch } from "../protocol/types.js";
import { MethodologyRegistry, extractMethodologyKeywords } from "./MethodologyRegistry.js";

export type MethodologyInjectionResult = {
  /** True when a methodology was matched and a prompt is available. */
  applied: boolean;
  /** Name of the matched component. */
  methodologyName?: string;
  /** The prompt text to append to the system message. */
  prompt?: string;
  /** Matched components with scores (for diagnostics). */
  matches: MethodologyMatch[];
};

export type MethodologyInjectorOptions = {
  /** Minimum identify() score for a component to be considered. Default 0. */
  minScore?: number;
  /** Restrict matching to a domain. */
  domain?: MethodologyDomain;
};

/**
 * Match the strongest methodology for a user input and render its injection
 * prompt. Returns `applied: false` when nothing scores above the threshold.
 */
export function injectMethodology(
  registry: MethodologyRegistry,
  goal: string,
  options: MethodologyInjectorOptions = {},
): MethodologyInjectionResult {
  const context: MethodologyContext = {
    goal,
    keywords: extractMethodologyKeywords(goal),
  };
  const matches = registry.match(context, {
    topK: 1,
    minScore: options.minScore ?? 0,
    domain: options.domain,
  });
  if (matches.length === 0) {
    return { applied: false, matches: [] };
  }
  const top = matches[0]!;
  const executed = top.component.execute(context);
  return {
    applied: true,
    methodologyName: top.component.name,
    prompt: executed.prompt,
    matches,
  };
}
