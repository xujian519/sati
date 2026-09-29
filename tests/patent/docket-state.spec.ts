import assert from "node:assert/strict";
import test from "node:test";
import {
  abandonDocket,
  createDocket,
  DEFAULT_MAX_ROUNDS,
  docketFromJSON,
  docketToJSON,
  DocketError,
  finalizeDocket,
  recordRevision,
  setGapQuestions,
  triageDocket,
} from "../../src/patent/docket/index.js";

/**
 * 案卷轮次状态机（docket）纯函数测试（P0-1）。
 *
 * 覆盖：立案守卫、缺口合并/重开、分诊四分支（draft/revise/finalize_ready/
 * escalate_human）、修订轮次上限强制、定稿门控（未决缺口/零轮拒绝）、
 * 终态不可变、序列化往返守卫。
 */

const base = () => createDocket("case-1", "drafting");

test("createDocket：默认 maxRounds、round=0、phase=open", () => {
  const d = base();
  assert.equal(d.round, 0);
  assert.equal(d.maxRounds, DEFAULT_MAX_ROUNDS);
  assert.equal(d.phase, "open");
  assert.equal(d.gaps.length, 0);
});

test("createDocket：caseId 空白 / 非法字符 / maxRounds 非法均 fail-closed", () => {
  assert.throws(() => createDocket("", "drafting"), DocketError);
  assert.throws(() => createDocket("case", ""), DocketError);
  assert.throws(() => createDocket("../evil", "drafting"), /非法字符/);
  assert.throws(() => createDocket("c", "drafting", { maxRounds: 0 }), /maxRounds 必须为正整数/);
  assert.throws(() => createDocket("c", "drafting", { maxRounds: 1.5 }), /maxRounds/);
});

test("createDocket：初始 gaps 强制 resolved=false", () => {
  const d = createDocket("c", "drafting", {
    gaps: [{ id: "g1", question: "缺少实验数据", source: "交底" }],
  });
  assert.equal(d.gaps[0]!.resolved, false);
  assert.equal(d.gaps[0]!.source, "交底");
});

test("setGapQuestions：新 id 追加，同 id 重开并清 resolvedRound", () => {
  let d = base();
  d = setGapQuestions(d, [
    { id: "g1", question: "问题一" },
    { id: "g2", question: "问题二" },
  ]);
  assert.equal(d.gaps.length, 2);
  // g1 回答一轮后重开：resolved 应回到 false。
  d = recordRevision(d, { answered: ["g1"] });
  assert.equal(d.gaps.find(g => g.id === "g1")!.resolved, true);
  d = setGapQuestions(d, [{ id: "g1", question: "问题一（复现）" }]);
  const g1 = d.gaps.find(g => g.id === "g1")!;
  assert.equal(g1.resolved, false);
  assert.equal(g1.resolvedRound, undefined);
  assert.equal(g1.question, "问题一（复现）");
  // 未提到的 g2 保持未决。
  assert.equal(d.gaps.find(g => g.id === "g2")!.resolved, false);
});

test("setGapQuestions：重复 id 抛错", () => {
  assert.throws(
    () =>
      setGapQuestions(base(), [
        { id: "g", question: "a" },
        { id: "g", question: "b" },
      ]),
    /重复的缺口 id/,
  );
});

test("triageDocket：draft（无缺口且 round=0）", () => {
  const { next } = triageDocket(base());
  assert.equal(next.kind, "draft");
});

test("triageDocket：revise 派工带未决清单与轮次", () => {
  let d = base();
  d = setGapQuestions(d, [{ id: "g1", question: "问题一" }]);
  const { next } = triageDocket(d);
  assert.equal(next.kind, "revise");
  if (next.kind === "revise") {
    assert.equal(next.round, 1);
    assert.equal(next.openGaps.length, 1);
  }
});

test("triageDocket：finalize_ready（缺口全部解决）", () => {
  let d = createDocket("c", "drafting", { gaps: [{ id: "g1", question: "a" }] });
  d = recordRevision(d, { answered: ["g1"] });
  assert.equal(triageDocket(d).next.kind, "finalize_ready");
});

test("triageDocket：escalate_human（达上限仍有缺口）不静默继续", () => {
  let d = createDocket("c", "drafting", { maxRounds: 2, gaps: [{ id: "g1", question: "a" }] });
  d = recordRevision(d, { answered: ["g1"] }); // round 1，g1 解决
  d = setGapQuestions(d, [{ id: "g1", question: "a" }]); // 重开
  d = recordRevision(d, { answered: ["g1"] }); // round 2，达上限
  d = setGapQuestions(d, [{ id: "g2", question: "新缺口" }]);
  const { next } = triageDocket(d);
  assert.equal(next.kind, "escalate_human");
});

