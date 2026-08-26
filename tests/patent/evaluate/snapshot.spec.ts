import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { isExcludedSnapshotEntry, packSnapshot } from "../../../src/patent/evaluate/snapshot.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sati-snapshot-"));
  tempDirs.push(dir);
  return dir;
}

const FIXED_NOW = () => new Date("2026-08-09T00:00:00.000Z");

describe("isExcludedSnapshotEntry", () => {
  it("排除密钥/凭据/环境文件", () => {
    assert.equal(isExcludedSnapshotEntry("agent_state/.vault.toml"), true);
    assert.equal(isExcludedSnapshotEntry("agent_state/.env"), true);
    assert.equal(isExcludedSnapshotEntry("key.pem"), true);
    assert.equal(isExcludedSnapshotEntry("credentials.json"), true);
    assert.equal(isExcludedSnapshotEntry("node_modules/x/index.js"), true);
  });

  it("保留正常文件", () => {
    assert.equal(isExcludedSnapshotEntry("SKILL.md"), false);
    assert.equal(isExcludedSnapshotEntry("agent_state/memory/notes.md"), false);
  });
});

describe("packSnapshot", () => {
  it("打包角色目录并排除密钥，写 manifest，版本不覆盖", async () => {
    const src = makeDir();
    const snapDir = makeDir();
    writeFileSync(join(src, "SKILL.md"), "---\ntype: role\n---\nbody");
    writeFileSync(join(src, ".vault.toml"), "key=secret");
    writeFileSync(join(src, ".env.local"), "x");
    mkdirSync(join(src, "sub"));
    writeFileSync(join(src, "sub", "helper.md"), "# helper");

    const res = await packSnapshot(src, snapDir, 1, FIXED_NOW);
    assert.equal(res.version, 1);
    assert.deepEqual(res.files.sort(), ["SKILL.md", "sub/helper.md"]);
    // manifest 记录文件清单
    assert.ok(existsSync(join(res.root, "manifest.yaml")));
    const manifest = JSON.parse(readFileSync(join(res.root, "manifest.yaml"), "utf8")) as {
      version: number;
      files: string[];
    };
    assert.equal(manifest.version, 1);
    assert.ok(!manifest.files.includes(".vault.toml"));
    // 密钥文件不进快照目录
    assert.equal(existsSync(join(res.root, ".vault.toml")), false);

    // 版本不覆盖：再打同版本必抛错
    await assert.rejects(() => packSnapshot(src, snapDir, 1, FIXED_NOW), /already exists/);
  });

  it("非法版本号抛错", async () => {
    await assert.rejects(() => packSnapshot(makeDir(), makeDir(), 0, FIXED_NOW), /positive integer/);
  });
});
