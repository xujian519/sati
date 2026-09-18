/**
 * UI 侧协议默认镜像（`ui/src/shared/modelProtocolDefaults.json`）与引擎兜底的一致性门禁。
 *
 * 设置页要用这份镜像显示「生效窗口」，因为模型既未声明 `capabilities`、又未命中内置
 * catalog 时，引擎取的就是协议默认（`ui` 不能 import `src/`，只能镜像）。两处一旦漂移，
 * 就会重现 issue #449 的「UI 提示 200k / 后端生效 128k」。
 *
 * 断言走引擎真实解析（`parseModelConfig`），而不是直接比常量：协议 → 常量 的映射本身
 * 也是解析逻辑的一部分（当前 `openai-responses` 复用 openai 默认）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseModelConfig } from "../../src/model/config/parseModelConfig.js";

/** Every protocol the engine accepts (`ModelProtocol`), in mirror order. */
const PROTOCOLS = ["openai", "openai-responses", "anthropic", "google"] as const;

/** 源码树定位：编译产物（dist/tests）与源码直跑都要能找到仓库根。 */
function repoRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (existsSync(join(dir, "tsconfig.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("未找到仓库根目录（向上查找 tsconfig.json 失败）");
    dir = parent;
  }
}

type ProtocolDefaults = { maxContextTokens: number; maxOutputTokens: number };

const mirrorPath = join(repoRoot(import.meta.url), "ui", "src", "shared", "modelProtocolDefaults.json");
const mirror = JSON.parse(readFileSync(mirrorPath, "utf8")) as Record<string, ProtocolDefaults>;

test("UI 协议默认镜像覆盖引擎接受的每个协议", () => {
  assert.deepEqual(Object.keys(mirror).sort(), [...PROTOCOLS].sort());
});

for (const protocol of PROTOCOLS) {
  test(`UI 协议默认镜像与引擎解析一致：${protocol}`, () => {
    const config = parseModelConfig({
      providers: {
        probe: {
          protocol,
          url: "https://example.test/v1",
          apiKey: "test-key",
          // 无 capabilities → 落到协议默认，即设置页要展示的那个值。
          models: { probe: {} },
        },
      },
    });

    const capabilities = config.providers.probe?.models.probe?.capabilities;
    assert.ok(capabilities, `应解析出 ${protocol} 的模型能力`);
    assert.deepEqual(
      {
        maxContextTokens: capabilities.maxContextTokens,
        maxOutputTokens: capabilities.maxOutputTokens,
      },
      mirror[protocol],
    );
  });
}
