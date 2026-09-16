/**
 * `open-pr.mjs` 的用例。
 *
 * 除标题推导的行为回归外，这里还锁一条**跨文件契约**：提交 scope 词表不是第二份手抄，
 * 而是从 `.github/labels.yml` 派生的。判据本身**自带独立真值**（各自读一遍清单），
 * 不复用 `open-pr.mjs` 导出的 `loadLabelScopes` 当筛选器——否则把那个函数注入坏掉
 * （例如让它返回空集），包含类判据会退化成恒真。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  COMMIT_ONLY_SCOPES,
  deriveTitleFromBranch,
  duplicateScopeDeclarations,
  formatPrBody,
  issueSearchKeywordsFromBranch,
  loadKnownScopes,
  loadLabelScopes,
} from "./open-pr.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LABELS_FILE = ".github/labels.yml";

/** 标签侧独有的兜底取值（与实现里的 `LABEL_ONLY_SCOPE` 各持一份，互相绑定见下）。 */
const OTHER = "other";

/**
 * 判据侧独立读取清单里的 `scope:*` 取值——这是本测试的**真值来源**，不经过被测实现。
 * @returns {string[]} 不含 `scope:` 前缀的作用域名
 */
function labelScopesFromFile() {
  const parsed = parseYaml(readFileSync(join(ROOT, LABELS_FILE), "utf8"));
  if (!Array.isArray(parsed?.labels)) throw new Error(`${LABELS_FILE}: 顶层缺少 labels 数组`);
  return parsed.labels
    .map(label => label?.name)
    .filter(name => typeof name === "string" && name.startsWith("scope:"))
    .map(name => name.slice("scope:".length));
}

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

  it("过滤 <3 字符短词", () => {
    assert.deepEqual(issueSearchKeywordsFromBranch("feat/ui-tab-fix"), ["tab", "fix"]);
  });

  it("超过 3 个长词时截断到 3 个", () => {
    assert.deepEqual(issueSearchKeywordsFromBranch("feat/alpha-beta-gamma-delta"), ["alpha", "beta", "gamma"]);
  });
});

describe("提交 scope 词表由清单派生（单一事实源）", () => {
  it("前置：判据侧真值非空——空集会让下面的包含判据恒真", () => {
    const scopes = labelScopesFromFile();
    assert.ok(scopes.length >= 17, `解析到的 scope 标签过少（${scopes.length}），判据失效`);
    assert.ok(scopes.includes(OTHER), "清单里应始终保留 other 兜底项");
  });

  it("清单声明的每个 scope（other 除外）都被提交词表识别", () => {
    const known = loadKnownScopes(ROOT);
    const missing = labelScopesFromFile().filter(scope => scope !== OTHER && !known.has(scope));
    assert.deepEqual(missing, [], `这些 scope:* 标签在提交词表里不存在，按它们命名的分支推导不出 scope`);
  });

  it("提交词表没有第三个来源：成员 ⊆ 清单 ∪ 提交独有表", () => {
    const allowed = new Set([...labelScopesFromFile(), ...COMMIT_ONLY_SCOPES]);
    const extra = [...loadKnownScopes(ROOT)].filter(scope => !allowed.has(scope));
    assert.deepEqual(extra, []);
  });

  it("提交独有 scope 与标签 scope 不重叠（提升为标签后必须删旧声明）", () => {
    const labelScopes = new Set(labelScopesFromFile());
    const overlapping = [...COMMIT_ONLY_SCOPES].filter(scope => labelScopes.has(scope));
    assert.deepEqual(overlapping, [], "这些 scope 已是 scope:* 标签，却仍声明为提交独有");
    assert.deepEqual(duplicateScopeDeclarations(ROOT), []);
  });

  it("提交独有 scope 仍能被推导（派生没有改变既有行为）", () => {
    // 判据侧写死这一组字面量：若实现侧的表被悄悄清空，上面的循环不会因"集合为空"而恒真。
    const commitOnly = ["team", "extension", "session", "workflow", "web"];
    for (const scope of commitOnly) {
      assert.ok(COMMIT_ONLY_SCOPES.has(scope), `${scope} 不应从提交独有表消失`);
      assert.equal(deriveTitleFromBranch(`feat/${scope}-alpha`), `feat(${scope}): alpha`);
    }
  });

  it("other 是标签侧独有取值：不进词表，且分支 feat/other-x 不带 scope", () => {
    assert.ok(labelScopesFromFile().includes(OTHER));
    assert.ok(!loadKnownScopes(ROOT).has(OTHER));
    // 若 other 混进词表，这里会变成 feat(other): x——一个不表达任何模块的 scope。
    assert.equal(deriveTitleFromBranch("feat/other-x"), "feat: other x");
  });

  it("标签 scope 与提交独有 scope 各自都能推导出 scope（双向抽查）", () => {
    const labelScopes = new Set(labelScopesFromFile());
    assert.equal(deriveTitleFromBranch("feat/desktop-electron-shell"), "feat(desktop): electron shell");
    assert.ok(labelScopes.has("desktop"), "desktop 应是 scope:* 标签（有独立交付边界，见 issue-management §1）");
    assert.equal(deriveTitleFromBranch("feat/rule-pack-fingerprint"), "feat(rule): pack fingerprint");
    assert.ok(labelScopes.has("rule"));
  });

  it("可注入词表：纯逻辑用例不依赖文件系统", () => {
    assert.equal(
      deriveTitleFromBranch("feat/desktop-electron-shell", new Set(["desktop"])),
      "feat(desktop): electron shell",
    );
    assert.equal(deriveTitleFromBranch("feat/desktop-electron-shell", new Set()), "feat: desktop electron shell");
  });

  it("loadLabelScopes 与判据侧真值同源（绑定用例：两侧各自漂移都红）", () => {
    assert.deepEqual([...loadLabelScopes(ROOT)].sort(), [...labelScopesFromFile()].sort());
  });
});
