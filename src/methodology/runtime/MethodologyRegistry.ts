/**
 * MethodologyRegistry — registration and keyword-based matching of
 * methodology components.
 *
 * Adapted from XiaoNuo Agent's `methodology-registry.ts` (registration +
 * match logic only; no orchestration/planning).
 */

import type {
  MethodologyComponent,
  MethodologyContext,
  MethodologyDomain,
  MethodologyMatch,
} from "../protocol/types.js";
import { fiveWhys } from "./components/five-whys.js";
import { mece } from "./components/mece.js";
import { swot } from "./components/swot.js";
import { pdca } from "./components/pdca.js";
import { fishbone } from "./components/fishbone.js";
import { firstPrinciples } from "./components/first-principles.js";
import { sixHats } from "./components/six-hats.js";
import { triz } from "./components/triz.js";
import { bridgeReencode } from "./components/bridge-reencode.js";

/** Default component set covering the core analytical/classical scenarios. */
export const DEFAULT_METHODOLOGY_COMPONENTS: MethodologyComponent[] = [
  fiveWhys,
  mece,
  swot,
  pdca,
  fishbone,
  firstPrinciples,
  sixHats,
  triz,
  bridgeReencode,
];

export class MethodologyRegistry {
  private readonly components = new Map<string, MethodologyComponent>();

  constructor(components: MethodologyComponent[] = DEFAULT_METHODOLOGY_COMPONENTS) {
    for (const component of components) {
      this.register(component);
    }
  }

  register(component: MethodologyComponent): void {
    if (this.components.has(component.name)) {
      throw new Error(`Methodology "${component.name}" is already registered`);
    }
    this.components.set(component.name, component);
  }

  /**
   * Match components against a context, scored by `identify()` and filtered
   * by applicable domain. Returns the top-K matches above `minScore`,
   * highest score first.
   */
  match(
    context: MethodologyContext,
    options: { topK?: number; minScore?: number; domain?: MethodologyDomain } = {},
  ): MethodologyMatch[] {
    const { topK = 1, minScore = 0, domain } = options;
    const scored: MethodologyMatch[] = [];
    for (const component of this.components.values()) {
      if (domain && !component.applicableDomains.includes(domain)) continue;
      const score = component.identify(context);
      if (score > minScore) scored.push({ component, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Whether a component with the given name is registered. */
  has(name: string): boolean {
    return this.components.has(name);
  }

  list(): MethodologyComponent[] {
    return [...this.components.values()];
  }
}

/** Extract lowercased keyword tokens from a goal string (word/segment based). */
export function extractMethodologyKeywords(goal: string): string[] {
  const words = goal.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return [...new Set(words)];
}
