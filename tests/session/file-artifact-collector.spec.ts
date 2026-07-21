import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileArtifactCollector } from "../../src/session/artifacts/FileArtifactCollector.js";

test("file artifacts include final user-facing files and exclude build internals", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-artifacts-"));
  const uploadedFile = join(projectRoot, ".tmp", "chat-attachments", "source.xlsx");
  try {
    await mkdir(join(projectRoot, ".pilotdeck", "tool-results"), { recursive: true });
    await mkdir(join(projectRoot, "qa"), { recursive: true });
    await mkdir(join(projectRoot, ".tmp", "chat-attachments"), { recursive: true });
    await writeFile(join(projectRoot, "existing.docx"), "before");
    await writeFile(uploadedFile, "upload-before");

    const collector = await FileArtifactCollector.start({
      cwd: projectRoot,
      allowedInputPaths: [uploadedFile],
      now: () => new Date("2026-07-21T10:00:00.000Z"),
    });

    await writeFile(join(projectRoot, "existing.docx"), "after with more bytes");
    await writeFile(join(projectRoot, "result.pptx"), "presentation");
    await writeFile(uploadedFile, "upload-after with more bytes");
    await writeFile(join(projectRoot, ".pilotdeck_build.mjs"), "build program");
    await writeFile(join(projectRoot, ".pilotdeck", "tool-results", "result.json"), "{}");
    await writeFile(join(projectRoot, "qa", "slide-01.png"), "qa image");
    await writeFile(join(projectRoot, "audit.json"), "{}");

    const artifacts = await collector.finish("incomplete");

    assert.deepEqual(artifacts.map((artifact) => artifact.path), [
      ".tmp/chat-attachments/source.xlsx",
      "existing.docx",
      "result.pptx",
    ]);
    assert.deepEqual(artifacts.map((artifact) => artifact.operation), ["updated", "updated", "created"]);
    assert.ok(artifacts.every((artifact) => artifact.status === "incomplete"));
    assert.ok(artifacts.every((artifact) => artifact.sha256.length === 64));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
