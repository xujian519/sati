/**
 * 写路径残余面判据（Issue #643）：TOCTOU 与硬链接。
 *
 * - TOCTOU：解析与落盘之间软链可被重新指向。写盘前用 `__testBeforeWrite` 这个测试缝
 *   在「真实落点已解析、目标尚未打开」的时刻重指软链/替换目标，断言写入既不跟随新
 *   指向、也不留下新建的残片。
 * - 硬链接：不体现在任何 realpath 里。工作区内已存在且 nlink > 1 的写目标一律拒绝
 *   （策略见 docs/notes/implemented/2026-10-10-write-path-symlink-escape.md）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { link, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditFileTool } from "../../src/tool/builtin/editFile.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import { checkFilesystemWritePermission } from "../../src/tool/builtin/filesystem/writePermissions.js";
import { recordWriteSnapshot } from "../../src/tool/builtin/filesystem/writeSnapshots.js";
import type { PermissionMode, PermissionRule } from "../../src/permission/index.js";
import { PermissionRuntime } from "../../src/permission/decision/PermissionRuntime.js";
import type { SatiToolRuntimeContext } from "../../src/tool/protocol/types.js";

function context(cwd: string, permissionMode: PermissionMode = "default"): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode,
    permissionContext: {
      mode: permissionMode,
      cwd,
      additionalWorkingDirectories: [] as string[],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [] as PermissionRule[], deny: [], ask: [] },
    },
    now: () => new Date("2026-10-23T00:00:00.000Z"),
  };
}

async function withTempDirs(run: (workspace: string, outside: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "sati-write-race-ws-"));
  const outside = await mkdtemp(join(tmpdir(), "sati-write-race-out-"));
  try {
    await run(workspace, outside);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function recordSnapshot(ctx: SatiToolRuntimeContext, absolutePath: string): Promise<void> {
  const fileStat = await stat(absolutePath);
  recordWriteSnapshot(ctx, absolutePath, await readFile(absolutePath, "utf8"), Math.floor(fileStat.mtimeMs));
}

test("a symlink repointed between resolution and write is not followed", async () => {
  await withTempDirs(async (workspace, outside) => {
    await writeFile(join(workspace, "target.txt"), "inside\n");
    await writeFile(join(outside, "victim.txt"), "outside\n");
    await symlink("target.txt", join(workspace, "alias"));
    const ctx = context(workspace);
    await recordSnapshot(ctx, join(workspace, "alias"));
    ctx.__testBeforeWrite = async () => {
      await rm(join(workspace, "alias"));
      await symlink(join(outside, "victim.txt"), join(workspace, "alias"));
    };

    await assert.rejects(
      createWriteFileTool().execute({ file_path: "alias", content: "clobbered\n" }, ctx),
      /changed between permission resolution and the write/,
    );
    assert.equal(await readFile(join(workspace, "target.txt"), "utf8"), "inside\n");
    assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "outside\n");
  });
});

test("a new file created through a dangling symlink is rolled back when the link is repointed", async () => {
  await withTempDirs(async (workspace, outside) => {
    await symlink(join(workspace, "created.txt"), join(workspace, "alias"));
    const ctx = context(workspace);
    ctx.__testBeforeWrite = async () => {
      await rm(join(workspace, "alias"));
      await symlink(join(outside, "victim.txt"), join(workspace, "alias"));
    };

    await assert.rejects(
      createWriteFileTool().execute({ file_path: "alias", content: "inside\n" }, ctx),
      /changed between permission resolution and the write/,
    );
    await assert.rejects(readFile(join(workspace, "created.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(outside, "victim.txt")), { code: "ENOENT" });
  });
});

test("a target replaced by a symlink after resolution is rejected", async () => {
  await withTempDirs(async (workspace, outside) => {
    await writeFile(join(workspace, "target.txt"), "inside\n");
    await writeFile(join(outside, "victim.txt"), "outside\n");
    const ctx = context(workspace);
    await recordSnapshot(ctx, join(workspace, "target.txt"));
    ctx.__testBeforeWrite = async () => {
      await rm(join(workspace, "target.txt"));
      await symlink(join(outside, "victim.txt"), join(workspace, "target.txt"));
    };

    await assert.rejects(
      createWriteFileTool().execute({ file_path: "target.txt", content: "clobbered\n" }, ctx),
      /changed between permission resolution and the write/,
    );
    assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "outside\n");
    assert.equal((await lstat(join(workspace, "target.txt"))).isSymbolicLink(), true);
  });
});

for (const toolName of ["write_file", "edit_file"] as const) {
  test(`${toolName} rejects an existing target with another hard link`, async () => {
    await withTempDirs(async (workspace, outside) => {
      const victim = join(outside, "victim.txt");
      const hardTarget = join(workspace, "hard.txt");
      await writeFile(victim, "outside\n");
      await link(victim, hardTarget);
      const ctx = context(workspace);
      await recordSnapshot(ctx, hardTarget);

      const input = {
        file_path: "hard.txt",
        content: "clobbered\n",
        old_string: "outside",
        new_string: "clobbered",
      };
      const tool = toolName === "write_file" ? createWriteFileTool() : createEditFileTool();

      assert.equal(checkFilesystemWritePermission(toolName, "hard.txt", ctx).type, "deny");
      assert.equal((await new PermissionRuntime().decide(tool, input, ctx, "call")).type, "deny");
      await assert.rejects(tool.execute(input, ctx), /hard links/);
      assert.equal(await readFile(victim, "utf8"), "outside\n");
      assert.equal(await readFile(hardTarget, "utf8"), "outside\n");
    });
  });
}

test("a hard link created between resolution and write is rejected before writing", async () => {
  await withTempDirs(async (workspace, outside) => {
    const target = join(workspace, "target.txt");
    const otherLink = join(outside, "other-link.txt");
    await writeFile(target, "inside\n");
    const ctx = context(workspace);
    await recordSnapshot(ctx, target);
    ctx.__testBeforeWrite = async () => {
      // 第二个名字指向同一个 inode；nlink 从 1 变 2，realpath 看不出任何变化。
      await link(target, otherLink);
    };

    await assert.rejects(
      createWriteFileTool().execute({ file_path: "target.txt", content: "clobbered\n" }, ctx),
      /hard links/,
    );
    assert.equal(await readFile(target, "utf8"), "inside\n");
    assert.equal(await readFile(otherLink, "utf8"), "inside\n");
  });
});

test("a regular file (nlink = 1) still writes normally", async () => {
  await withTempDirs(async workspace => {
    const ctx = context(workspace);
    const result = await createWriteFileTool().execute({ file_path: "new.txt", content: "hello\n" }, ctx);
    assert.equal(result.data?.type, "create");
    assert.equal(await readFile(join(workspace, "new.txt"), "utf8"), "hello\n");
    assert.equal((await stat(join(workspace, "new.txt"))).nlink, 1);
  });
});
