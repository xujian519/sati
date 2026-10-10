// audit-silent-catches.test.mjs
// 负控制：证明静默 catch 审计能命中三类真实静默形态并正确分档，且不误报带可观测足迹的 catch。
// 同时锁定范围口径：与 measure-techdebt catch 口径对齐（src + ui/src + ui/server，排除 *.spec.*）。
// 做法：临时目录搭 fixture 树，用 --root 跑真实脚本，断言输出与退出码。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./audit-silent-catches.mjs", import.meta.url));

function makeTree(t, name) {
  const root = mkdtempSync(join(tmpdir(), `sati-silent-catch-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, relativePath, content) {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function run(root, args = []) {
  const result = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
  assert.equal(result.error, undefined, `无法启动脚本：${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const POSITIVES = [
  "try { risky(); } catch { /* 有意忽略 */ }",
  "try { risky(); } catch (error) { failed += 1; }",
  "void doThing().catch(() => {});",
].join("\n");

const NEGATIVES = [
  'try { risky(); } catch (error) { logger.warn("降级", error); }',
  "try { risky(); } catch (error) { throw error; }",
  "try { risky(); } catch { return null; }",
  "void doThing().catch(error => console.error(error));",
  "void doThing().catch(error => { telemetry.track(error); });",
  "try { risky(); } catch (error) { res.status(500).json({ error: String(error) }); }",
].join("\n");

test("命中三类静默形态并正确分档：注释体=档B / 仅计数=档A / 空箭头=档A", t => {
  const root = makeTree(t, "positives");
  write(root, "src/positives.ts", `${POSITIVES}\n`);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /候选 3 处（档 A 无注释且无足迹 2 \/ 档 B 有注释但无足迹 1/);
  assert.match(result.stdout, /src\/positives\.ts:1\s+catch\s+\[已注释·无足迹\]/);
  assert.match(result.stdout, /src\/positives\.ts:2\s+catch\s+\[无注释\]/);
  assert.match(result.stdout, /src\/positives\.ts:3\s+\.catch\s+\[无注释\]/);
});

test("不误报带可观测足迹的 catch（日志/抛错/return/遥测/HTTP 错误面）", t => {
  const root = makeTree(t, "negatives");
  write(root, "src/negatives.ts", `${NEGATIVES}\n`);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /候选 0 处/);
  assert.equal(result.stdout.includes("src/negatives.ts"), false, "带足迹的 catch 不应出现在清单中");
});

test("--fail-on-hits：有候选时 exit 1；干净树 exit 0", t => {
  const dirty = makeTree(t, "fail-on-hits-dirty");
  write(dirty, "src/a.ts", "try { risky(); } catch {}\n");
  const dirtyResult = run(dirty, ["--fail-on-hits"]);
  assert.equal(dirtyResult.status, 1);

  const clean = makeTree(t, "fail-on-hits-clean");
  write(clean, "src/a.ts", "try { risky(); } catch (error) { logger.error(error); }\n");
  const cleanResult = run(clean, ["--fail-on-hits"]);
  assert.equal(cleanResult.status, 0, cleanResult.stderr);
});

test("扫描 src / ui/src / ui/server（与 metrics catch 口径对齐）", t => {
  const root = makeTree(t, "multi-root");
  write(root, "ui/server/bridge.js", "promise.catch(() => undefined);\n");
  write(root, "ui/src/hooks.ts", "try { load(); } catch {}\n");
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ui\/server\/bridge\.js:1/);
  assert.match(result.stdout, /ui\/src\/hooks\.ts:1/);
});

test("范围外与 spec 文件不扫描：apps/desktop/src 与 *.spec.ts 被排除", t => {
  const root = makeTree(t, "scope-excluded");
  write(root, "src/foo.spec.ts", "try { risky(); } catch {}\n");
  write(root, "apps/desktop/src/main.ts", "try { boot(); } catch {}\n");
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /候选 0 处/);
});
