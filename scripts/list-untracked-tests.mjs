/**
 * 报告型脚本：列出「存在于工作树、但未入库」的测试文件。
 *
 * 背景：`.gitignore` 全局忽略 `*.test.ts`（`.gitignore:215`，给本地草稿留豁免）。
 * 代价是**新增的后端测试若忘记 `git add -f`，文件不入库、CI 永远不跑**——#449 曾
 * 因此漏掉一个 hook 测试，且没有任何门禁会发现（测试跑绿了，只是没跑那些文件）。
 *
 * 刻意**不做成门禁**：本地草稿是合法用法，做成 fail 会产生大量误报；本脚本只报告，
 * 供提交前自查（AGENTS.md 的 force-add 纪律指向它）。
 *
 * 用法：
 *   node scripts/list-untracked-tests.mjs
 */
import { execFileSync } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

/** 被 git 忽略、且未入库的测试文件（`!!` = ignored）。 */
function ignoredTestFiles() {
  const output = git(["status", "--porcelain", "--ignored=matching", "-uall"]);
  return output
    .split("\n")
    .filter(line => line.startsWith("!!"))
    .map(line => line.slice(3).trim())
    .filter(path => /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/.test(path))
    .sort();
}

const ignored = ignoredTestFiles();
const trackedTestTs = git(["ls-files", "*.test.ts"]).split("\n").filter(Boolean);
const trackedTestTsx = git(["ls-files", "*.test.tsx"]).split("\n").filter(Boolean);

console.log(
  `已入库：\`.test.ts\` ${trackedTestTs.length} 个（均需 force-add，因 .gitignore 忽略该模式）、` +
    `\`.test.tsx\` ${trackedTestTsx.length} 个（不受忽略影响）`,
);
if (ignored.length === 0) {
  console.log("未入库的测试文件：0 个（无本地草稿遗留）");
  process.exit(0);
}

console.log(`\n未入库的测试文件：${ignored.length} 个（CI 不会跑这些文件）`);
for (const path of ignored) console.log(`  - ${path}`);
console.log("\n若其中有应长期保留的测试：`git add -f <path>` 后提交；否则请删除本地草稿。");
