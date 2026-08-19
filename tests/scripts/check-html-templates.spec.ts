import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = resolve(process.cwd());
const SCRIPT = join(REPO_ROOT, "scripts", "check-html-templates.mjs");
const tempDirs: string[] = [];

function runScript(args: string[], options: { cwd?: string } = {}) {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd: options.cwd ?? REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test.afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-html-templates validates the bundled html-* templates", () => {
  const result = runScript([]);
  assert.equal(result.status, 0);
  assert.match(result.output, /Checked 7 html templates/);
});

test("check-html-templates fails a single HTML file containing lorem ipsum", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-check-html-"));
  tempDirs.push(dir);
  const html = join(dir, "bad.html");
  writeFileSync(
    html,
    `<!DOCTYPE html><html lang="zh-CN"><head><style>body{font-family:"Noto Sans SC",sans-serif}</style></head><body><p>lorem ipsum</p></body></html>`,
  );
  const result = runScript([html]);
  assert.equal(result.status, 1);
  assert.match(result.output, /lorem/);
});

test("check-html-templates fails a template directory missing references/checklist.md", () => {
  const root = mkdtempSync(join(tmpdir(), "sati-check-html-dir-"));
  tempDirs.push(root);
  const skillDir = join(root, "html-fake");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---
name: html-fake
description: fake html template
mode: doc
---
# Fake
Read assets/prompts/html/shared-design-directives.md
`,
  );
  writeFileSync(
    join(skillDir, "example.html"),
    `<!DOCTYPE html><html lang="zh-CN"><head><style>body{font-family:"Noto Serif SC",serif}</style></head><body><p>ok</p></body></html>`,
  );
  const result = runScript(["--dir", root]);
  assert.equal(result.status, 1);
  assert.match(result.output, /references\/checklist.md missing/);
});

test("check-html-templates passes a minimal valid template directory", () => {
  const root = mkdtempSync(join(tmpdir(), "sati-check-html-ok-"));
  tempDirs.push(root);
  const skillDir = join(root, "html-ok");
  mkdirSync(join(skillDir, "references"), { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---
name: html-ok
description: ok html template
mode: doc
---
# OK
Read assets/prompts/html/shared-design-directives.md
`,
  );
  writeFileSync(
    join(skillDir, "example.html"),
    `<!DOCTYPE html><html lang="zh-CN"><head><style>body{font-family:"Noto Sans SC",sans-serif}</style></head><body><p>ok</p></body></html>`,
  );
  writeFileSync(join(skillDir, "references", "checklist.md"), `# Checklist\n- [ ] ok\n`);
  writeFileSync(join(skillDir, "references", "SOURCE.md"), `# Source\n- Reference: https://example.com\n`);
  const result = runScript(["--dir", root]);
  assert.equal(result.status, 0);
});
