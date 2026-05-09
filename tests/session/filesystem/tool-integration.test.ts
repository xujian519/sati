import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FileHistoryStore } from "../../../src/session/index.js";
import {
  createBuiltinRegistry,
  ToolRuntime,
} from "../../../src/tool/index.js";
import { PermissionRuntime } from "../../../src/permission/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { createPolitDeckTempWorkspace } from "../../helpers/filesystem.js";

test("C4 edit_file calls fileHistory.trackEdit before mutating, allowing rewind", async (t) => {
  const ws = await createPolitDeckTempWorkspace({ "src/notes.md": "before" });
  t.after(() => ws.cleanup());

  const backupDir = path.join(ws.cwd, ".file-history");
  const store = new FileHistoryStore({ backupDir });

  const registry = createBuiltinRegistry({
    bash: {
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
      },
    },
    agent: false,
    webSearch: false,
    webFetch: false,
  });
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const ctx = {
    sessionId: "s",
    turnId: "t",
    cwd: ws.cwd,
    permissionMode: "bypassPermissions" as const,
    permissionContext: createDefaultPermissionContext({
      cwd: ws.cwd,
      mode: "bypassPermissions",
      canPrompt: false,
    }),
    fileHistory: store,
    messageId: "msg-1",
  };

  const result = await runtime.execute(
    {
      id: "call-1",
      name: "edit_file",
      input: { filePath: "src/notes.md", oldString: "before", newString: "after" },
    },
    ctx,
  );
  assert.equal(result.type, "success", JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(ws.cwd, "src/notes.md"), "utf8"), "after");

  await store.rewind("msg-1");
  assert.equal(await fs.readFile(path.join(ws.cwd, "src/notes.md"), "utf8"), "before");
});

test("C4 write_file (create new file) records null backup; rewind unlinks it", async (t) => {
  const ws = await createPolitDeckTempWorkspace({});
  t.after(() => ws.cleanup());

  const backupDir = path.join(ws.cwd, ".file-history");
  const store = new FileHistoryStore({ backupDir });

  const registry = createBuiltinRegistry({
    bash: {
      runner: {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }),
      },
    },
    agent: false,
    webSearch: false,
    webFetch: false,
  });
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const ctx = {
    sessionId: "s",
    turnId: "t",
    cwd: ws.cwd,
    permissionMode: "bypassPermissions" as const,
    permissionContext: createDefaultPermissionContext({
      cwd: ws.cwd,
      mode: "bypassPermissions",
      canPrompt: false,
    }),
    fileHistory: store,
    messageId: "msg-A",
  };

  const created = await runtime.execute(
    {
      id: "call-1",
      name: "write_file",
      input: { filePath: "fresh.ts", content: "hello" },
    },
    ctx,
  );
  assert.equal(created.type, "success", JSON.stringify(created));
  await store.rewind("msg-A");
  await assert.rejects(fs.access(path.join(ws.cwd, "fresh.ts")));
});
