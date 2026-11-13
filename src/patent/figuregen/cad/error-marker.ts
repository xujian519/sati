/**
 * src/patent/figuregen/cad — 投影脚本的**失败标记常量**（单点事实源）。
 *
 * 脚本侧（`freecad-script.ts` 生成的 Python）与消费侧（`freecad.ts` 的
 * `describeCadFailure`）共用同一个常量 ⇒ 「脚本报了错」与「Sati 认得出这个错」不可能漂移。
 *
 * 为什么要单独成模块：`freecad.ts`（消费侧）与 `freecad-script.ts`（生成侧）互相引用
 * 会形成环 ⇒ 常量落在一个无依赖的小模块里，两边各自 import。
 */

/** 投影脚本的失败标记（`_fail` 写 stderr 的前缀）。 */
export const CAD_ERROR_MARKER = "SATI_CAD_ERROR:";
