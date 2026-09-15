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

  // Regression for #365: /load used to accept any path under $HOME, so it could
  // read ~/.ssh/id_rsa and friends through the browser-reachable HTTP server.
  describe("POST /api/commands/load path whitelist", () => {
    it("loads a command from the Sati home scope", async () => {
      const pilotHome = mkdtempSync(join(tmpdir(), "sati-commands-load-"));
      tempDirs.push(pilotHome);
      process.env.SATI_HOME = pilotHome;

      const commandsDir = join(pilotHome, "commands");
      mkdirSync(commandsDir, { recursive: true });
      const commandPath = join(commandsDir, "hello.md");
      writeFileSync(commandPath, "---\ndescription: Says hello\n---\nHello there", "utf8");

      const { request } = await createCommandsApp();
      const result = await request("/api/commands/load", {
        method: "POST",
        body: JSON.stringify({ commandPath }),
      });

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        metadata: { description: "Says hello" },
        content: "Hello there",
      });
    });

    it("loads a skill from the project scope when context.projectPath is supplied", async () => {
      const pilotHome = mkdtempSync(join(tmpdir(), "sati-commands-load-"));
      const project = mkdtempSync(join(tmpdir(), "sati-commands-load-proj-"));
      tempDirs.push(pilotHome, project);
      process.env.SATI_HOME = pilotHome;

      const skillsDir = join(project, ".sati", "skills", "demo");
      mkdirSync(skillsDir, { recursive: true });
      const commandPath = join(skillsDir, "SKILL.md");
      writeFileSync(commandPath, "---\ndescription: Demo skill\n---\nbody", "utf8");

      const { request } = await createCommandsApp();
      const result = await request("/api/commands/load", {
        method: "POST",
        body: JSON.stringify({ commandPath, context: { projectPath: project } }),
      });

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ metadata: { description: "Demo skill" } });
    });

    it("denies arbitrary files directly under the real $HOME", async () => {
      // The original bug was scoped to the *real* home directory: the old check
      // was `resolvedPath.startsWith(homedir())`, so any $HOME file passed
      // while temp-dir paths did not. Pointing at a non-existent $HOME path
      // keeps this side-effect free while still distinguishing policies: a
      // denial returns 403, whereas the old code fell through to readFile and
      // reported 404 (ENOENT) — i.e. it had already accepted the path.
      const outsidePath = join(homedir(), ".sati-issue-365-should-never-be-readable", "id_rsa");

      const { request } = await createCommandsApp();
      const result = await request("/api/commands/load", {
        method: "POST",
        body: JSON.stringify({ commandPath: outsidePath }),
      });

      expect(result.status).toBe(403);
      expect(result.body.error).toBe("Access denied");
    });

    it("denies a real file under the real $HOME", async () => {
      // Write a canary inside the real home, which is the only way to prove the
      // route refuses a file that actually exists under $HOME.
      let canaryDir;
      try {
        canaryDir = mkdtempSync(join(homedir(), ".sati-issue-365-canary-"));
      } catch {
        return; // read-only home (some CI sandboxes) — covered by the test above
      }
      tempDirs.push(canaryDir);
      const canary = join(canaryDir, "id_rsa");
      writeFileSync(canary, "-----BEGIN PRIVATE KEY-----", "utf8");

      const { request } = await createCommandsApp();
      const result = await request("/api/commands/load", {
        method: "POST",
        body: JSON.stringify({ commandPath: canary }),
      });

      expect(result.status).toBe(403);
      expect(JSON.stringify(result.body)).not.toContain("PRIVATE KEY");
    });

    it("denies arbitrary files under the Sati home outside command/skill scopes", async () => {
      const pilotHome = mkdtempSync(join(tmpdir(), "sati-commands-load-"));
      tempDirs.push(pilotHome);
      process.env.SATI_HOME = pilotHome;

      const secretsDir = join(pilotHome, ".ssh");
      mkdirSync(secretsDir, { recursive: true });
      const secretPath = join(secretsDir, "id_rsa");
      writeFileSync(secretPath, "PRIVATE KEY", "utf8");

      const { request } = await createCommandsApp();
      const result = await request("/api/commands/load", {
        method: "POST",
        body: JSON.stringify({ commandPath: secretPath }),
      });

      expect(result.status).toBe(403);
      expect(result.body.error).toBe("Access denied");
      expect(JSON.stringify(result.body)).not.toContain("PRIVATE KEY");
    });

    it("denies a `.sati/commands` path that is not under a known base", async () => {
      const pilotHome = mkdtempSync(join(tmpdir(), "sati-commands-load-"));
      const unrelated = mkdtempSync(join(tmpdir(), "sati-commands-load-other-"));
      tempDirs.push(pilotHome, unrelated);
      process.env.SATI_HOME = pilotHome;

      const elsewhereDir = join(unrelated, ".sati", "commands");
      mkdirSync(elsewhereDir, { recursive: true });
      const commandPath = join(elsewhereDir, "x.md");
      writeFileSync(commandPath, "payload", "utf8");

      const { request } = await createCommandsApp();
      const result = await request("/api/commands/load", {
        method: "POST",
        body: JSON.stringify({ commandPath }),
      });

      expect(result.status).toBe(403);
    });

    it("denies traversal out of an allowed directory", async () => {
      const pilotHome = mkdtempSync(join(tmpdir(), "sati-commands-load-"));
      tempDirs.push(pilotHome);
      process.env.SATI_HOME = pilotHome;

      mkdirSync(join(pilotHome, "commands"), { recursive: true });
      mkdirSync(join(pilotHome, ".ssh"), { recursive: true });
      writeFileSync(join(pilotHome, ".ssh", "id_rsa"), "PRIVATE KEY", "utf8");

      const { request } = await createCommandsApp();
      const result = await request("/api/commands/load", {
        method: "POST",
        body: JSON.stringify({ commandPath: join(pilotHome, "commands", "..", ".ssh", "id_rsa") }),
      });

      expect(result.status).toBe(403);
    });

    it("still rejects a missing command path", async () => {
      const { request } = await createCommandsApp();
      const result = await request("/api/commands/load", {
        method: "POST",
        body: JSON.stringify({}),
      });

      expect(result.status).toBe(400);
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
