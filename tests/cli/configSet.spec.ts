/**
 * review#2 测试：`sati config set/delete` 用 yaml Document 原地编辑——
 * 保留用户注释与 anchors（parseYaml/stringify round-trip 会丢），
 * 删除路径时自底向上清空节，中间节点非对象报错不落盘。
 *
 * configSet 模块级常量（SATI_YAML_PATH）在 import 时求值，因此每个用例
 * 设 SATI_CONFIG_PATH 指向临时文件后带 cache-bust 动态 import。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const CONFIG_SET_MODULE = new URL("../../src/cli/commands/configSet.js", import.meta.url).pathname;

type ConfigSetModule = {
  runConfigCommand: (argv: string[]) => Promise<void>;
};

async function loadWithEnv(yamlPath: string): Promise<ConfigSetModule> {
  process.env.SATI_CONFIG_PATH = yamlPath;
  // cache-bust：每个用例独立求值模块级 SATI_YAML_PATH。
  return (await import(`${CONFIG_SET_MODULE}?t=${Date.now()}`)) as ConfigSetModule;
}

function withTempYaml(content: string | null): { dir: string; yamlPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "sati-configset-"));
  const yamlPath = join(dir, "sati.yaml");
  if (content !== null) writeFileSync(yamlPath, content, "utf-8");
  return { dir, yamlPath };
}

test("config set 保留用户注释与 anchors，新 key 写入", async () => {
  const { dir, yamlPath } = withTempYaml(
    "# 顶部注释\npatents:\n  # downloadDir 注释\n  downloadDir: ~/Patents\nmodel: &m\n  temperature: 0.7\n",
  );
  try {
    const mod = await loadWithEnv(yamlPath);
    process.exitCode = 0;
    await mod.runConfigCommand(["set", "patents.keepAlive", "true"]);
    assert.equal(process.exitCode, 0);
    const out = readFileSync(yamlPath, "utf-8");
    assert.match(out, /# 顶部注释/);
    assert.match(out, /# downloadDir 注释/);
    assert.match(out, /downloadDir: ~\/Patents/);
    assert.match(out, /keepAlive: true/);
    // anchors 原样保留
    assert.match(out, /model: &m/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config set 嵌套创建 + 值类型推断", async () => {
  const { dir, yamlPath } = withTempYaml("model:\n  name: sati\n");
  try {
    const mod = await loadWithEnv(yamlPath);
    process.exitCode = 0;
    await mod.runConfigCommand(["set", "model.temperature", "0.7"]);
    assert.equal(process.exitCode, 0);
    const out = readFileSync(yamlPath, "utf-8");
    assert.match(out, /temperature: 0\.7/); // 数字不加引号
    assert.match(out, /name: sati/); // 未触及的 key 原样保留
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config set 文件不存在时创建", async () => {
  const { dir, yamlPath } = withTempYaml(null);
  try {
    const mod = await loadWithEnv(yamlPath);
    process.exitCode = 0;
    await mod.runConfigCommand(["set", "patents.downloadDir", "~/P"]);
    assert.equal(process.exitCode, 0);
    assert.match(readFileSync(yamlPath, "utf-8"), /patents:\n {2}downloadDir: ~\/P/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config set 中间节点非对象：报错且不落盘", async () => {
  const { dir, yamlPath } = withTempYaml("model: 5\n");
  try {
    const mod = await loadWithEnv(yamlPath);
    process.exitCode = 0;
    await mod.runConfigCommand(["set", "model.temperature", "0.7"]);
    assert.equal(process.exitCode, 1);
    assert.equal(readFileSync(yamlPath, "utf-8"), "model: 5\n"); // 文件未被改写
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config delete 删除空节（不留 patents: {} 残节）", async () => {
  const { dir, yamlPath } = withTempYaml("patents:\n  downloadDir: ~/P\na: 1\n");
  try {
    const mod = await loadWithEnv(yamlPath);
    process.exitCode = 0;
    await mod.runConfigCommand(["delete", "patents.downloadDir"]);
    assert.equal(process.exitCode, 0);
    const out = readFileSync(yamlPath, "utf-8");
    assert.doesNotMatch(out, /patents:/); // 空节被 prune
    assert.match(out, /a: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config delete 保留非空上层节", async () => {
  const { dir, yamlPath } = withTempYaml("patents:\n  downloadDir: ~/P\n  keepAlive: true\n");
  try {
    const mod = await loadWithEnv(yamlPath);
    process.exitCode = 0;
    await mod.runConfigCommand(["delete", "patents.downloadDir"]);
    assert.equal(process.exitCode, 0);
    const out = readFileSync(yamlPath, "utf-8");
    assert.match(out, /patents:\n {2}keepAlive: true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config set 非法 YAML：报错退出且不覆盖", async () => {
  const { dir, yamlPath } = withTempYaml("patents: [未闭合\n");
  try {
    const mod = await loadWithEnv(yamlPath);
    process.exitCode = 0;
    await mod.runConfigCommand(["set", "patents.downloadDir", "~/P"]);
    assert.equal(process.exitCode, 1);
    assert.match(readFileSync(yamlPath, "utf-8"), /未闭合/); // 原文未被覆盖
    process.exitCode = 0; // 恢复，避免文件级 subtest 因残留 exitCode 失败
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
