import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("config bootstrap does not copy bundled skills into user storage", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-bootstrap-"));
  try {
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "bootstrap-sati-config.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, SATI_HOME: pilotHome },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(pilotHome, "sati.yaml")), true);
    assert.equal(existsSync(join(pilotHome, "skills")), false);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("fresh bootstrap config contains discoverable memory/embedding section", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-bootstrap-"));
  const isolatedHome = mkdtempSync(join(tmpdir(), "sati-bootstrap-home-"));
  try {
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "bootstrap-sati-config.mjs")], {
      cwd: process.cwd(),
      // HOME 隔离：避免 ~/.pilotdeck 旧配置迁移污染新装场景断言
      env: { ...process.env, SATI_HOME: pilotHome, HOME: isolatedHome },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(join(pilotHome, "sati.yaml"), "utf8");
    assert.match(content, /^memory:\s*$/m);
    assert.match(content, /provider: edgeclaw/);
    // embedding 示例以注释形式可发现（零行为变更）
    assert.match(content, /# embedding:/);
    assert.match(content, /bge-m3/);
    assert.match(content, /# {3}topN: 16/);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test("existing config without memory section gets memory snippet appended", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-bootstrap-"));
  const isolatedHome = mkdtempSync(join(tmpdir(), "sati-bootstrap-home-"));
  const env = { ...process.env, SATI_HOME: pilotHome, HOME: isolatedHome };
  try {
    writeFileSync(join(pilotHome, "sati.yaml"), "schemaVersion: 1\nagent:\n  model: foo/bar\n", "utf8");
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "bootstrap-sati-config.mjs")], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(join(pilotHome, "sati.yaml"), "utf8");
    assert.match(content, /^memory:\s*$/m);
    // 幂等：二次运行不重复追加
    const again = spawnSync(process.execPath, [join(process.cwd(), "scripts", "bootstrap-sati-config.mjs")], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    assert.equal(again.status, 0, again.stderr);
    const content2 = readFileSync(join(pilotHome, "sati.yaml"), "utf8");
    assert.equal(content2.match(/^memory:\s*$/gm)?.length, 1);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});
