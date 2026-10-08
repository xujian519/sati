// @vitest-environment node
/**
 * project-preview 路由的鉴权守卫（挂载顺序前移的风险控制）。
 *
 * 该 router 挂载在 `/api/projects` 全局鉴权闸之前（见 ui/server/index.js），因此每一条路由
 * 都必须自带鉴权中间件；否则未来新增的路由会裸奔。本测试遍历真实 router 的全部路由并断言这一点，
 * 同时锁定路由清单：新增路由时测试会失败，提醒开发者审查它的鉴权。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../constants/config.js", () => ({
  IS_PLATFORM: false,
  DISABLE_LOCAL_AUTH: false,
}));

vi.mock("../utils/consoleLogger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../database/db.js", () => ({
  appConfigDb: { getOrCreateJwtSecret: () => "test-secret-for-route-guard" },
  userDb: { getUserById: () => null, getFirstUser: () => null },
}));

const { authenticateToken, authenticateProjectPreview } = await import("../middleware/auth.js");
const { default: previewRouter } = await import("./project-preview.js");

const AUTH_MIDDLEWARE = new Set([authenticateToken, authenticateProjectPreview]);

function routeLayers(router) {
  return router.stack
    .filter(layer => layer.route)
    .map(layer => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).sort().join(","),
      handles: layer.route.stack.map(inner => inner.handle),
    }));
}

describe("project-preview 路由鉴权守卫", () => {
  const routes = routeLayers(previewRouter);

  it.each(routes.map(route => [`${route.methods.toUpperCase()} ${route.path}`, route]))(
    "%s 的首个处理器即鉴权中间件（鉴权先于业务处理器执行）",
    (_label, route) => {
      expect(AUTH_MIDDLEWARE.has(route.handles[0])).toBe(true);
    },
  );

  it("路由清单与审查时一致（新增路由须同步审查鉴权）", () => {
    const signature = routes.map(route => `${route.methods} ${route.path}`).sort();
    expect(signature).toEqual(
      [
        "get /api/office-preview/status",
        "get /api/projects/:projectName/files/preview/pdf",
        "get /api/projects/:projectName/files/preview/spreadsheet/data",
        "get /api/projects/:projectName/files/preview/spreadsheet/manifest",
        "get /api/projects/:projectName/files/preview/spreadsheet/sheet",
        "get /api/projects/:projectName/preview/{*splat}",
        "post /api/projects/:projectName/preview-token",
      ].sort(),
    );
  });
});
