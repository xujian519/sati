import assert from "node:assert/strict";
import test from "node:test";
import { NullExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";

class TwoSkillResolver extends NullExtensionResolver {
  override listSkills() {
    return [
      { name: "enabled-skill", description: "visible", path: "/enabled-skill" },
      { name: "disabled-skill", description: "hidden", path: "/disabled-skill" },
    ];
  }
}

function assemble(isSkillEnabled: (slug: string) => boolean): string {
  return new PromptAssembler(new TwoSkillResolver(), { isSkillEnabled }).assemble({
    cwd: "/tmp/project",
    provider: "test",
    model: "test-model",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    tools: [],
  }).joined;
}

test("禁用技能不进入 available-skills", () => {
  const prompt = assemble(slug => slug !== "disabled-skill");

  assert.match(prompt, /enabled-skill/);
  assert.doesNotMatch(prompt, /disabled-skill/);
});

test("未配置过滤时全部保留", () => {
  const prompt = assemble(() => true);
  assert.match(prompt, /disabled-skill/);
});
