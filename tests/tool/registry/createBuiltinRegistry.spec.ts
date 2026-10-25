import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";
import { TeamDb, type TeamScheduler } from "../../../src/agent/team/index.js";

test("createBuiltinRegistry：team options 注入后 11 工具注册且 domain 正确", () => {
  const root = mkdtempSync(join(tmpdir(), "sati-registry-team-"));
  const db = new TeamDb(join(root, "teams.db"));
  try {
    const scheduler = {} as TeamScheduler;
    const emit = () => true;
    const registry = createBuiltinRegistry({ team: { db, scheduler, emit } });
    const domains = new Map<string, string>();
    const names = [
      "team_create",
      "team_add_member",
      "team_remove_member",
      "team_create_task",
      "team_update_task",
      "team_reassign_task",
      "team_send_message",
      "team_status",
      "team_archive",
      "team_share_write",
      "team_share_read",
    ];
    for (const name of names) {
      const tool = registry.get(name);
      assert.ok(tool, `工具未注册：${name}`);
      assert.ok(tool.domain !== undefined, `${name} 应有 domain`);
      domains.set(name, tool.domain!);
    }
    for (const name of [
      "team_create",
      "team_add_member",
      "team_remove_member",
      "team_create_task",
      "team_reassign_task",
      "team_archive",
    ]) {
      assert.equal(domains.get(name), "team:manage", name);
    }
    for (const name of [
      "team_update_task",
      "team_send_message",
      "team_status",
      "team_share_write",
      "team_share_read",
    ]) {
      assert.equal(domains.get(name), "team", name);
    }
    // 未传 team options 时不注册；注册块是纯增量（恰好 11 个新工具）
    const plain = createBuiltinRegistry({});
    assert.equal(plain.get("team_create"), undefined);
    assert.equal(registry.list().length - plain.list().length, 11);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("createBuiltinRegistry：law_search / law_verify 默认注册，legal: false 一并关闭", () => {
  const registry = createBuiltinRegistry({});
  for (const name of ["law_search", "law_verify"]) {
    const tool = registry.get(name);
    assert.ok(tool, `工具未注册：${name}`);
    assert.equal(tool.domain, "legal", `${name} 应标注 legal 域`);
  }

  // 开关语义：legal 关闭时两条工具都消失（不得只关一个，留下半套法律面）
  const disabled = createBuiltinRegistry({ legal: false });
  assert.equal(disabled.get("law_search"), undefined);
  assert.equal(disabled.get("law_verify"), undefined);
});
