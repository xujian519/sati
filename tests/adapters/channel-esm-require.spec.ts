import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveWebSocketImpl } from "../../src/adapters/channel/protocol/resolveWebSocketImpl.js";

const require = createRequire(import.meta.url);

const REPO_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found (no package.json ancestor)");
    dir = parent;
  }
  return dir;
})();

/**
 * 包是 ESM（"type": "module"），CommonJS 的 `require` 全局不存在。可选 SDK 的
 * `try { require(...) } catch` 会把 ReferenceError 吞成「未安装」，让频道静默不可用。
 * 这里锁定 8 个惰性加载点都必须先声明 `createRequire(import.meta.url)`。
 */
const OPTIONAL_SDK_FILES = [
  "src/adapters/channel/discord/DiscordChannel.ts",
  "src/adapters/channel/matrix/MatrixChannel.ts",
  "src/adapters/channel/dingtalk/DingTalkChannel.ts",
  "src/adapters/channel/slack/SlackChannel.ts",
  "src/adapters/channel/email/EmailChannel.ts",
  "src/adapters/channel/sms/SmsChannel.ts",
  "src/adapters/channel/telegram/TelegramChannel.ts",
  "src/adapters/channel/protocol/resolveWebSocketImpl.ts",
];

const REQUIRE_DECLARATION = "const require = createRequire(import.meta.url);";

test("可选频道在 ESM 下通过 createRequire 惰性加载 SDK", () => {
  for (const relativePath of OPTIONAL_SDK_FILES) {
    const source = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    assert.match(
      source,
      /import \{ createRequire \} from "node:module";/,
      `${relativePath}: 缺少 node:module createRequire 导入`,
    );
    const declarationAt = source.indexOf(REQUIRE_DECLARATION);
    assert.notEqual(declarationAt, -1, `${relativePath}: 缺少模块级 createRequire 声明`);
    const firstRequireAt = source.indexOf("require(");
    assert.ok(firstRequireAt > declarationAt, `${relativePath}: 首个 require( 出现在 createRequire 声明之前`);
  }
});

test("resolveWebSocketImpl 在 ESM 下优先返回 ws 而不是全局回退", () => {
  const ws = require("ws") as { WebSocket: unknown };
  assert.equal(resolveWebSocketImpl(), ws.WebSocket);
});
