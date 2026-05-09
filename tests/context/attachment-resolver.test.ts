import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AttachmentResolver } from "../../src/context/attachments/AttachmentResolver.js";

test("AttachmentResolver reads small text files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-att-"));
  try {
    const path = join(dir, "doc.md");
    writeFileSync(path, "# Hello", "utf8");
    const resolver = new AttachmentResolver();
    const result = await resolver.resolve({ type: "file", path });
    assert.equal(result.blocks.length, 1);
    assert.match((result.blocks[0] as { text: string }).text, /<attachment path=/);
    assert.match((result.blocks[0] as { text: string }).text, /# Hello/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AttachmentResolver flags missing attachments", async () => {
  const resolver = new AttachmentResolver();
  const result = await resolver.resolve({ type: "file", path: "/tmp/__never_exists__.txt" });
  assert.equal(result.blocks.length, 0);
  assert.equal(result.diagnostics[0]?.code, "attachment_missing");
});

test("AttachmentResolver rejects files larger than maxFileBytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-att-"));
  try {
    const path = join(dir, "big.txt");
    writeFileSync(path, "x".repeat(2_000), "utf8");
    const resolver = new AttachmentResolver({ maxFileBytes: 1_000 });
    const result = await resolver.resolve({ type: "file", path });
    assert.equal(result.diagnostics[0]?.code, "attachment_too_large");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AttachmentResolver returns base64 image with intentional_difference diagnostic", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-att-"));
  try {
    const path = join(dir, "tiny.png");
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const resolver = new AttachmentResolver();
    const result = await resolver.resolve({ type: "image", path });
    assert.equal(result.blocks[0]?.type, "image");
    assert.equal((result.blocks[0] as { mimeType: string }).mimeType, "image/png");
    assert.ok(result.diagnostics.some((d) => d.code === "image_no_resize"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AttachmentResolver estimates PDF pages by file size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-att-"));
  try {
    const path = join(dir, "doc.pdf");
    writeFileSync(path, Buffer.alloc(250_000, 0));
    const resolver = new AttachmentResolver({ bytesPerPdfPage: 100_000 });
    const result = await resolver.resolve({ type: "pdf", path });
    assert.equal(result.blocks[0]?.type, "pdf");
    assert.equal((result.blocks[0] as { pages: number }).pages, 3);
    assert.ok(result.diagnostics.some((d) => d.code === "pdf_size_estimate"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
