/**
 * Methodology module — reasoning-methodology prompt injection.
 *
 * Adapted from XiaoNuo Agent's
 * `packages/agent-core/src/reasoning/super-engine/v2/methodology/` —
 * registration + keyword matching + prompt template rendering only. The full
 * PulseKernel engine, plugin ABI and MMS orchestration are NOT included.
 */

export type {
  MethodologyCategory,
  MethodologyDomain,
  MethodologyContext,
  MethodologyExecutionResult,
  MethodologyComponent,
  MethodologyMatch,
} from "./protocol/types.js";
export {
  MethodologyRegistry,
  DEFAULT_METHODOLOGY_COMPONENTS,
  extractMethodologyKeywords,
} from "./runtime/MethodologyRegistry.js";
export {
  injectMethodology,
  type MethodologyInjectionResult,
  type MethodologyInjectorOptions,
} from "./runtime/MethodologyInjector.js";
export { fiveWhys } from "./runtime/components/five-whys.js";
export { mece } from "./runtime/components/mece.js";
export { swot } from "./runtime/components/swot.js";
export { pdca } from "./runtime/components/pdca.js";
export { fishbone } from "./runtime/components/fishbone.js";
export { firstPrinciples } from "./runtime/components/first-principles.js";
export { sixHats } from "./runtime/components/six-hats.js";
