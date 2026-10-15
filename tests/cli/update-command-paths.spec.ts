/**
 * `sati update` 的脚本路径推导（P2.7 非逐 token 搬迁处的回归锚）。
 *
 * 起因：`handleUpdateCommand` 原在 `src/cli/sati.ts`，`__filename` 的目录是 `dist/src/cli`，
 * 向上三级即仓库根；搬进 `src/cli/commands/updateCommand.ts` 后目录深了一层，必须向上四级。
 * 少一级会让 `scripts/update.sh` 解析到 `dist/scripts/update.sh`（不存在），
 * `sati update` 静默失败或跑错脚本——故本测试把层数钉死。
 *
 * 刻意**只做算术**（喂合成 URL），不依赖测试自身跑在 `dist/` 还是 `src/`：
 * 源码树的 `src/cli/commands/` 比编译产物的 `dist/src/cli/commands/` 浅一层，
 * 若用 `import.meta.url` 现推，同一份实现在两种布局下会得出相反结论。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { resolveUpdatePaths } from "../../src/cli/commands/updateCommand.js";

/** 编译产物布局下 `updateCommand.js` 的位置（tsconfig：outDir=dist、rootDir=仓库根）。 */
function distModuleUrl(root: string): string {
  return pathToFileURL(join(root, "dist", "src", "cli", "commands", "updateCommand.js")).href;
}

test("resolveUpdatePaths 从编译产物路径回推到仓库根与 scripts/update.sh", () => {
  const root = process.cwd();
  const { projectRoot, scriptPath } = resolveUpdatePaths(distModuleUrl(root));

  assert.equal(projectRoot, root);
  assert.equal(scriptPath, join(root, "scripts", "update.sh"));
  // 上游契约：脚本确实存在于这个位置（层数错时会指到别处）
  assert.ok(existsSync(scriptPath), `update 脚本应存在：${scriptPath}`);
});

test("三级 .. 会落到 dist/ —— 本实现必须用四级（层数回归的显式反例）", () => {
  const root = process.cwd();
  const moduleDir = dirname(fileURLToPath(distModuleUrl(root)));

  // 三级 = 仓库根的 dist/（「搬进 commands/ 后忘记加深一层」的失效形态）
  assert.equal(resolvePath(moduleDir, "..", "..", ".."), join(root, "dist"));
  // 四级 = 仓库根（本实现的落点），且 scripts/update.sh 在那里真实存在
  const { projectRoot, scriptPath } = resolveUpdatePaths(distModuleUrl(root));
  assert.equal(projectRoot, root);
  assert.equal(existsSync(join(root, "dist", "scripts", "update.sh")), false);
  assert.ok(existsSync(scriptPath));
});
