import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolResultBudget } from "../../src/context/budget/ToolResultBudget.js";
import type {
  CanonicalMessage,
  CanonicalToolResultBlock,
  CanonicalToolResultReferenceBlock,
} from "../../src/model/index.js";

function bigToolResult(toolCallId: string, size: number): CanonicalMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId,
        content: [{ type: "text", text: "x".repeat(size) }],
      } satisfies CanonicalToolResultBlock,
    ],
  };
}

test("ToolResultBudget passes through small tool results untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-trb-"));
  try {
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 100 });
    const message = bigToolResult("tool-1", 50);
    const result = await budget.applyToMessage(message);
    assert.equal(result, message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ToolResultBudget replaces oversized tool_result with reference block and persists original", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-trb-"));
  try {
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 100, previewBytes: 20 });
    const message = bigToolResult("tool-2", 500);
    const projected = await budget.applyToMessage(message);
    const block = projected.content[0] as CanonicalToolResultReferenceBlock;
    assert.equal(block.type, "tool_result_reference");
    assert.equal(block.toolCallId, "tool-2");
    assert.equal(block.originalBytes, 500);
    assert.equal(block.preview.length, 20);
    assert.equal(block.hasMore, true);
    assert.equal(block.mimeType, "text/plain");
    assert.ok(existsSync(block.path));
    assert.equal(readFileSync(block.path, "utf8").length, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ToolResultBudget reuses existing replacement record without rewriting the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-trb-"));
  try {
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 100 });
    const first = await budget.applyToMessage(bigToolResult("tool-3", 200));
    const second = await budget.applyToMessage(bigToolResult("tool-3", 200));
    const firstBlock = first.content[0] as CanonicalToolResultReferenceBlock;
    const secondBlock = second.content[0] as CanonicalToolResultReferenceBlock;
    assert.equal(firstBlock.path, secondBlock.path);
    assert.equal(budget.getState().replacements.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ToolResultBudget detects JSON content and uses .json extension", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-trb-"));
  try {
    const json = JSON.stringify({ value: "y".repeat(500) });
    const message: CanonicalMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "tool-json",
          content: [{ type: "text", text: json }],
        },
      ],
    };
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 100 });
    const projected = await budget.applyToMessage(message);
    const block = projected.content[0] as CanonicalToolResultReferenceBlock;
    assert.match(block.path, /\.json$/);
    assert.equal(block.mimeType, "application/json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ToolResultBudget leaves multimodal tool results inline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-trb-"));
  try {
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 10 });
    const message: CanonicalMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "tool-image",
          content: [
            { type: "text", text: "preview" },
            { type: "image", source: "base64", data: "x".repeat(500), mimeType: "image/png", bytes: 500 },
          ],
        },
      ],
    };

    const projected = await budget.applyToMessage(message);
    assert.equal(projected.content[0]?.type, "tool_result");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
