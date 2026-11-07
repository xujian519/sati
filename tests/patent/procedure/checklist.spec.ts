import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProcedureChecklist,
  PROCEDURE_DRAFT_NOTICE,
  REEXAMINATION_REQUEST_DEADLINE_ID,
} from "../../../src/patent/procedure/checklist.js";
import { ProcedureChecklistHandler } from "../../../src/patent/atoms/handlers/builtin/procedure.js";

const CHART = JSON.stringify({
  claim: "一种装置，包括壳体。",
  elements: [{ id: "1a", claimNo: 1, text: "包括壳体", kind: "limitation" }],
  targets: [{ id: "D1", kind: "prior-art", title: "对比文件1" }],
  rows: [],
  gaps: [],
});

test("复审 + 无送达记录：抄录待定原因，不出现推算日期", () => {
  const checklist = buildProcedureChecklist({
    kind: "reexamination",
    text: "权利要求1不具备创造性。",
    chart: CHART,
    deadlines: [
      {
        id: REEXAMINATION_REQUEST_DEADLINE_ID,
        status: "pending",
        reason: "需要驳回决定的送达记录，本查询未提供该通知。",
      },
      // 同一份求值里的其它条目不应出现在清单里
      { id: "annuity-year-1", status: "computed", date: "2027-05-01" },
    ],
  });
  assert.equal(checklist.markdown.split("\n")[0], PROCEDURE_DRAFT_NOTICE);
  assert.ok(checklist.markdown.includes("需要驳回决定的送达记录，本查询未提供该通知。"));
  assert.equal(checklist.markdown.includes("2027-05-01"), false);
});

test("复审 + 有截止日期：只渲染复审请求那一条", () => {
  const checklist = buildProcedureChecklist({
    kind: "reexamination",
    text: "驳回决定认为不具备新颖性。",
    chart: CHART,
    deadlines: [{ id: REEXAMINATION_REQUEST_DEADLINE_ID, status: "computed", date: "2027-02-01" }],
  });
  assert.ok(checklist.markdown.includes("2027-02-01"));
});

test("无效：期限行固定「无对应期限条目」", () => {
  const checklist = buildProcedureChecklist({
    kind: "invalidation",
    text: "权利要求1不具备新颖性。",
    chart: CHART,
    deadlines: [{ id: REEXAMINATION_REQUEST_DEADLINE_ID, status: "computed", date: "2027-02-01" }],
  });
  const deadline = checklist.items.find(item => item.id === "deadline");
  assert.equal(deadline?.status, "not_evaluated");
  assert.equal(deadline?.detail, "无对应期限条目");
});

test("空对照表：证据目标 blocked", () => {
  const checklist = buildProcedureChecklist({
    kind: "invalidation",
    text: "权利要求1不具备创造性。",
    chart: JSON.stringify({ targets: [], elements: [], rows: [], gaps: [] }),
  });
  const evidence = checklist.items.find(item => item.id === "evidence");
  assert.equal(evidence?.status, "blocked");
});

test("未识别理由：理由行 blocked，不写成「无争点」", () => {
  const checklist = buildProcedureChecklist({
    kind: "invalidation",
    text: "未识别争点",
    chart: CHART,
  });
  const grounds = checklist.items.find(item => item.id === "grounds");
  assert.equal(grounds?.status, "blocked");
  assert.ok(grounds?.detail.includes("未从输入识别"));
});

test("缺少期限求值：标记未求值，不编日期", () => {
  const checklist = buildProcedureChecklist({
    kind: "reexamination",
    text: "权利要求1不具备新颖性。",
    chart: CHART,
  });
  const deadline = checklist.items.find(item => item.id === "deadline");
  assert.equal(deadline?.status, "not_evaluated");
  assert.ok(deadline?.detail.includes("期限未求值"));
});

test("ProcedureChecklistHandler: 从状态读取材料与对照表", async () => {
  const state = await new ProcedureChecklistHandler().execute({
    state: {
      text: "权利要求1不具备创造性。",
      claim_chart_doc: CHART,
      procedure_kind: "invalidation",
    },
  });
  assert.equal(String(state.procedure_checklist).split("\n")[0], PROCEDURE_DRAFT_NOTICE);
  assert.ok(String(state.procedure_checklist).includes("inventiveness"));
});
