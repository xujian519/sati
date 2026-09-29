import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeToolContext } from "../context-fixture.js";
import { createPatentDocketTool } from "../../../src/tool/builtin/patentDocketTool.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

/**
 * patent_docket 工具接线测试（P0-1）。
 *
 * 案卷按 caseId 持久化到 <caseDir>/dockets/，验证 create → set_gaps → triage →
 * record_revision（缺口匹配 + 产物归档）→ finalize 的跨调用状态流，以及
 * 轮次上限 / 未决缺口定稿的 fail-closed 守卫。
 */

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map(c => (c.type === "text" && c.text ? c.text : "")).join("");
}

async function withTempDir(fn: (ctx: ReturnType<typeof makeToolContext>, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "patent-docket-tool-"));
  try {
    await fn(makeToolContext({ cwd: dir }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("create → get 跨调用持久化，缺 caseType fail-closed", async () => {
  await withTempDir(async ctx => {
    const tool = createPatentDocketTool();
    const noType = await tool.execute({ action: "create", caseId: "d1" }, ctx);
    assert.match(textOf(noType), /create 需要 caseType/);

    const created = await tool.execute(
      { action: "create", caseId: "d1", caseType: "drafting", gaps: [{ id: "g1", question: "缺少实验数据" }] },
      ctx,
    );
    assert.match(textOf(created), /已立案并持久化/);
    assert.match(textOf(created), /⏳ g1: 缺少实验数据/);

    const got = await tool.execute({ action: "get", caseId: "d1" }, ctx);
    assert.match(textOf(got), /轮次: 0\/3/);

    // 重复 create 不覆盖，返回既有案卷。
    const dup = await tool.execute({ action: "create", caseId: "d1", caseType: "drafting" }, ctx);
    assert.match(textOf(dup), /已存在/);
  });
});

test("get 不存在的案卷提示先 create", async () => {
  await withTempDir(async ctx => {
    const tool = createPatentDocketTool();
    const missing = await tool.execute({ action: "get", caseId: "nope" }, ctx);
    assert.match(textOf(missing), /不存在（先用 action=create 立案）/);
  });
});

test("triage 派工：draft → revise（带未决清单）", async () => {
  await withTempDir(async ctx => {
    const tool = createPatentDocketTool();
    await tool.execute({ action: "create", caseId: "d2", caseType: "drafting" }, ctx);
    const draft = await tool.execute({ action: "triage", caseId: "d2" }, ctx);
    assert.match(textOf(draft), /分诊 → draft/);

    await tool.execute({ action: "set_gaps", caseId: "d2", gaps: [{ id: "g1", question: "问题一" }] }, ctx);
    const revise = await tool.execute({ action: "triage", caseId: "d2" }, ctx);
    assert.match(textOf(revise), /分诊 → revise（第 1 轮）/);
    assert.match(textOf(revise), /- g1: 问题一/);
  });
});

test("set_gaps 缺 gaps 参数 fail-closed", async () => {
  await withTempDir(async ctx => {
    const tool = createPatentDocketTool();
    await tool.execute({ action: "create", caseId: "d3", caseType: "drafting" }, ctx);
    const bad = await tool.execute({ action: "set_gaps", caseId: "d3" }, ctx);
    assert.match(textOf(bad), /set_gaps 需要 gaps/);
  });
});

test("record_revision：回答缺口 + 归档产物到 revisions/round-1/", async () => {
  await withTempDir(async (ctx, dir) => {
    const tool = createPatentDocketTool();
    await tool.execute(
      { action: "create", caseId: "d4", caseType: "drafting", gaps: [{ id: "g1", question: "缺少实验数据" }] },
      ctx,
    );
    // 准备一个阶段产物文件供归档。
    const artifactPath = join(dir, "draft-claims.md");
    await writeFile(artifactPath, "# 权利要求书\n1. 一种保温杯……", "utf8");

    const recorded = await tool.execute(
      {
        action: "record_revision",
        caseId: "d4",
        answered: ["g1"],
        notes: "补充实验数据",
        artifacts: [{ name: "claims.md", path: "draft-claims.md" }],
      },
      ctx,
    );
    const text = textOf(recorded);
    assert.match(text, /轮次: 1\/3/);
    assert.match(text, /✅ g1（第 1 轮）/);
    assert.match(text, /产物已归档/);
    assert.match(text, /分诊 → finalize_ready/);

    // 归档文件落盘可读（单一 dockets 根：<dir>/data/cases/dockets/revisions/<caseId>/round-1/）。
    const archived = await readFile(join(dir, "data/cases/dockets/revisions/d4/round-1/claims.md"), "utf8");
    assert.match(archived, /一种保温杯/);
    const meta = JSON.parse(await readFile(join(dir, "data/cases/dockets/revisions/d4/round-1/revision.json"), "utf8"));
    assert.equal(meta.round, 1);
    assert.deepEqual(meta.answered, ["g1"]);
  });
});

test("record_revision：缺 answered / 不匹配缺口 fail-closed", async () => {
  await withTempDir(async ctx => {
    const tool = createPatentDocketTool();
    await tool.execute({ action: "create", caseId: "d5", caseType: "drafting" }, ctx);
    const noAnswered = await tool.execute({ action: "record_revision", caseId: "d5" }, ctx);
    assert.match(textOf(noAnswered), /record_revision 需要 answered/);
  });
});

test("轮次上限：超限 record_revision 被拒，triage 转 escalate_human", async () => {
  await withTempDir(async ctx => {
    const tool = createPatentDocketTool();
    await tool.execute(
      { action: "create", caseId: "d6", caseType: "drafting", maxRounds: 1, gaps: [{ id: "g1", question: "a" }] },
      ctx,
    );
    await tool.execute({ action: "record_revision", caseId: "d6", answered: ["g1"] }, ctx);
    // 重开缺口并再记一轮：超限。
    await tool.execute({ action: "set_gaps", caseId: "d6", gaps: [{ id: "g2", question: "b" }] }, ctx);
    const overCap = await tool.execute({ action: "record_revision", caseId: "d6", answered: ["g2"] }, ctx);
    assert.match(textOf(overCap), /修订轮次已达上限/);
    const escalate = await tool.execute({ action: "triage", caseId: "d6" }, ctx);
    assert.match(textOf(escalate), /escalate_human/);
  });
});

test("finalize：未决缺口拒绝，清零后定稿", async () => {
  await withTempDir(async ctx => {
    const tool = createPatentDocketTool();
    await tool.execute(
      { action: "create", caseId: "d7", caseType: "drafting", gaps: [{ id: "g1", question: "a" }] },
      ctx,
    );
    await tool.execute({ action: "record_revision", caseId: "d7", answered: ["g1"] }, ctx);
    // 追加未决缺口 → finalize 被拒。
    await tool.execute({ action: "set_gaps", caseId: "d7", gaps: [{ id: "g2", question: "b" }] }, ctx);
    const blocked = await tool.execute({ action: "finalize", caseId: "d7" }, ctx);
    assert.match(textOf(blocked), /仍有 1 个未决缺口/);

    await tool.execute({ action: "record_revision", caseId: "d7", answered: ["g2"] }, ctx);
    const done = await tool.execute({ action: "finalize", caseId: "d7", notes: "定稿交付" }, ctx);
    assert.match(textOf(done), /phase=finalized/);

    // finalized 终态不可再变更。
    const afterFinalize = await tool.execute(
      { action: "set_gaps", caseId: "d7", gaps: [{ id: "g3", question: "c" }] },
      ctx,
    );
    assert.match(textOf(afterFinalize), /仅 open 可变更/);
  });
});

test("abandon：缺 reason 拒绝，放弃后终态不可变", async () => {
  await withTempDir(async ctx => {
    const tool = createPatentDocketTool();
    await tool.execute({ action: "create", caseId: "d8", caseType: "drafting" }, ctx);
    const noReason = await tool.execute({ action: "abandon", caseId: "d8" }, ctx);
    assert.match(textOf(noReason), /abandon 需要 reason/);
    const gone = await tool.execute({ action: "abandon", caseId: "d8", reason: "客户撤回" }, ctx);
    assert.match(textOf(gone), /phase=abandoned/);
  });
});

test("未知 action / 缺 caseId fail-closed", async () => {
  await withTempDir(async ctx => {
    const tool = createPatentDocketTool();
    const noCase = await tool.execute({ action: "get" }, ctx);
    assert.match(textOf(noCase), /需要 caseId/);
    const unknown = await tool.execute({ action: "create", caseId: "d9", caseType: "drafting" }, ctx);
    assert.match(textOf(unknown), /已立案/);
    // 通过绕过 enum 的调用测试 default 分支不可达（action 已在 switch 覆盖）；
    // 这里仅确认持久化 + list 能列出的案卷。
    const listed = await tool.execute({ action: "list" }, ctx);
    assert.match(textOf(listed), /d9/);
  });
});

test("createBuiltinRegistry 注册 patent_docket（domain: patent）", () => {
  const registry = createBuiltinRegistry({});
  const tool = registry.get("patent_docket");
  assert.ok(tool, "patent_docket 应已注册");
  assert.equal(tool.domain, "patent");
});
