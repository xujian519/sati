/**
 * 工作区专利判据（#450 构件①）。
 *
 * 判据的既有用户保护面是重点：一台已经用过专利工具（但没有 `patents:` 段、
 * 没有专利技能/规则包/产物）的机器，升级后不能静默失去专利能力面。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  detectPatentWorkspace,
  matchTranscriptHistory,
  PATENT_SKILL_PREFIXES,
  resolvePatentDomainEnabled,
  TRANSCRIPT_SCAN_MAX_FILES,
  type PatentSignalFs,
} from "../../../src/pilot/workspace/patentSignals.js";
import { PILOT_PROJECT_DIR_NAME } from "../../../src/shared/paths/pilotPaths.js";

/** 内存 fs：键为绝对路径；目录用 `dir:<path>` 标记。 */
function memoryFs(files: Record<string, string>): PatentSignalFs {
  const dirs = new Set<string>();
  const all = new Map<string, string>();
  for (const [key, value] of Object.entries(files)) {
    if (key.startsWith("dir:")) {
      dirs.add(key.slice(4));
      continue;
    }
    all.set(key, value);
  }
  const listNames = (path: string): string[] => {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Set<string>();
    for (const key of [...all.keys(), ...dirs]) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.length === 0) continue;
      names.add(rest.split("/")[0] ?? rest);
    }
    return [...names];
  };
  for (const key of all.keys()) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return {
    exists: path => all.has(path) || dirs.has(path),
    isDirectory: path => dirs.has(path),
    readTextFile: path => all.get(path),
    listNames,
  };
}

const ROOT = "/ws";

test("显式声明优先于任何自动判据（true / false 两个方向）", () => {
  const fs = memoryFs({ "dir:/ws/data/cases": "", "/ws/data/cases/a": "x" });
  assert.deepEqual(detectPatentWorkspace({ projectRoot: ROOT, explicit: true, fs }), {
    enabled: true,
    signal: "explicit-config",
  });
  assert.deepEqual(detectPatentWorkspace({ projectRoot: ROOT, explicit: false, fs }), {
    enabled: false,
    signal: "explicit-config",
  });
});

test("机器级 patents: 段命中（机器级显式专利意图）", () => {
  const fs = memoryFs({});
  const verdict = detectPatentWorkspace({ projectRoot: ROOT, hasPatentsConfig: true, fs });
  assert.equal(verdict.enabled, true);
  assert.equal(verdict.signal, "patents-config");
});

test("项目 .sati/rules.yaml 引用专利规则包即命中", () => {
  const fs = memoryFs({ [`${ROOT}/${PILOT_PROJECT_DIR_NAME}/rules.yaml`]: "packs:\n  - patent/nuo-core\n" });
  const verdict = detectPatentWorkspace({ projectRoot: ROOT, fs });
  assert.equal(verdict.enabled, true);
  assert.equal(verdict.signal, "rules-pack");
  assert.match(verdict.evidence ?? "", /rules\.yaml$/);
});

test("非专利的 rules.yaml 不命中", () => {
  const fs = memoryFs({ [`${ROOT}/${PILOT_PROJECT_DIR_NAME}/rules.yaml`]: "packs:\n  - base\n" });
  assert.equal(detectPatentWorkspace({ projectRoot: ROOT, fs }).enabled, false);
});

test("项目技能目录下任一专利前缀技能即命中", () => {
  for (const prefix of PATENT_SKILL_PREFIXES) {
    const fs = memoryFs({ [`${ROOT}/${PILOT_PROJECT_DIR_NAME}/skills/${prefix}alpha/SKILL.md`]: "---\n---\n" });
    const verdict = detectPatentWorkspace({ projectRoot: ROOT, fs });
    assert.equal(verdict.enabled, true, `${prefix} 应命中`);
    assert.equal(verdict.signal, "project-skills");
  }
});

test("无关技能目录不命中", () => {
  const fs = memoryFs({ [`${ROOT}/${PILOT_PROJECT_DIR_NAME}/skills/kanban-helper/SKILL.md`]: "---\n---\n" });
  assert.equal(detectPatentWorkspace({ projectRoot: ROOT, fs }).enabled, false);
});

