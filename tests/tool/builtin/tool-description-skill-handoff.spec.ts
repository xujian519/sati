/**
 * 工具描述把操作细节交给技能后，技能必须仍然带着这些细节（#450 第 4 条）。
 *
 * 描述瘦身的风险不是"字变少了"，而是"两处都没了"：描述里删掉 helper 清单，
 * 技能里又从来没有，模型再也查不到。本用例锁住这条交接契约——凡描述声明
 * "细节见某技能"的工具，其技能文件必须存在，且仍含被移走的关键 token。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

function skillText(name: string): string {
  return readFileSync(resolve(process.cwd(), "skills", name, "SKILL.md"), "utf8");
}

test("ego_browser 描述把 helper API 交给 ego-browser 技能，技能里带着这些 token", async () => {
  const registry = createBuiltinRegistry({ askUserQuestion: false, planMode: false });
  const description = registry.get("ego_browser")?.description ?? "";
  assert.match(description, /ego-browser` skill/, "描述应指向 ego-browser 技能");

  const skill = skillText("ego-browser");
  for (const token of [
    "useOrCreateTaskSpace",
    "completeTaskSpace",
    "openOrReuseTab",
    "snapshotText",
    "click",
    "fillInput",
    "cliLog",
    "page.waitForEvent",
    "page.screencast",
    "site.runTool",
    "handOffTaskSpace",
    "takeOverTaskSpace",
  ]) {
    assert.ok(skill.includes(token), `ego-browser 技能应仍记录 ${token}`);
  }
});

test("patent_figure_check 描述把规则目录交给 patent-illustrator 技能，技能存在", async () => {
  const registry = createBuiltinRegistry({ askUserQuestion: false, planMode: false });
  const description = registry.get("patent_figure_check")?.description ?? "";
  assert.match(description, /patent-illustrator` skill/, "描述应指向 patent-illustrator 技能");

  const skill = skillText("patent-illustrator");
  for (const token of ["V1", "V2", "V4", "patent_figure_check"]) {
    assert.ok(skill.includes(token), `patent-illustrator 技能应仍记录 ${token}`);
  }
});
