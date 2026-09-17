/**
 * #356 退役路由面的回归护栏。
 *
 * 2026-08 的精炼审计（C34）把 `ui/server` 的 9 条路由登记为「零消费」，
 * 2026-09-17 复核后下线——裁定与逐条证据见
 * `docs/notes/implemented/2026-09-17-ui-server-dead-surface-retirement.md`：
 *   - `taskmaster` 8 条：`/detect/:projectName`、`/detect-all`、
 *     `/initialize/:projectName`、`/next/:projectName` 与 `/prd` 的
 *     GET / POST / GET-file / DELETE；
 *   - `commands` 1 条：`/api/commands/load`。
 *
 * 这里钉的是**存活**路由的完整清单，而不是「退役路径不在表里」——后者在路由表
 * 解析为空时恒真（本类判据最危险的失败模式）。断言完整清单同时防两件事：退役路径
 * 被静默复活，以及新增路由未经登记就进入对外面。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

/** 读出 router 上登记的全部 `METHOD /path`，排序后返回。 */
async function routeTable(specifier, mocks) {
  for (const [spec, factory] of Object.entries(mocks)) {
    vi.doMock(spec, factory);
  }
  const { default: router } = await import(specifier);
  return router.stack
    .filter(layer => layer.route)
    .flatMap(layer => Object.keys(layer.route.methods).map(method => `${method.toUpperCase()} ${layer.route.path}`))
    .sort();
}

describe("ui/server 路由面（#356 退役后）", () => {
  it("taskmaster 只剩 8 条有前端消费的路由", async () => {
    const routes = await routeTable("./taskmaster.js", {
      // `projects.js` 会连带拉入未编译的 `src/web/server/index.js`。
      "../projects.js": () => ({ extractProjectDirectory: vi.fn() }),
    });

    expect(routes).toEqual([
      "GET /installation-status",
      "GET /prd-templates",
      "GET /tasks/:projectName",
      "POST /add-task/:projectName",
      "POST /apply-template/:projectName",
      "POST /init/:projectName",
      "POST /parse-prd/:projectName",
      "PUT /update-task/:projectName/:taskId",
    ]);
  });

  it("commands 只剩 /list 与 /execute", async () => {
    const routes = await routeTable("./commands.js", {
      "../services/satiConfig.js": () => ({ readSatiConfigFile: vi.fn(() => ({ config: {} })), resolveModel: vi.fn() }),
      "../turnkey-slash.js": () => ({ executeTurnkeySlashCommand: vi.fn() }),
      "../../../src/adapters/channel/protocol/ChannelCommandRegistry.js": () => ({
        getRegisteredCommands: vi.fn(() => []),
      }),
      "../../../src/cli/commands/chatSearch.js": () => ({ runChatSearchFormatted: vi.fn() }),
    });

    expect(routes).toEqual(["POST /execute", "POST /list"]);
  });
});
