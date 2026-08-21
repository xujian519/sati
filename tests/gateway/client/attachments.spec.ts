import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChannelAttachment } from "../../../src/gateway/protocol/types.js";
import {
  buildAttachmentPathNote,
  collectRegisteredAttachmentReadFiles,
  isReadFileInspectableAttachment,
  safeAllowedAttachmentPath,
  attachmentsToContentBlocks,
} from "../../../src/gateway/client/attachments.js";

test("attachments: buildAttachmentPathNote 去重 + 注入 marker + 引导语", () => {
  const atts: ChannelAttachment[] = [
    { type: "file", name: "a.txt", path: resolve("/tmp/a.txt") },
    { type: "file", name: "a-dup.txt", path: resolve("/tmp/a.txt") }, // 同一路径去重
    { type: "file", path: resolve("/tmp/no-name.txt") },
  ] as unknown as ChannelAttachment[];
  const note = buildAttachmentPathNote(atts, new Set([resolve("/tmp/a.txt"), resolve("/tmp/no-name.txt")]), false);
  assert.ok(note);
  const noteText = (note as unknown as { text: string }).text;
  assert.match(noteText, /\[Registered attachment files in this session:\]/);
  const lines = noteText.split("\n").filter((l: string) => l.startsWith("- "));
  assert.equal(lines.length, 2, "同名路径应去重为一行");
  assert.match(lines[0]!, /a\.txt: /);
  assert.ok(lines[0]!.includes(resolve("/tmp/a.txt")), "行内容应包含解析后的注册路径");
});

test("attachments: buildAttachmentPathNote 无 allowed 路径返回 undefined", () => {
  const atts = [{ type: "file", name: "x.txt", path: "/tmp/x.txt" }] as unknown as ChannelAttachment[];
  assert.equal(buildAttachmentPathNote(atts, new Set(), false), undefined);
});

test("attachments: collectRegisteredAttachmentReadFiles 收集真实文件、跳过不存在", async () => {
  const dir = mkdtempSync(join(tmpdir(), "att-spec-"));
  const realFile = join(dir, "real.txt");
  writeFileSync(realFile, "hello");
  try {
    const atts = [
      { type: "file", path: realFile, metadata: { channelKey: "web" } },
      { type: "file", path: join(dir, "missing.txt"), metadata: { channelKey: "web" } },
      { type: "file", path: realFile, metadata: {} }, // 无 channelKey 跳过
      { type: "file", path: undefined, metadata: { channelKey: "web" } },
    ] as unknown as ChannelAttachment[];
    const allowed = await collectRegisteredAttachmentReadFiles(atts);
    assert.ok(allowed.includes(realFile), "真实文件应被收集");
    assert.ok(!allowed.some(p => p.includes("missing")), "缺失文件应跳过");
    // resolve 与 realpath 在 /tmp 为 symlink 的平台（macOS）是两个规范化路径，
    // Linux 上相同——断言去重后唯一且至少一条。
    assert.equal(new Set(allowed).size, allowed.length, "路径应去重");
    assert.ok(allowed.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attachments: attachmentsToContentBlocks image/text 直通、无附件空结果", async () => {
  const empty = await attachmentsToContentBlocks(undefined);
  assert.deepEqual(empty, { blocks: [], directContentPaths: new Set(), hasDiagnostics: false });

  const image = await attachmentsToContentBlocks([
    { type: "image", content: "aGVsbG8=", mimeType: "image/png", bytes: 5 },
  ] as unknown as ChannelAttachment[]);
  assert.equal(image.blocks[0]?.type, "image");
  assert.equal((image.blocks[0] as unknown as { source: string }).source, "base64");

  const text = await attachmentsToContentBlocks([
    { type: "text", content: "纯文本" },
  ] as unknown as ChannelAttachment[]);
  assert.equal(text.blocks[0]?.type, "text");
  assert.equal((text.blocks[0] as unknown as { text: string }).text, "纯文本");
});

test("attachments: isReadFileInspectableAttachment 判定", () => {
  assert.equal(
    isReadFileInspectableAttachment({ type: "image", mimeType: "image/png" } as unknown as ChannelAttachment),
    true,
  );
  assert.equal(
    isReadFileInspectableAttachment({ type: "file", mimeType: "application/pdf" } as unknown as ChannelAttachment),
    true,
  );
  assert.equal(
    isReadFileInspectableAttachment({ type: "file", mimeType: "text/plain" } as unknown as ChannelAttachment),
    true,
  );
  assert.equal(
    isReadFileInspectableAttachment({
      type: "file",
      path: "/tmp/report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    } as unknown as ChannelAttachment),
    false,
    "Office 二进制扩展名不可用 read_file 检视",
  );
});

test("attachments: safeAllowedAttachmentPath 集合校验", () => {
  const allowed = new Set([resolve("/tmp/a.txt")]);
  assert.equal(safeAllowedAttachmentPath(resolve("/tmp/a.txt"), allowed), resolve("/tmp/a.txt"));
  assert.equal(safeAllowedAttachmentPath(resolve("/tmp/b.txt"), allowed), undefined);
});