test("recordRevision：按原文匹配 answered，round 递增并记修订", () => {
  let d = createDocket("c", "drafting", { gaps: [{ id: "g1", question: "缺少保温实验数据" }] });
  d = recordRevision(d, { answered: ["缺少保温实验数据"], notes: "补充了三组数据" });
  assert.equal(d.round, 1);
  assert.equal(d.gaps[0]!.resolved, true);
  assert.equal(d.gaps[0]!.resolvedRound, 1);
  assert.equal(d.revisions.length, 1);
  assert.equal(d.revisions[0]!.notes, "补充了三组数据");
});

test("recordRevision：达 maxRounds 上限抛错", () => {
  let d = createDocket("c", "drafting", { maxRounds: 1, gaps: [{ id: "g1", question: "a" }] });
  d = recordRevision(d, { answered: ["g1"] });
  d = setGapQuestions(d, [{ id: "g2", question: "b" }]);
  assert.throws(() => recordRevision(d, { answered: ["g2"] }), /修订轮次已达上限/);
});

test("recordRevision：answered 空 / 全空白 / 不匹配均抛错", () => {
  const d = createDocket("c", "drafting", { gaps: [{ id: "g1", question: "a" }] });
  assert.throws(() => recordRevision(d, { answered: [] }), /answered 不能为空/);
  assert.throws(() => recordRevision(d, { answered: ["   "] }), /全部为空白/);
  assert.throws(() => recordRevision(d, { answered: ["不存在的缺口"] }), /均不匹配/);
});

test("finalizeDocket：未决缺口 / 零轮次均拒绝", () => {
  let d = createDocket("c", "drafting", { gaps: [{ id: "g1", question: "a" }] });
  assert.throws(() => finalizeDocket(d), /仍有 1 个未决缺口/);
  // 缺口解决但没记修订（round=0）：setGapQuestions 后立即 record 才有 round。
  const fresh = createDocket("c2", "drafting");
  assert.throws(() => finalizeDocket(fresh), /尚未记录任何修订轮次/);
  d = recordRevision(d, { answered: ["g1"] });
  const done = finalizeDocket(d, "定稿");
  assert.equal(done.phase, "finalized");
  assert.equal(done.notes, "定稿");
  assert.ok(done.finalizedAt);
});

test("abandonDocket：缺 reason 抛错，终态不可再变更", () => {
  const d = base();
  assert.throws(() => abandonDocket(d, ""), /reason 不能为空/);
  const gone = abandonDocket(d, "客户撤回");
  assert.equal(gone.phase, "abandoned");
  assert.equal(gone.abandonReason, "客户撤回");
  assert.throws(() => setGapQuestions(gone, [{ id: "g", question: "x" }]), /仅 open 可变更/);
});

test("docketToJSON / docketFromJSON 往返保留状态", () => {
  let d = createDocket("c", "drafting", { gaps: [{ id: "g1", question: "a" }] });
  d = recordRevision(d, { answered: ["g1"] });
  const round = docketFromJSON(docketToJSON(d));
  assert.deepEqual(round, d);
});

test("docketFromJSON：非法快照守卫", () => {
  assert.throws(
    () =>
      docketFromJSON(
        JSON.stringify({ caseId: "", caseType: "x", phase: "open", round: 0, maxRounds: 3, gaps: [], revisions: [] }),
      ),
    /caseId/,
  );
  assert.throws(
    () =>
      docketFromJSON(
        JSON.stringify({ caseId: "c", caseType: "x", phase: "weird", round: 0, maxRounds: 3, gaps: [], revisions: [] }),
      ),
    /未知案卷阶段/,
  );
  assert.throws(
    () =>
      docketFromJSON(
        JSON.stringify({ caseId: "c", caseType: "x", phase: "open", round: 5, maxRounds: 3, gaps: [], revisions: [] }),
      ),
    /超过 maxRounds/,
  );
  // finalized 但有未决缺口 → 违反门控。
  assert.throws(
    () =>
      docketFromJSON(
        JSON.stringify({
          caseId: "c",
          caseType: "x",
          phase: "finalized",
          round: 1,
          maxRounds: 3,
          gaps: [{ id: "g1", question: "a", resolved: false }],
          revisions: [{ round: 1, at: "t", answered: [], artifacts: [] }],
        }),
      ),
    /违反定稿门控/,
  );
});
