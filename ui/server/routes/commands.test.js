import express from "express";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const nativeFetch = globalThis.fetch;
const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.SATI_HOME;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("commands routes", () => {
  it("executes user commands discovered under custom SATI_HOME", async () => {
    const pilotHome = mkdtempSync(join(tmpdir(), "sati-commands-route-"));
    tempDirs.push(pilotHome);
    process.env.SATI_HOME = pilotHome;

    const commandsDir = join(pilotHome, "commands");
    mkdirSync(commandsDir, { recursive: true });
    const commandPath = join(commandsDir, "hello.md");
    writeFileSync(commandPath, "---\ndescription: Says hello\n---\nHello $1", "utf8");

    const { request } = await createCommandsApp();

    const result = await request("/api/commands/execute", {
      method: "POST",
      body: JSON.stringify({
        commandName: "/hello",
        commandPath,
        args: ["Sati"],
      }),
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      type: "custom",
      command: "/hello",
      content: "Hello Sati",
    });
  });

  // /execute must keep the same boundary it had before the shared helper landed.
  describe("POST /api/commands/execute path whitelist", () => {
    it("denies a path outside every allowed directory", async () => {
      const pilotHome = mkdtempSync(join(tmpdir(), "sati-commands-exec-"));
      tempDirs.push(pilotHome);
      process.env.SATI_HOME = pilotHome;

      const secretPath = join(pilotHome, ".aws", "credentials");
      mkdirSync(join(pilotHome, ".aws"), { recursive: true });
      writeFileSync(secretPath, "aws_secret=1", "utf8");

      const { request } = await createCommandsApp();
      const result = await request("/api/commands/execute", {
        method: "POST",
        body: JSON.stringify({ commandName: "/leak", commandPath: secretPath }),
      });

      expect(result.status).toBe(403);
      expect(JSON.stringify(result.body)).not.toContain("aws_secret");
    });

    it("denies a path under the real $HOME", async () => {
      const outsidePath = join(homedir(), ".sati-issue-365-should-never-be-readable", "id_rsa");

      const { request } = await createCommandsApp();
      const result = await request("/api/commands/execute", {
        method: "POST",
        body: JSON.stringify({ commandName: "/leak", commandPath: outsidePath }),
      });

      expect(result.status).toBe(403);
    });

    it("denies a skill path when no project context is supplied", async () => {
      const pilotHome = mkdtempSync(join(tmpdir(), "sati-commands-exec-"));
      const project = mkdtempSync(join(tmpdir(), "sati-commands-exec-proj-"));
      tempDirs.push(pilotHome, project);
      process.env.SATI_HOME = pilotHome;

      const commandPath = join(project, ".sati", "commands", "deploy.md");
      mkdirSync(join(project, ".sati", "commands"), { recursive: true });
      writeFileSync(commandPath, "deploy", "utf8");

      const { request } = await createCommandsApp();
      const result = await request("/api/commands/execute", {
        method: "POST",
        body: JSON.stringify({ commandName: "/deploy", commandPath }),
      });

      expect(result.status).toBe(403);
    });
  });
});

async function createCommandsApp() {
  vi.doMock("../services/satiConfig.js", () => ({
    readSatiConfigFile: vi.fn(() => ({ config: {} })),
    resolveModel: vi.fn(model => model),
  }));
  vi.doMock("../turnkey-slash.js", () => ({
    executeTurnkeySlashCommand: vi.fn(async () => ({})),
  }));
  vi.doMock("../../../src/adapters/channel/protocol/ChannelCommandRegistry.js", () => ({
    getRegisteredCommands: vi.fn(() => []),
  }));
  vi.doMock("../../../src/cli/commands/chatSearch.js", () => ({
    runChatSearchFormatted: vi.fn(async () => ({ result: {}, text: "" })),
  }));

  const { default: commandsRoutes } = await import("./commands.js");
  const app = express();
  app.use(express.json());
  app.use("/api/commands", commandsRoutes);

  return {
    request: (path, init) => requestJson(app, path, init),
  };
}

async function requestJson(app, path, init = {}) {
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
