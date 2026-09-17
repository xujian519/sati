/**
 * `POST /api/agent` 对外 HTTP API 的回归判据（issue #414）。
 *
 * 四项缺陷各自一条判据：
 *  (1) 非流式 `messages` 必须由 `kind:"stream_delta"` **对象帧**合并而来
 *      （此前只认 JSON 字符串形态 ⇒ 恒空）；
 *  (2) `cloneGitHubRepo` 的「目录已被另一个仓库占用」必须原样上抛，
 *      不能被内层 catch 换成通用文案；
 *  (3) checkout 已存在分支失败时，报错必须引用**该条命令**的 stderr；
 *  (4) 流式 writer 必须从帧里拿到 sessionId，并且只在会话由本次请求新建时
 *      才允许连同转录一起清理——清理目标是真实位置
 *      `projects/<id>/chats/<safeId>.jsonl`（+ 同名 sidecar 目录），
 *      而不是已无生产者的 `~/.sati/sessions/<id>`。
 *
 * git 通过 PATH 上的假可执行文件注入：本文件不断言 git 的行为，只断言
 * 本路由如何解读 git 的结果。
 */
import express from "express";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeFetch = globalThis.fetch;
const originalPath = process.env.PATH;
const tempDirs = [];
const fakeHome = { path: "" };

