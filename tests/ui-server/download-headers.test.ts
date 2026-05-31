import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { contentDispositionAttachment } = require(
  join(process.cwd(), "ui/server/utils/downloadHeaders.js"),
) as {
  contentDispositionAttachment: (filename: string) => string;
};

test("contentDispositionAttachment keeps non-ASCII filenames header-safe", () => {
  const filename = "chapter-01a-市场情绪与资金流向.pptx";
  const header = contentDispositionAttachment(filename);

  assert.match(header, /^attachment; filename="chapter-01a-_________.pptx"/);
  assert.ok(header.includes("filename*=UTF-8''chapter-01a-"));
  assert.ok(header.includes("%E5%B8%82%E5%9C%BA"));
  assert.doesNotThrow(() => {
    const res = new http.ServerResponse({ method: "GET" } as http.IncomingMessage);
    res.setHeader("Content-Disposition", header);
  });
});

test("contentDispositionAttachment strips unsafe filename characters", () => {
  const header = contentDispositionAttachment('bad/name:"x".pptx');

  assert.equal(
    header,
    "attachment; filename=\"bad_name__x_.pptx\"; filename*=UTF-8''bad_name__x_.pptx",
  );
});
