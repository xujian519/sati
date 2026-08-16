import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    { type: "file", name: "a.txt", path: "/tmp/a.txt" },
    { type: "file", name: "a-dup.txt", path: "/tmp/a.txt" }, // 同一路径去重
    { type: "file", path: "/tmp/no-name.txt" },
  ] as unknown as ChannelAttachment[];
  const note = buildAttachmentPathNote(atts, new Set(["/tmp/a.txt", "/tmp/no-name.txt"]), new Set(), false);
  assert.ok(note);
  const noteText = (note as unknown as { text: string }).text;
  assert.match(noteText, /\[Registered attachment files in this session:\]/);
  const lines = noteText.split("\n").filter((l: string) => l.startsWith("- "));
  assert.equal(lines.length, 2, "同名路径应去重为一行");
  assert.match(lines[0]!, /a\.txt: \/tmp\/a\.txt/);
});

test("attachments: buildAttachmentPathNote 无 allowed 路径返回 undefined", () => {
  const atts = [{ type: "file", name: "x.txt", path: "/tmp/x.txt" }] as unknown as ChannelAttachment[];
  assert.equal(buildAttachmentPathNote(atts, new Set(), new Set(), false), undefined);
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
    assert.equal(allowed.length, 2, "resolve + realpath 两个规范化路径（macOS /tmp 为 symlink）");
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
  assert.equal(safeAllowedAttachmentPath("/tmp/a.txt", new Set(["/tmp/a.txt"])), "/tmp/a.txt");
  assert.equal(safeAllowedAttachmentPath("/tmp/b.txt", new Set(["/tmp/a.txt"])), undefined);
});
