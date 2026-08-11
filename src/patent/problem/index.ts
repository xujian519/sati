/**
 * src/patent/problem — 原子化技术问题模块 barrel。
 *
 * 当前含四检验纯函数（checkAtomic）、技术问题片段提取（extractTechnicalProblem）
 * 与规则 customCheck 工厂（technicalProblemCheck），供 checker 规则与 PFE 提取
 * 阶段复用；后续如需穷举/语义合并/孤儿校验等能力，在此追加导出（见
 * docs/problem-atomization-minimal-plan.md 的后续扩展节）。
 */

export {
  checkAtomic,
  extractTechnicalProblem,
  technicalProblemCheck,
  type AtomicCheckResult,
  type AtomicChecks,
} from "./atomicChecker.js";
