import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const REPO_ROOT = resolve(process.cwd());
const SCRIPT = join(REPO_ROOT, "scripts", "export-html.mjs");
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

test("export-html shows help", () => {
  const result = runScript(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.output, /Usage:/);
});

test("export-html rejects a missing input file", () => {
  const result = runScript(["pdf", "/definitely/not/here.html"]);
  assert.equal(result.status, 1);
  assert.match(result.output, /Input file not found/);
});

test("export-html converts mjx-container to zhihu data-eeimg placeholder", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-export-html-"));
  tempDirs.push(dir);
  const input = join(dir, "math.html");
  const output = join(dir, "math-zhihu.html");
  writeFileSync(
    input,
    `<!DOCTYPE html><html lang="zh-CN"><head></head><body><mjx-container>E=mc^2</mjx-container></body></html>`,
  );
  const result = runScript(["zhihu", input, output]);
  assert.equal(result.status, 0);
  assert.equal(existsSync(output), true);
  assert.match(readFileSync(output, "utf8"), /data-eeimg/);
});

test("export-html rejects path traversal in output", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-export-traversal-"));
  tempDirs.push(dir);
  const input = join(dir, "page.html");
  writeFileSync(input, `<!DOCTYPE html><html lang="zh-CN"><head></head><body>ok</body></html>`);
  const result = runScript(["wechat", input, `${dir}/../escape.html`]);
  assert.equal(result.status, 1);
  assert.match(result.output, /path traversal/);
});

test("export-html inlines CSS with juice for wechat", () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-export-wechat-"));
  tempDirs.push(dir);
  const input = join(dir, "page.html");
  const output = join(dir, "page-wechat.html");
  writeFileSync(
    input,
    `<!DOCTYPE html><html lang="zh-CN"><head><style>.x{color:#1f3a5f}</style></head><body><p class="x">ok</p></body></html>`,
  );
  const result = runScript(["wechat", input, output]);
  assert.equal(result.status, 0);
  assert.match(readFileSync(output, "utf8"), /color: #1f3a5f/);
});
