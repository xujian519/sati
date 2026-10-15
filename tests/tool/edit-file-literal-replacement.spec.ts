/**
 * `edit_file` 必须把 `new_string` 按**字面量**写入（移植自上游 PilotDeck #626，AGPL-3.0）。
 *
 * `String.prototype.replace` 的字符串替换器会解释 `$$` / `$&` / `` $` `` / `$'` 等替换模式，
 * 于是写进文件的是「展开后」的结果而非用户给的字符串。典型受害面是含 `$` 的代码与配置：
 * Makefile/shell 里的 `$$`、ANSI-C 引用的 `$'\n'`、LaTeX 行内公式的 `$$…$$`。
 *
 * 判据：对每个 `new_string` 样本断言**落盘内容就是字面量替换**，`replace_all` 两态都覆盖
 * （该分支走 split/join，本来就不受影响，一并钉住避免将来改回去）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditFileTool } from "../../src/tool/builtin/editFile.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";

function context(cwd: string) {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-10-15T00:00:00.000Z"),
  };
}

/** 写初值 → 读一次（满足「已观测」前置）→ 编辑 → 读回落盘内容。 */
async function editExistingFile(
  workspace: string,
  fileName: string,
  initial: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): Promise<string> {
  const ctx = context(workspace);
  const absolutePath = join(workspace, fileName);
  await writeFile(absolutePath, initial, "utf8");
  await createReadFileTool().execute({ file_path: fileName }, ctx);
  await createEditFileTool().execute(
    { file_path: fileName, old_string: oldString, new_string: newString, replace_all: replaceAll },
    ctx,
  );
  return readFile(absolutePath, "utf8");
}

/** 「替换模式」类字符：字符串替换器会展开它们，字面量写入则原样保留。 */
const REPLACEMENT_PATTERN_CASES: Array<[string, string]> = [
  ["$$ 会被塌缩成 $（shell/Makefile 转义）", "$$HOME"],
  ["行内公式的 $$…$$", "$$E=mc^2$$"],
  ["ANSI-C 引用的 $'", "IFS=$'\\n'"],
  ["匹配前文引用 $`", "before-$`-after"],
  ["整体匹配引用 $&", "x $& y"],
  ["匹配后文引用 $'", "trail-$'-end"],
  ["捕获组形态 $1", "keep $1 as is"],
  ["命名组形态 $<name>", "keep $<name> as is"],
];

for (const replaceAll of [false, true]) {
  for (const [label, newString] of REPLACEMENT_PATTERN_CASES) {
    test(`edit_file 按字面量写入 new_string：${label}（replace_all=${replaceAll}）`, async () => {
      const workspace = await mkdtemp(join(tmpdir(), "sati-edit-literal-"));
      try {
        const initial = "const v = PLACEHOLDER\n";
        const written = await editExistingFile(workspace, "sample.txt", initial, "PLACEHOLDER", newString, replaceAll);
        assert.equal(written, `const v = ${newString}\n`);
        assert.ok(written.includes(newString), "new_string 必须原样出现");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }
}

test("edit_file 字面量替换在 replace_all 下覆盖全部出现处", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "sati-edit-literal-all-"));
  try {
    const initial = "a = PLACEHOLDER\nb = PLACEHOLDER\nc = PLACEHOLDER\n";
    const written = await editExistingFile(workspace, "many.txt", initial, "PLACEHOLDER", "$$E=mc^2$$", true);
    assert.equal(written, "a = $$E=mc^2$$\nb = $$E=mc^2$$\nc = $$E=mc^2$$\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("edit_file 未实际展开替换模式（钉住失败签名，避免回退成字符串替换器）", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "sati-edit-literal-sign-"));
  try {
    // `$&` 展开后会把被匹配的 "PLACEHOLDER" 塞回来；`` $` `` 展开后会插入匹配前的内容。
    const initial = "prefix PLACEHOLDER\n";
    const withMatchRef = await editExistingFile(workspace, "amp.txt", initial, "PLACEHOLDER", "x $& y", false);
    assert.equal(withMatchRef, "prefix x $& y\n");
    assert.ok(!withMatchRef.includes("PLACEHOLDER"), "$& 不得被展开成匹配内容");

    const withPrefixRef = await editExistingFile(workspace, "tick.txt", initial, "PLACEHOLDER", "[$`]", false);
    assert.equal(withPrefixRef, "prefix [$`]\n");
    assert.ok(!withPrefixRef.includes("prefix PLACEHOLDER"), "$` 不得被展开成匹配前的内容");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
