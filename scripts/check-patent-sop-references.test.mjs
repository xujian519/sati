// check-patent-sop-references.test.mjs
// 负控制：证明引用门禁能拦住幽灵工具名，并证明扩面没有把非工具 token 误判。
// 做法：在临时目录搭最小仓库树，用 --root 跑真实脚本。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectToolIdentifiers } from "./check-patent-sop-references.mjs";

const SCRIPT = fileURLToPath(new URL("./check-patent-sop-references.mjs", import.meta.url));

function write(root, relativePath, content) {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** 铺最小可运行仓库树：一个真实工具 + 必需权威清单文件。 */
function seedTree(t) {
  const root = mkdtempSync(join(tmpdir(), "sati-reference-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, "src/tool/builtin/patentRealTool.ts", 'export const tool = { name: "patent_real_tool" };\n');
  write(
    root,
    "src/tool/builtin/agent.ts",
    'export const SUBAGENT_TYPE_ALIASES = {\n  analyzer: "patent-analyzer",\n};\n',
  );
  write(
    root,
    "src/patent/worker-contract.ts",
    'export const defaultPatentWorkers = [\n  {\n    name: "probe-worker",\n  },\n];\n',
  );
  write(root, "src/patent/workflow/manifests.ts", 'export const m = {\n  id: "patent_demo_v1",\n};\n');
  write(root, "assets/prompts/patent/cap09-search-commander.md", "# CAP09\n\n使用 `patent_real_tool`。\n");
  write(root, "skills/demo/SKILL.md", "---\nname: demo\n---\n\n使用 `patent_real_tool`。\n");
  write(root, "rules/README.md", "# 规则\n\n使用 `patent_real_tool`。\n");
  write(root, "assets/workflows/patent/demo.yaml", "stages:\n  - worker: probe-worker\n");
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
}

test("collectToolIdentifiers: 收反引号内的 snake_case token 与调用式引用", () => {
  const refs = collectToolIdentifiers(
    "`patent_real_tool` `patent_case_search({ query: ... })` `subagent_type` `google-patents-search` `single` `patent-ghost`",
  );
  assert.deepEqual(refs, ["patent_real_tool", "patent_case_search", "subagent_type"]);
});

test("干净 fixture → fresh", t => {
  const result = run(seedTree(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^check-patent-sop-references: fresh/);
});

test("提示词中的幽灵工具名 → 失败并带文件:行", t => {
  const root = seedTree(t);
  write(root, "assets/prompts/patent/cap09-search-commander.md", "# CAP09\n\n使用 `patent_ghost_tool`。\n");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cap09-search-commander\.md:3: 未知引用 "patent_ghost_tool"/);
});

test("SKILL.md 中的幽灵工具名 → 失败（扫描面扩到 skills）", t => {
  const root = seedTree(t);
  write(root, "skills/demo/SKILL.md", "---\nname: demo\n---\n\n调用 `patent_ghost_tool`。\n");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /skills\/demo\/SKILL\.md:5: 未知引用 "patent_ghost_tool"/);
});

test("rules 文档中的幽灵工具名 → 失败（扫描面扩到 rules）", t => {
  const root = seedTree(t);
  write(root, "rules/README.md", "# 规则\n\n调用 `patent_ghost_tool`。\n");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rules\/README\.md:3: 未知引用 "patent_ghost_tool"/);
});

test("白名单中的非工具 token → 放行", t => {
  const root = seedTree(t);
  write(
    root,
    "assets/prompts/patent/cap09-search-commander.md",
    "# CAP09\n\n参数 `subagent_type`、`max_turns`、`keyword_blocklist` 都不是工具。\n",
  );
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
});

test("同前缀工具 → 报错附带疑似替代项", t => {
  const root = seedTree(t);
  write(root, "assets/prompts/patent/cap09-search-commander.md", "# CAP09\n\n使用 `patent_real_too`。\n");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /同前缀工具：patent_real_tool/);
});

test("调用式幽灵工具名 → 失败（不只匹配裸 token）", t => {
  const root = seedTree(t);
  write(
    root,
    "assets/prompts/patent/cap09-search-commander.md",
    '# CAP09\n\n调用 `patent_ghost_tool({ query: "x" })`。\n',
  );
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cap09-search-commander\.md:3: 未知引用 "patent_ghost_tool"/);
});

test("cap01 中的连字符幽灵角色/worker → 失败（保留旧扫描口径）", t => {
  const root = seedTree(t);
  write(
    root,
    "assets/prompts/patent/cap01-orchestrator.md",
    "# CAP01\n\n派发 `patent-ghost-role`，worker `ghost-worker`。\n",
  );
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /patent-ghost-role/);
  assert.match(result.stderr, /ghost-worker/);
});

test("扫描面缺失 → fail-loud，不得静默 fresh", t => {
  const root = seedTree(t);
  rmSync(join(root, "rules"), { recursive: true, force: true });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /扫描面为空或不存在：rules/);
});

test("已知幽灵映射 → 精确替代项", t => {
  const root = seedTree(t);
  write(root, "assets/prompts/patent/cap09-search-commander.md", "# CAP09\n\n使用 `patent_kg_search`。\n");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /疑似替代：patent_kg_query/);
});
