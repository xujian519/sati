// @vitest-environment node
/**
 * 配置路由的模型引用校验：保存后的配置里不得留下指不到 provider/model 的引用。
 *
 * 单独成文件（而非并进 `config.test.js`）：`config.test.js` 已命中
 * `check-architecture-boundaries` 的 file-size 豁免，棘轮规定存量豁免文件不得再增长；
 * 本文件的 harness 与 ui/server 其余路由测试一样自带一份（`memory.test.js` /
 * `gateway.test.js` 同形），改动写入契约时需同步 `config.test.js` 的
 * `createDiskConfigApp`。
 */
import express from "express";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeFetch = globalThis.fetch;
const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.SATI_HOME;
  delete process.env.SATI_CONFIG_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("dangling model references", () => {
  // `model.providers.<id>.models` 是「模型 id → 定义」的**映射**；写成数组时
  // resolveModel 认不出任何已配置模型（isRecord 排除数组），用例会因「引用从来
  // 就没解析成功」而假绿——故这里统一按映射构造。
  const modelMap = ids => Object.fromEntries(ids.map(id => [id, {}]));
  const providerWith = modelIds =>
    stringifyYaml({
      schemaVersion: 1,
      agent: { model: "openai/gpt-4o" },
      model: {
        providers: {
          openai: {
            protocol: "openai",
            url: "https://api.openai.com/v1",
            apiKey: "sk-x",
            models: modelMap(modelIds),
          },
        },
      },
    });

  it("saves a config whose agent.model resolves (对照：校验不误报)", async () => {
    const { request } = await createDiskConfigApp(providerWith(["gpt-4o"]));

    const response = await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ raw: providerWith(["gpt-4o"]) }),
    });

    expect(response.status).toBe(200);
    expect(response.body.validation?.valid).toBe(true);
  });

  it("rejects a save whose agent.model no longer resolves after the model is deleted", async () => {
    const { request } = await createDiskConfigApp(providerWith(["gpt-4o"]));

    const response = await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ raw: providerWith(["gpt-4o-mini"]) }),
    });

    expect(response.status).toBe(400);
    expect(String(response.body.validation?.errors?.join(" "))).toContain("agent.model");
  });

  it("rejects deleting a whole provider that agent.model still points at", async () => {
    const twoProviders = keepChild =>
      stringifyYaml({
        schemaVersion: 1,
        agent: { model: "child/c1" },
        model: {
          providers: {
            openai: {
              protocol: "openai",
              url: "https://api.openai.com/v1",
              apiKey: "sk-x",
              models: { "gpt-4o": {} },
            },
            ...(keepChild
              ? {
                  child: {
                    protocol: "openai",
                    url: "https://child.example/v1",
                    apiKey: "sk-c",
                    models: { c1: {} },
                  },
                }
              : {}),
          },
        },
      });
    const { request } = await createDiskConfigApp(twoProviders(true));

    const response = await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ raw: twoProviders(false) }),
    });

    expect(response.status).toBe(400);
    expect(String(response.body.validation?.errors?.join(" "))).toContain('agent.model="child/c1"');
  });

  it("resets an agent.subagents.default that loses its provider instead of saving a dangling ref", async () => {
    const withChild = keepChild =>
      stringifyYaml({
        schemaVersion: 1,
        agent: { model: "openai/gpt-4o", subagents: { default: "child/c1" } },
        model: {
          providers: {
            openai: {
              protocol: "openai",
              url: "https://api.openai.com/v1",
              apiKey: "sk-x",
              models: { "gpt-4o": {} },
            },
            ...(keepChild
              ? {
                  child: {
                    protocol: "openai",
                    url: "https://child.example/v1",
                    apiKey: "sk-c",
                    models: { c1: {} },
                  },
                }
              : {}),
          },
        },
      });
    const { request } = await createDiskConfigApp(withChild(true));

    const response = await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ raw: withChild(false) }),
    });

    // 子代理默认模型有「继承 agent.model」的既有回退，因此不阻塞保存——落盘前把它
    // 归一到 inherit，磁盘上不留悬空引用（与 agent.model 的硬拦不同）。
    expect(response.status).toBe(200);
    expect(response.body.config?.agent?.subagents?.default).toBe("inherit");
    expect(String(response.body.raw)).toContain("default: inherit");
  });

  it("rejects a save whose router reference no longer resolves after the model is deleted", async () => {
    const withRouter = modelIds =>
      stringifyYaml({
        schemaVersion: 1,
        agent: { model: "openai/gpt-4o" },
        model: {
          providers: {
            openai: {
              protocol: "openai",
              url: "https://api.openai.com/v1",
              apiKey: "sk-x",
              models: modelMap(modelIds),
            },
          },
        },
        router: { enabled: true, scenarios: { cheap: "openai/gpt-4o-mini" } },
      });
    const { request } = await createDiskConfigApp(withRouter(["gpt-4o", "gpt-4o-mini"]));

    const response = await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ raw: withRouter(["gpt-4o"]) }),
    });

    expect(response.status).toBe(400);
    expect(String(response.body.validation?.errors?.join(" "))).toContain("router.scenarios.cheap");
  });
});

/** 在临时目录里放一份配置文件，并把真实 config 路由挂到一个 express app 上。 */
async function createDiskConfigApp(initialRaw) {
  const pilotHome = mkdtempSync(join(tmpdir(), "sati-config-refs-"));
  tempDirs.push(pilotHome);
  const configPath = join(pilotHome, "sati.yaml");
  writeFileSync(configPath, initialRaw, "utf8");

  process.env.SATI_HOME = pilotHome;
  process.env.SATI_CONFIG_PATH = configPath;

  vi.resetModules();
  vi.doUnmock("../services/satiConfig.js");
  vi.doMock("../services/satiConfigWatcher.js", () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  vi.doMock("../services/satiConfigReloader.js", () => ({
    reloadSatiConfig: vi.fn(async () => ({ processEnv: { reloaded: true } })),
  }));
  vi.doMock("../sati-bridge.js", () => ({
    getSatiGateway: vi.fn(async () => ({ reloadConfig: vi.fn(async () => undefined) })),
  }));

  const { default: configRoutes } = await import("./config.js");
  const app = express();
  app.use(express.json());
  app.use("/api/config", configRoutes);

  return {
    configPath,
    request: (path, init) => requestStatusJson(app, path, init),
  };
}

async function requestStatusJson(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      ...init,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
