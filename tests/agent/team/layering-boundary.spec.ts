/**
 * 分层判据（#363 / `TD-TEAM-N06`）：**通用团队层不得依赖专利业务域**。
 *
 * 为什么需要这条判据：`agent/team` 的 22 个文件里 21 个只依赖 `node:*`、`gateway/protocol`、
 * `telemetry` 与自身，唯独 `scheduler.ts` 反向 import 了 `src/patent/worker-contract.js`
 * （`WorkerRegistry` + `workerAllowedForRole`）。这条边不是设计出来的，是移植时顺手带进来的
 * （`worker-contract.ts` 自述「移植自 Mady agentcore/worker/contract.go」，属专利域单元），
 * 于是任何团队（含非专利团队）的派发都被强制走专利 worker 的 tier 校验。收敛去掉它之后，
 * 没有判据的话下一次「顺手 import」会原样回来。
 *
 * 判据形态：**扫真实源码树**（不是 dist 产物）。理由有二：
 * 1. `import type` 在编译后**被擦除** ⇒ 只看 `.js` 产物看不见类型层的反向依赖
 *    （本目录的耦合恰恰就是 `import type` 形态）；`.d.ts` 虽有，但两种布局的扩展名不同，
 *    读源码树一次就够，且两种运行布局（tsx 直跑 `tests/` / `pnpm test` 跑 `dist/tests/`）
 *    下 `repoRoot()` 都指回同一棵树，判据只有一份。
 * 2. 判据文本是**模块依赖**而非散文：只认真实的 `from "…"` / `import(…)` 说明符，
 *    注释里提到「patent」不算命中（否则判据会因措辞变化假红）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** 从编译产物位置（`dist/tests/...`）或源码位置（`tests/...`）向上走到仓库根。 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found (no package.json ancestor)");
    dir = parent;
  }
  return dir;
}

/**
 * 「模块依赖指向专利域」判据：`from "…/patent"` 或 `from "…/patent/…"` / `import("…")`。
 * 结尾用 `(?:/|["'`])` 收口，避免把 `patent-xyz` 这类同前缀模块误判成专利域依赖。
 */
const PATENT_IMPORT = /(?:from|import\()\s*["'`][^"'`]*\/patent(?:\/|["'`])/;

/** 受约束的通用层：通用编排（agent/team）与通用团队工具（tool/builtin/team）。 */
const GUARDED_ROOTS = ["src/agent/team", "src/tool/builtin/team"];

/** 递归收集目录下的 TS 源文件（绝对路径）。 */
function tsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsSources(full));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

for (const root of GUARDED_ROOTS) {
  test(`分层判据：${root} 不依赖专利业务域 src/patent（#363）`, () => {
    const base = repoRoot();
    const dir = join(base, root);
    assert.ok(existsSync(dir), `受约束目录不存在（路径漂移，判据失去作用域）：${root}`);
    const files = tsSources(dir);
    // 「扫不到文件 ⇒ 空集 ⇒ 放行」是本类判据最危险的失败模式，显式拒绝。
    assert.ok(files.length > 0, `${root} 未扫到任何 TS 源文件——判据退化为恒真，须修路径`);
    const offenders = files.filter(file => PATENT_IMPORT.test(readFileSync(file, "utf8")));
    assert.deepEqual(
      offenders.map(file => relative(base, file)),
      [],
      "通用团队层又出现了对 src/patent 的依赖：改为经 WorkerGate 注入（装配点 src/cli/teamSubsystem.ts）",
    );
  });
}
