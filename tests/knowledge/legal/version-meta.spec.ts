import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeEffectiveStatus,
  defaultLawVersionMetaPath,
  extractVersionEvents,
  loadLawVersionMeta,
} from "../../../src/knowledge/legal/version-meta.js";

// ---------------------------------------------------------------------------
// extractVersionEvents —— raw md 头部立法事件解析
// ---------------------------------------------------------------------------

test("extractVersionEvents: 专利法头部（通过 + 四次修正）", () => {
  const header = `# 中华人民共和国专利法

1984年3月12日 第六届全国人民代表大会常务委员会第四次会议通过

1992年9月4日 第七届全国人民代表大会常务委员会第二十七次会议《关于修改〈中华人民共和国专利法〉的决定》第一次修正

2000年8月25日 第九届全国人民代表大会常务委员会第十七次会议《关于修改〈中华人民共和国专利法〉的决定》第二次修正

2008年12月27日 第十一届全国人民代表大会常务委员会第六次会议《关于修改〈中华人民共和国专利法〉的决定》第三次修正

2020年10月17日 第十三届全国人民代表大会常务委员会第二十二次会议《关于修改〈中华人民共和国专利法〉的决定》第四次修正

<!-- INFO END -->`;
  const events = extractVersionEvents(header);
  assert.equal(events.length, 5);
  assert.deepEqual(events[0], {
    date: "1984-03-12",
    kind: "通过",
    summary: "第六届全国人民代表大会常务委员会第四次会议",
  });
  assert.equal(events[1]!.kind, "修正");
  assert.equal(events[1]!.date, "1992-09-04");
  assert.equal(events[4]!.kind, "修正");
  assert.equal(events[4]!.date, "2020-10-17");
});

test("extractVersionEvents: 细则头部（行政法规用'公布'）", () => {
  const header = `# 中华人民共和国专利法实施细则

2001年6月15日 中华人民共和国国务院令第306号公布

2023年12月11日 《国务院关于修改〈中华人民共和国专利法实施细则〉的决定》第三次修订

<!-- INFO END -->`;
  const events = extractVersionEvents(header);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, "公布");
  assert.equal(events[0]!.date, "2001-06-15");
  assert.equal(events[1]!.kind, "修订");
  assert.equal(events[1]!.date, "2023-12-11");
});

test("extractVersionEvents: 无事件头部返回空数组", () => {
  assert.deepEqual(extractVersionEvents("目录\n第一章 总则\n"), []);
  assert.deepEqual(extractVersionEvents(""), []);
});

// ---------------------------------------------------------------------------
// computeEffectiveStatus —— 版本效力状态判定
// ---------------------------------------------------------------------------

test("computeEffectiveStatus: 最新版本现行有效、历史版本已被修订", () => {
  const dates = ["1984-03-12", "1992-09-04", "2000-08-25", "2008-12-27", "2020-10-17"];
  assert.equal(computeEffectiveStatus(dates, "2020-10-17"), "现行有效");
  assert.equal(computeEffectiveStatus(dates, "2008-12-27"), "已被修订");
  // 缺省 target 判定最新版本
  assert.equal(computeEffectiveStatus(dates), "现行有效");
});

test("computeEffectiveStatus: 无序输入、无版本信息兜底", () => {
  assert.equal(computeEffectiveStatus(["2020-10-17", "1984-03-12"], "2020-10-17"), "现行有效");
  assert.equal(computeEffectiveStatus([]), "待核验");
  assert.equal(computeEffectiveStatus([], "2020-01-01"), "待核验");
});

// ---------------------------------------------------------------------------
// loadLawVersionMeta —— meta 缓存加载（缺失/损坏降级）
// ---------------------------------------------------------------------------

test("loadLawVersionMeta: 合法 json 按 name 索引", () => {
  const dir = mkdtempSync(join(tmpdir(), "law-version-meta-"));
  const path = join(dir, "law-version-meta.json");
  writeFileSync(
    path,
    JSON.stringify([
      { name: "中华人民共和国专利法", status: "现行有效", promulgatedDate: "2020-10-17", events: [] },
      { name: "中华人民共和国专利法实施细则", status: "现行有效", promulgatedDate: "2023-12-11", events: [] },
    ]),
  );
  try {
    const map = loadLawVersionMeta(path);
    assert.equal(map.size, 2);
    assert.equal(map.get("中华人民共和国专利法")?.status, "现行有效");
    assert.equal(map.get("中华人民共和国专利法")?.promulgatedDate, "2020-10-17");
    assert.equal(map.get("中华人民共和国专利法实施细则")?.status, "现行有效");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLawVersionMeta: 文件缺失/损坏/非数组降级为空 map", () => {
  const dir = mkdtempSync(join(tmpdir(), "law-version-meta-"));
  try {
    assert.equal(loadLawVersionMeta(join(dir, "missing.json")).size, 0);
    writeFileSync(join(dir, "bad.json"), "not-json");
    assert.equal(loadLawVersionMeta(join(dir, "bad.json")).size, 0);
    writeFileSync(join(dir, "obj.json"), JSON.stringify({ name: "x" }));
    assert.equal(loadLawVersionMeta(join(dir, "obj.json")).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultLawVersionMetaPath: SATI_KNOWLEDGE_DIR 覆盖默认目录", () => {
  const prev = process.env.SATI_KNOWLEDGE_DIR;
  try {
    delete process.env.SATI_KNOWLEDGE_DIR;
    const defaultPath = defaultLawVersionMetaPath();
    assert.ok(defaultPath.endsWith("/.sati/knowledge/law-version-meta.json"), defaultPath);
    process.env.SATI_KNOWLEDGE_DIR = "/tmp/custom-knowledge";
    assert.equal(defaultLawVersionMetaPath(), "/tmp/custom-knowledge/law-version-meta.json");
  } finally {
    if (prev === undefined) delete process.env.SATI_KNOWLEDGE_DIR;
    else process.env.SATI_KNOWLEDGE_DIR = prev;
  }
});
