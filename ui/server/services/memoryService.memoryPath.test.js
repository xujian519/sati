// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hashText = input => createHash("sha1").update(input).digest("hex").slice(0, 10);

describe("resolveManagedMemoryFile", () => {
  let satiHome;
  let resolveManagedMemoryFile;

  beforeEach(async () => {
    satiHome = fs.mkdtempSync(path.join(os.tmpdir(), "sati-memory-path-test-"));
    process.env.SATI_HOME = satiHome;
    vi.resetModules();
    const mod = await import("./memoryService.js");
    resolveManagedMemoryFile = mod.resolveManagedMemoryFile;
  });

  afterEach(() => {
    delete process.env.SATI_HOME;
    vi.resetModules();
    fs.rmSync(satiHome, { recursive: true, force: true });
  });

  const memoryStoreFor = projectRoot =>
    path.join(satiHome, "memory", "workspaces", hashText(path.resolve(projectRoot)), "memory");

  it("remaps MEMORY.md to the workspace memory store", () => {
    const projectRoot = "/Users/me/project";
    expect(resolveManagedMemoryFile(projectRoot, "MEMORY.md")).toBe(
      path.join(memoryStoreFor(projectRoot), "MEMORY.md"),
    );
  });

  it("remaps project.meta.md and USER.md", () => {
    const projectRoot = "/Users/me/project";
    expect(resolveManagedMemoryFile(projectRoot, "project.meta.md")).toBe(
      path.join(memoryStoreFor(projectRoot), "project.meta.md"),
    );
    expect(resolveManagedMemoryFile(projectRoot, "USER.md")).toBe(path.join(memoryStoreFor(projectRoot), "USER.md"));
  });

  it("remaps managed subdirectories Project/Feedback/GeneralProjects", () => {
    const projectRoot = "/Users/me/project";
    for (const relative of ["Project/idea.md", "Feedback/rule.md", "GeneralProjects/topic.md"]) {
      expect(resolveManagedMemoryFile(projectRoot, relative)).toBe(path.join(memoryStoreFor(projectRoot), relative));
    }
  });

  it("returns null for non-memory files", () => {
    const projectRoot = "/Users/me/project";
    expect(resolveManagedMemoryFile(projectRoot, "docs/report.md")).toBeNull();
    expect(resolveManagedMemoryFile(projectRoot, "README.md")).toBeNull();
    expect(resolveManagedMemoryFile(projectRoot, "src/index.ts")).toBeNull();
    expect(resolveManagedMemoryFile(projectRoot, "memory/workspaces/abc/memory/MEMORY.md")).toBeNull();
  });

  it("rejects traversal, empty and invalid paths", () => {
    const projectRoot = "/Users/me/project";
    expect(resolveManagedMemoryFile(projectRoot, "../MEMORY.md")).toBeNull();
    expect(resolveManagedMemoryFile(projectRoot, "Project/../../etc/passwd")).toBeNull();
    expect(resolveManagedMemoryFile(projectRoot, "")).toBeNull();
    expect(resolveManagedMemoryFile(projectRoot, null)).toBeNull();
    expect(resolveManagedMemoryFile(projectRoot, undefined)).toBeNull();
    expect(resolveManagedMemoryFile("", "MEMORY.md")).toBeNull();
    expect(resolveManagedMemoryFile("   ", "MEMORY.md")).toBeNull();
    expect(resolveManagedMemoryFile(null, "MEMORY.md")).toBeNull();
  });

  it("normalizes the project root to an absolute path before hashing", () => {
    const projectRoot = "relative/path";
    expect(resolveManagedMemoryFile(projectRoot, "MEMORY.md")).toBe(
      path.join(satiHome, "memory", "workspaces", hashText(path.resolve(projectRoot)), "memory", "MEMORY.md"),
    );
  });

  it("strips leading slashes and accepts backslash separators", () => {
    const projectRoot = "/Users/me/project";
    expect(resolveManagedMemoryFile(projectRoot, "/MEMORY.md")).toBe(
      path.join(memoryStoreFor(projectRoot), "MEMORY.md"),
    );
    expect(resolveManagedMemoryFile(projectRoot, "Project\\idea.md")).toBe(
      path.join(memoryStoreFor(projectRoot), "Project", "idea.md"),
    );
  });
});