beforeEach(() => {
  fakeHome.path = mkdtempSync(join(tmpdir(), "sati-agent-route-home-"));
  tempDirs.push(fakeHome.path);
  process.env.SATI_HOME = fakeHome.path;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  process.env.PATH = originalPath;
  delete process.env.SATI_HOME;
  delete process.env.FAKE_GIT_REMOTE;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("POST /api/agent non-streaming messages", () => {
  it("merges kind-based stream_delta frames into assistant messages", async () => {
    const runChatViaGateway = vi.fn(async (command, options, writer) => {
      writer.send({ kind: "session_created", sessionId: "web:s_test", sessionKey: "web:s_test" });
      writer.send({ kind: "stream_delta", sessionId: "web:s_test", content: "hello " });
      writer.send({ kind: "stream_delta", sessionId: "web:s_test", content: "world" });
      writer.send({
        kind: "complete",
        sessionId: "web:s_test",
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    });

    const projectPath = makeTempDir("sati-agent-project-");
    const { body } = await post(
      "/api/agent",
      {
        projectPath,
        message: "hi",
        stream: "false",
        cleanup: "false",
      },
      { runChatViaGateway },
    );

    expect(body.success).toBe(true);
    expect(body.messages).toEqual([{ role: "assistant", content: "hello world" }]);
    expect(body.tokens.outputTokens).toBe(5);
    expect(body.sessionId).toBe("web:s_test");
  });

  it("keeps legacy JSON-string frames working", async () => {
    const runChatViaGateway = vi.fn(async (command, options, writer) => {
      writer.send(JSON.stringify({ kind: "session_created", sessionId: "web:s_legacy" }));
      writer.send(JSON.stringify({ kind: "stream_delta", sessionId: "web:s_legacy", content: "legacy text" }));
    });

    const projectPath = makeTempDir("sati-agent-project-");
    const { body } = await post(
      "/api/agent",
      {
        projectPath,
        message: "hi",
        stream: "false",
        cleanup: "false",
      },
      { runChatViaGateway },
    );

    expect(body.messages).toEqual([{ role: "assistant", content: "legacy text" }]);
  });
});

describe("POST /api/agent streaming session identity", () => {
  it("learns the session id and the fact that it created the session", async () => {
    let writerRef = null;
    const runChatViaGateway = vi.fn(async (command, options, writer) => {
      writerRef = writer;
      writer.send({ kind: "session_created", sessionId: "web:s_stream", sessionKey: "web:s_stream" });
      writer.send({ kind: "stream_delta", sessionId: "web:s_stream", content: "streamed" });
    });

    const projectPath = makeTempDir("sati-agent-project-");
    const { text } = await post(
      "/api/agent",
      { projectPath, message: "hi", stream: "true", cleanup: "false" },
      { runChatViaGateway },
      { text: true },
    );

    expect(text).toContain('"kind":"stream_delta"');
    expect(writerRef.getSessionId()).toBe("web:s_stream");
    expect(writerRef.sessionCreated).toBe(true);
  });

  it("does not claim a session it did not create", async () => {
    let writerRef = null;
    const runChatViaGateway = vi.fn(async (command, options, writer) => {
      writerRef = writer;
      // 只回落到调用方给定的既有会话（没有 session_created 帧）
      writer.send({ kind: "stream_delta", sessionId: "web:s_existing", content: "resumed" });
    });

    const projectPath = makeTempDir("sati-agent-project-");
    await post(
      "/api/agent",
      { projectPath, message: "hi", stream: "true", cleanup: "false" },
      { runChatViaGateway },
      { text: true },
    );

    expect(writerRef.getSessionId()).toBe("web:s_existing");
    expect(writerRef.sessionCreated).toBe(false);
  });
});

describe("cloneGitHubRepo conflict reporting", () => {
  it("surfaces the 'different repository' reason instead of a generic message", async () => {
    const gitDir = installFakeGit();
    process.env.FAKE_GIT_REMOTE = "https://github.com/other/repo.git";
    const cloneDir = makeTempDir("sati-agent-clone-");

    const { status, body } = await post(
      "/api/agent",
      {
        githubUrl: "https://github.com/owner/repo",
        projectPath: cloneDir,
        message: "hi",
        stream: "false",
        cleanup: "false",
      },
      { gitDir },
    );

    expect(status).toBe(500);
    expect(body.error).toContain("already exists with a different repository");
    expect(body.error).toContain("https://github.com/other/repo.git");
  });
});

describe("branch checkout failure reporting", () => {
  it("reports the failing checkout command, not the previous one", async () => {
    const gitDir = installFakeGit();
    process.env.FAKE_GIT_REMOTE = "https://github.com/owner/repo.git";
    const projectPath = makeTempDir("sati-agent-project-");

    const { body } = await post(
      "/api/agent",
      {
        projectPath,
        message: "hi",
        branchName: "feature/rename-me",
        githubToken: "ghp_fake",
        stream: "false",
        cleanup: "false",
      },
      { gitDir },
    );

    expect(body.pullRequest.error).toContain("FAKE_GIT_CHECKOUT_FAILED");
    expect(body.pullRequest.error).not.toContain("already exists");
  });
});

describe("session cleanup target", () => {
  it("removes the real transcript and sidecar dir of a session it created", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome.path);
    const { cleanupProject, resolveSessionArtifacts } = await import("./agent.js");

    const cloneDir = join(fakeHome.path, ".sati", "external-projects", "throwaway");
    mkdirSync(cloneDir, { recursive: true });
    writeFileSync(join(cloneDir, "README.md"), "clone\n");

    const [transcriptPath, sidecarDir] = resolveSessionArtifacts(cloneDir, "web:s_test");
    mkdirSync(join(sidecarDir, "subagents"), { recursive: true });
    writeFileSync(transcriptPath, '{"type":"turn"}\n');
    writeFileSync(join(sidecarDir, "subagents", "sub.jsonl"), '{"type":"turn"}\n');

    await cleanupProject(cloneDir, "web:s_test", { removeSession: true });

    expect(existsSync(cloneDir)).toBe(false);
    expect(existsSync(transcriptPath)).toBe(false);
    expect(existsSync(sidecarDir)).toBe(false);
  });

  it("keeps the transcript when the session pre-existed (negative control)", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome.path);
    const { cleanupProject, resolveSessionArtifacts } = await import("./agent.js");

    const cloneDir = join(fakeHome.path, ".sati", "external-projects", "throwaway");
    mkdirSync(cloneDir, { recursive: true });
    const [transcriptPath] = resolveSessionArtifacts(cloneDir, "web:s_existing");
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
    writeFileSync(transcriptPath, '{"type":"turn"}\n');

    await cleanupProject(cloneDir, "web:s_existing", { removeSession: false });

    expect(existsSync(cloneDir)).toBe(false);
    expect(existsSync(transcriptPath)).toBe(true);
  });
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Install a fake `git` on PATH.
 *
 * Speaks just enough of the CLI for the branch/PR workflow:
 *  - `config --get remote.origin.url` → `$FAKE_GIT_REMOTE` (exit 0)
 *  - `checkout -b <branch>` → "already exists" failure
 *  - `checkout <branch>` → distinct failure that must reach the response
 */
function installFakeGit() {
  const gitDir = makeTempDir("sati-agent-fake-git-");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const done = (code, stdout = "", stderr = "") => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
};
if (args[0] === "config" && args[1] === "--get") done(0, \`\${process.env.FAKE_GIT_REMOTE || ""}\\n\`);
if (args[0] === "checkout" && args[1] === "-b") done(1, "", "fatal: a branch named '" + args[2] + "' already exists\\n");
if (args[0] === "checkout") done(2, "", "FAKE_GIT_CHECKOUT_FAILED: unable to switch to '" + args[1] + "'\\n");
done(0);
`;
  writeFileSync(join(gitDir, "git"), script, "utf8");
  chmodSync(join(gitDir, "git"), 0o755);
  process.env.PATH = `${gitDir}:${originalPath}`;
  return gitDir;
}

async function createAgentApp({ runChatViaGateway }) {
  vi.doMock("../database/db.js", () => ({
    userDb: { getFirstUser: vi.fn(() => ({ id: 1, username: "tester" })) },
    apiKeysDb: { validateApiKey: vi.fn(() => ({ id: 1, username: "tester" })) },
    githubTokensDb: { getActiveGithubToken: vi.fn(() => null) },
  }));
  vi.doMock("../projects.js", () => ({
    addProjectManually: vi.fn(async projectPath => ({ path: projectPath })),
  }));
  vi.doMock("../sati-bridge.js", () => ({
    runChatViaGateway: runChatViaGateway ?? vi.fn(async () => undefined),
  }));

  const { default: agentRoutes } = await import("./agent.js");
  const app = express();
  app.use(express.json());
  app.use("/api/agent", agentRoutes);
  return app;
}

async function post(path, body, { runChatViaGateway } = {}, { text = false } = {}) {
  const app = await createAgentApp({ runChatViaGateway });
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify(body),
    });
    return text
      ? { status: response.status, text: await response.text() }
      : { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
