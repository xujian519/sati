import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveTitleFromBranch, formatPrBody, issueSearchKeywordsFromBranch } from "./open-pr.mjs";

describe("deriveTitleFromBranch", () => {
  it("feat/cron-agentic-automation → feat(cron): agentic automation", () => {
    assert.equal(deriveTitleFromBranch("feat/cron-agentic-automation"), "feat(cron): agentic automation");
  });

  it("feat/patent-figuregen → feat(patent): figuregen（命中 scope 词表）", () => {
    assert.equal(deriveTitleFromBranch("feat/patent-figuregen"), "feat(patent): figuregen");
  });

  it("fix/claim-chart-gap → 首段不在词表则不带 scope", () => {
    assert.equal(deriveTitleFromBranch("fix/claim-chart-gap"), "fix: claim chart gap");
  });

  it("rest 无 '-' → 不带 scope", () => {
    assert.equal(deriveTitleFromBranch("docs/readme"), "docs: readme");
  });

  it("release/v0.1.9 → release: v0.1.9", () => {
    assert.equal(deriveTitleFromBranch("release/v0.1.9"), "release: v0.1.9");
  });

  it("多段 '/' → 仅首段为 type，'/' 转空格", () => {
    assert.equal(deriveTitleFromBranch("feat/patent/figuregen"), "feat(patent): figuregen");
    assert.equal(deriveTitleFromBranch("feat/foo/bar"), "feat: foo bar");
  });

  it("非标准 type 前缀 → 空串（提示用 --title）", () => {
    assert.equal(deriveTitleFromBranch("misc-branch/foo"), "");
    assert.equal(deriveTitleFromBranch(""), "");
  });

  it("rest 为空 → type: untitled", () => {
    assert.equal(deriveTitleFromBranch("feat/"), "feat: untitled");
  });
});

describe("formatPrBody", () => {
  it("带 issue 编号 → 含 Closes #n 与 commit 列表", () => {
    const body = formatPrBody(["feat(cron): a", "fix: b"], 42);
    assert.match(body, /Closes #42/);
    assert.match(body, /- feat\(cron\): a/);
    assert.match(body, /- fix: b/);
  });

  it("无 commit → 占位提示，不静默为空", () => {
    const body = formatPrBody([], 1);
    assert.match(body, /无独立 commit 摘要/);
    assert.match(body, /Closes #1/);
  });

  it("null（显式豁免）→ 写「无关联 issue」命中门禁豁免", () => {
    assert.match(formatPrBody(["c"], null), /无关联 issue/);
  });

  it("undefined（dry-run 待创建）→ 占位 Closes", () => {
    assert.match(formatPrBody(["c"], undefined), /Closes #<脚本将自动创建 issue>/);
  });
});

describe("issueSearchKeywordsFromBranch", () => {
  it("feat/cron-agentic-automation → [cron, agentic, automation]", () => {
    assert.deepEqual(issueSearchKeywordsFromBranch("feat/cron-agentic-automation"), ["cron", "agentic", "automation"]);
  });

  it("过滤 <3 字符短词，最多 3 个", () => {
    assert.deepEqual(issueSearchKeywordsFromBranch("feat/ui-tab-fix"), ["tab", "fix"]);
  });
});
