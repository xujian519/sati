import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { WeComChannel } from "../../src/adapters/channel/wecom/WeComChannel.js";
import type { ChannelAttachment } from "../../src/gateway/index.js";

/**
 * 上游 #545（Sati 只取其中 1 行）：企微入站附件缺 `metadata.channelKey`。
 *
 * `collectRegisteredAttachmentReadFiles`（src/gateway/client/attachments.ts）以
 * `metadata?.channelKey` 为登记前提 —— 缺失时该附件永不进入 allowedReadFiles，
 * 模型对它的 read_file 会被白名单拒绝。其余渠道（飞书显式写、微信由
 * ImAttachmentStore 统一注入）都有，只有企微这条自建 metadata 的分支漏了。
 */
test("企微入站文件带 channelKey，使其能被登记为可读附件", async () => {
  const channel = new WeComChannel({ uuid: () => "00000000-0000-4000-8000-000000000001" });
  const cacheInboundMedia = (
    channel as unknown as {
      cacheInboundMedia: (kind: "file", media: Record<string, unknown>) => Promise<ChannelAttachment | undefined>;
    }
  ).cacheInboundMedia.bind(channel);

  const attachment = await cacheInboundMedia("file", {
    filename: "report.docx",
    content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    base64: Buffer.from("PKfixture-office-document").toString("base64"),
  });

  assert.ok(attachment?.path);
  try {
    assert.equal(attachment.metadata?.channelKey, "wecom");
  } finally {
    await rm(attachment.path, { force: true });
  }
});
