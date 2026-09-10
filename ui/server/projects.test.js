// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const gateway = vi.hoisted(() => ({
  closeProjectSessions: vi.fn(),
  closeSession: vi.fn(),
}));

vi.mock("./sati-bridge.js", () => ({
  getSatiGateway: vi.fn(async () => gateway),
  beginProjectDeletion: vi.fn(() => () => {}),
  beginSessionDeletion: vi.fn(() => () => {}),
  isGatewayUnavailableError: error => /Gateway WebSocket/i.test(error?.message || ""),
}));

vi.mock("./database/db.js", () => ({
  applyCustomSessionNames: vi.fn(),
}));

import { deleteProject, deleteSession } from "./projects.js";
import { createProjectId, sanitizeSessionIdForPath } from "./utils/pilotPaths.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("deleteSession lifecycle", () => {
  let satiHome;
  let previousHome;
  let project;
  let transcript;
  const sessionId = "web:delete-background-title";

  beforeEach(async () => {
    previousHome = process.env.SATI_HOME;
    satiHome = await fs.mkdtemp(path.join(os.tmpdir(), "sati-delete-lifecycle-"));
    process.env.SATI_HOME = satiHome;
    project = path.join(satiHome, "workspace");
    const projectDirectory = path.join(satiHome, "projects", createProjectId(project));
    await fs.mkdir(path.join(projectDirectory, "chats"), { recursive: true });
    await fs.writeFile(path.join(projectDirectory, ".cwd"), project);
    transcript = path.join(projectDirectory, "chats", `${sanitizeSessionIdForPath(sessionId)}.jsonl`);
    await fs.writeFile(transcript, "original transcript");
    gateway.closeSession.mockReset();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.SATI_HOME;
    else process.env.SATI_HOME = previousHome;
    await fs.rm(satiHome, { recursive: true, force: true });
  });

  it("waits for the gateway writer to close before unlinking its transcript", async () => {
    const closing = deferred();
    gateway.closeSession.mockReturnValue(closing.promise);
    const deletion = deleteSession(project, sessionId);
    await vi.waitFor(() =>
      expect(gateway.closeSession).toHaveBeenCalledWith({ sessionKey: sessionId, reason: "session_deleted" }),
    );
    expect(await fs.readFile(transcript, "utf8")).toBe("original transcript");
    closing.resolve();
    expect(await deletion).toBe(true);
    await expect(fs.readFile(transcript)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the transcript intact when the runtime cannot be closed", async () => {
    gateway.closeSession.mockRejectedValue(new Error("Gateway unavailable"));
    await expect(deleteSession(project, sessionId)).rejects.toThrow("Gateway unavailable");
    expect(await fs.readFile(transcript, "utf8")).toBe("original transcript");
  });
});

describe("deleteProject lifecycle", () => {
  let satiHome;
  let previousHome;
  let project;
  let projectDirectory;

  beforeEach(async () => {
    previousHome = process.env.SATI_HOME;
    satiHome = await fs.mkdtemp(path.join(os.tmpdir(), "sati-delete-project-"));
    process.env.SATI_HOME = satiHome;
    project = path.join(satiHome, "workspace");
    projectDirectory = path.join(satiHome, "projects", createProjectId(project));
    await fs.mkdir(path.join(projectDirectory, "chats"), { recursive: true });
    await fs.writeFile(path.join(projectDirectory, ".cwd"), project);
    gateway.closeProjectSessions.mockReset();
    gateway.closeProjectSessions.mockResolvedValue({ sessionKeys: [] });
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.SATI_HOME;
    else process.env.SATI_HOME = previousHome;
    await fs.rm(satiHome, { recursive: true, force: true });
  });

  it("closes project sessions before removing the project directory", async () => {
    const closing = deferred();
    let directoryStillPresentAtClose;
    gateway.closeProjectSessions.mockImplementation(async input => {
      if (!input.resume) {
        directoryStillPresentAtClose = await fs
          .access(projectDirectory)
          .then(() => true)
          .catch(() => false);
        await closing.promise;
      }
      return { sessionKeys: [] };
    });

    const deletion = deleteProject(project);
    await vi.waitFor(() => expect(gateway.closeProjectSessions).toHaveBeenCalledWith({ projectKey: project }));
    expect(directoryStillPresentAtClose).toBe(true);
    closing.resolve();
    expect(await deletion).toBe(true);
    await expect(fs.access(projectDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reopens the project even when deletion fails", async () => {
    gateway.closeProjectSessions.mockRejectedValue(new Error("Gateway unavailable"));
    await expect(deleteProject(project)).rejects.toThrow("Gateway unavailable");
    expect(gateway.closeProjectSessions).toHaveBeenLastCalledWith({ projectKey: project, resume: true });
  });
});
