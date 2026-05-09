import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InProcessGateway,
  SessionRouter,
  startGatewayServer,
} from "../../../src/gateway/index.js";
import type { AgentEvent, AgentSession } from "../../../src/agent/index.js";

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-http-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "hello");
  writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  return dir;
}

test("/api/web/projects requires authorization", async () => {
  const router = new SessionRouter({
    createSession: async () => fakeSession([]),
  });
  const gateway = new InProcessGateway(router, {
    listProjects: async () => ({ projects: [] }),
    describeProject: async (input) => ({
      projectKey: input.projectKey,
      name: input.projectKey,
      fullPath: input.projectKey,
      sessionCount: 0,
    }),
  });
  const server = await startGatewayServer({ gateway, port: 0, token: "tt" });
  try {
    const unauthorized = await fetch(`${server.url}/api/web/projects`);
    assert.equal(unauthorized.status, 401);

    const ok = await fetch(`${server.url}/api/web/projects`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    assert.equal(ok.status, 200);
  } finally {
    await server.close();
  }
});

test("/api/web/projects/:id/files/tree returns workspace tree", async () => {
  const root = makeWorkspace();
  const router = new SessionRouter({ createSession: async () => fakeSession([]) });
  const gateway = new InProcessGateway(router, {
    listProjects: async () => ({ projects: [] }),
    describeProject: async (input) => ({
      projectKey: input.projectKey,
      name: input.projectKey,
      fullPath: input.projectKey,
      sessionCount: 0,
    }),
  });
  const server = await startGatewayServer({
    gateway,
    port: 0,
    token: "tt",
    resolveProject: () => root,
  });
  try {
    const projectKey = encodeURIComponent("any-project");
    const response = await fetch(
      `${server.url}/api/web/projects/${projectKey}/files/tree`,
      { headers: { Authorization: `Bearer ${server.token}` } },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { entries: { name: string }[] };
    const names = body.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["README.md", "src"]);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("/api/web/projects/:id/files/read with escaping path returns 403", async () => {
  const root = makeWorkspace();
  const router = new SessionRouter({ createSession: async () => fakeSession([]) });
  const gateway = new InProcessGateway(router, {
    listProjects: async () => ({ projects: [] }),
    describeProject: async (input) => ({
      projectKey: input.projectKey,
      name: input.projectKey,
      fullPath: input.projectKey,
      sessionCount: 0,
    }),
  });
  const server = await startGatewayServer({
    gateway,
    port: 0,
    token: "tt",
    resolveProject: () => root,
  });
  try {
    const projectKey = encodeURIComponent("any-project");
    const response = await fetch(
      `${server.url}/api/web/projects/${projectKey}/files/read?path=${encodeURIComponent("../etc/passwd")}`,
      { headers: { Authorization: `Bearer ${server.token}` } },
    );
    assert.equal(response.status, 403);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeSession(events: AgentEvent[]): AgentSession {
  return {
    abort: () => undefined,
    snapshot: () => ({
      sessionId: "s",
      messages: [],
      usage: {},
      permissionDenials: [],
      status: "idle",
      abortController: new AbortController(),
    }),
    replay: async function* () {},
    submit: async function* () {
      for (const event of events) {
        yield event;
      }
    },
  } as unknown as AgentSession;
}
