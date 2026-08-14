import assert from "node:assert/strict";
import test from "node:test";
import { renderSkillContent } from "../../../src/extension/skills/renderSkillContent.js";

test("expands the skill root placeholder to the skill directory", () => {
  assert.equal(
    renderSkillContent(
      'SKILL_ROOT={{SKILL_ROOT_SHELL}}\nbash "$SKILL_ROOT/scripts/docx.sh"',
      "/opt/sati/skills/docx/SKILL.md",
    ),
    "SKILL_ROOT='/opt/sati/skills/docx'\nbash \"$SKILL_ROOT/scripts/docx.sh\"",
  );
});

test("skill root placeholder is safe for shell paths containing spaces and quotes", () => {
  assert.equal(
    renderSkillContent("echo {{SKILL_ROOT_SHELL}}", "/opt/sati/my skills/a'b/SKILL.md"),
    "echo '/opt/sati/my skills/a'\\''b'",
  );
});

test("escaped skill root placeholders remain literal in authoring guidance", () => {
  assert.equal(
    renderSkillContent(
      "Use {{!SKILL_ROOT_SHELL}}; runtime={{SKILL_ROOT_SHELL}}",
      "/opt/sati/skills/skill-creator/SKILL.md",
    ),
    "Use {{SKILL_ROOT_SHELL}}; runtime='/opt/sati/skills/skill-creator'",
  );
});

test("skill content without the placeholder remains unchanged", () => {
  const content = "# Guidance-only skill\n\nUse judgment.";
  assert.equal(renderSkillContent(content, "/opt/sati/skills/guidance/SKILL.md"), content);
});