test("专利产物（data/cases、.sati/figures*、.sati/documents）命中", () => {
  const cases = detectPatentWorkspace({
    projectRoot: ROOT,
    fs: memoryFs({ [`${ROOT}/data/cases/2026-1/a.json`]: "{}" }),
  });
  assert.equal(cases.signal, "patent-artifacts");

  const figures = detectPatentWorkspace({
    projectRoot: ROOT,
    fs: memoryFs({ [`${ROOT}/${PILOT_PROJECT_DIR_NAME}/figures/1.png`]: "x" }),
  });
  assert.equal(figures.enabled, true);

  const documents = detectPatentWorkspace({
    projectRoot: ROOT,
    fs: memoryFs({ [`${ROOT}/${PILOT_PROJECT_DIR_NAME}/documents/opinion.html`]: "x" }),
  });
  assert.equal(documents.enabled, true);
});

test("空的 data/cases 目录不算产物（避免空脚手架误判）", () => {
  const fs = memoryFs({ "dir:/ws/data/cases": "" });
  assert.equal(detectPatentWorkspace({ projectRoot: ROOT, fs }).enabled, false);
});

test("历史 transcript 出现 patent_ 工具调用即命中（既有用户保护）", () => {
  const fs = memoryFs({
    "/chats/s1.jsonl": `{"type":"tool_call","name":"read_file"}\n{"type":"tool_call","name":"patent_search"}\n`,
  });
  const verdict = detectPatentWorkspace({ projectRoot: ROOT, projectChatsDir: "/chats", fs });
  assert.equal(verdict.enabled, true);
  assert.equal(verdict.signal, "transcript-history");
});

test("历史 transcript 无专利调用不命中；目录不存在也不命中", () => {
  const fs = memoryFs({ "/chats/s1.jsonl": `{"name":"kanban_get"}\n` });
  assert.equal(detectPatentWorkspace({ projectRoot: ROOT, projectChatsDir: "/chats", fs }).enabled, false);
  assert.equal(detectPatentWorkspace({ projectRoot: ROOT, projectChatsDir: "/absent", fs }).enabled, false);
});

test("transcript 扫描优先取最近的会话文件（文件数上限只削掉最老的）", () => {
  const files: Record<string, string> = {};
  // 文件名含递增序号 ⇒ 字典序 = 时间序；专利调用只在最新那个文件里。
  for (let i = 0; i <= TRANSCRIPT_SCAN_MAX_FILES; i += 1) {
    files[`/chats/session-${String(i).padStart(3, "0")}.jsonl`] =
      i === TRANSCRIPT_SCAN_MAX_FILES ? `{"name":"patent_search"}` : `{"name":"read_file"}\n`;
  }
  assert.equal(matchTranscriptHistory(memoryFs(files), "/chats"), true);
});

test("transcript 扫描因字节预算被迫中断时保守判命中（漏判代价远大于多判）", () => {
  const files: Record<string, string> = {
    "/chats/a.jsonl": `{"name":"read_file","padding":"${"x".repeat(64)}"}`,
    "/chats/b.jsonl": `{"name":"read_file","padding":"${"x".repeat(64)}"}`,
    "/chats/c.jsonl": `{"name":"read_file"}`,
  };
  assert.equal(matchTranscriptHistory(memoryFs(files), "/chats", { maxFiles: 10, maxBytes: 100 }), true);
  // 预算够（把三个都读完）时按事实判定：无专利调用 = 不命中。
  assert.equal(matchTranscriptHistory(memoryFs(files), "/chats", { maxFiles: 10, maxBytes: 10_000 }), false);
});

test("全新工作区（无任何信号）判为非专利", () => {
  const verdict = detectPatentWorkspace({ projectRoot: ROOT, fs: memoryFs({}) });
  assert.deepEqual(verdict, { enabled: false, signal: "none" });
});

test("判据顺序：显式 > patents 段 > 规则包 > 技能 > 产物 > 历史", () => {
  const fs = memoryFs({
    [`${ROOT}/${PILOT_PROJECT_DIR_NAME}/skills/patent-alpha/SKILL.md`]: "---\n---\n",
    [`${ROOT}/${PILOT_PROJECT_DIR_NAME}/rules.yaml`]: "patent/x\n",
    "/chats/s1.jsonl": `{"name":"patent_search"}`,
  });
  assert.equal(detectPatentWorkspace({ projectRoot: ROOT, projectChatsDir: "/chats", fs }).signal, "rules-pack");
  assert.equal(
    detectPatentWorkspace({ projectRoot: ROOT, projectChatsDir: "/chats", hasPatentsConfig: true, fs }).signal,
    "patents-config",
  );
  assert.equal(resolvePatentDomainEnabled({ projectRoot: ROOT, explicit: false, fs }).signal, "explicit-config");
});
