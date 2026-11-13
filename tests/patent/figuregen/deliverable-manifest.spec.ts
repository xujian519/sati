/**
 * src/patent/figuregen/deliverable-manifest — 交付物清单（哈希 / 大小 / 时序）与其一致性核验。
 *
 * 对齐 deepseek-harness `packages/patent/patent-document/src/tool/verify-deliverable.ts`
 * 的两条可核证据：
 * 1. 「交出去的那份就是案卷主路径上的那份」——sha256 + 字节数绑定内容身份；
 * 2. 「渲染件不早于输入件」——产物 mtime 与输入件 mtime 的时序门。
 *
 * 判据与去重口径见 `src/patent/figuregen/deliverable-manifest.ts` 的模块头注。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildDeliverableManifest,
  checkDeliverableManifest,
  classifyDeliverableFileName,
  deliverableFigureNo,
  parseDeliverableEntries,
} from "../../../src/patent/figuregen/deliverable-manifest.js";
import { buildFigureSidecar, parseFigureSidecar, type FigureSidecar } from "../../../src/patent/figuregen/sidecar.js";

/** 每个用例一个临时目录（用完即删，不污染工作区）。 */
async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sati-deliverable-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 取某条 id 的发现（便于断言"只有这条命中"）。 */
function findingsOf(
  findings: readonly { readonly id: string; readonly file: string | undefined; readonly message: string }[],
  id: string,
) {
  return findings.filter(finding => finding.id === id);
}

test("装配：逐个算出 sha256 / 字节数 / mtime，清单只留文件名（不写家目录进案卷）", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "figs-fig1.svg");
    const content = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    await writeFile(path, content, "utf8");
    const info = await stat(path);

    const manifest = await buildDeliverableManifest([{ role: "figure", path }]);

    assert.equal(manifest.length, 1);
    const entry = manifest[0];
    assert.equal(entry?.role, "figure");
    assert.equal(entry?.file, "figs-fig1.svg", "清单只存文件名");
    assert.equal(entry?.sha256, createHash("sha256").update(content).digest("hex"));
    assert.equal(entry?.bytes, info.size);
    assert.equal(entry?.mtimeMs, info.mtimeMs);
  });
});

test("装配：读不到的条目不进清单（调用方按「请求 − 返回」的差集得知未登记）", async () => {
  await withTempDir(async dir => {
    const present = join(dir, "figs-fig1.svg");
    await writeFile(present, "<svg/>", "utf8");

    const manifest = await buildDeliverableManifest([
      { role: "figure", path: present },
      { role: "submission-page", path: join(dir, "figs-fig1-page.svg") },
    ]);

    assert.equal(manifest.length, 1, "读不到的条目不应进清单");
    assert.equal(manifest[0]?.file, "figs-fig1.svg");
  });
});

test("校验：清单里有、目录里没有 ⇒ file-missing", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "figs-fig1.svg");
    await writeFile(path, "<svg/>", "utf8");
    const manifest = await buildDeliverableManifest([{ role: "figure", path }]);
    await rm(path);

    const findings = await checkDeliverableManifest({ manifest, current: [] });

    const missing = findingsOf(findings, "file-missing");
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.file, "figs-fig1.svg");
    assert.equal(findings.length, 1, "缺文件只报一条");
  });
});

test("校验：文件在但读不到（被删除）同样报 file-missing", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "figs-fig1.svg");
    await writeFile(path, "<svg/>", "utf8");
    const manifest = await buildDeliverableManifest([{ role: "figure", path }]);
    await rm(path);

    // current 里仍登记该路径，但文件已被删 ⇒ 不可读 ⇒ file-missing（不报内容漂移）。
    const findings = await checkDeliverableManifest({
      manifest,
      current: [{ role: "figure", path }],
    });

    assert.equal(findingsOf(findings, "file-missing").length, 1);
    assert.equal(findingsOf(findings, "hash-mismatch").length, 0);
  });
});

test("校验：内容被改 ⇒ hash-mismatch；与 size 同时命中时只报 hash（去重）", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "figs-fig1.svg");
    await writeFile(path, "<svg>原始内容</svg>", "utf8");
    const manifest = await buildDeliverableManifest([{ role: "figure", path }]);
    // 改内容且**长度也变**（大小与哈希同时不符）⇒ 只应有一条 hash-mismatch。
    await writeFile(path, "<svg>被改过的更长内容</svg>", "utf8");

    const findings = await checkDeliverableManifest({
      manifest,
      current: [{ role: "figure", path }],
    });

    assert.equal(findingsOf(findings, "hash-mismatch").length, 1);
    assert.equal(findingsOf(findings, "size-mismatch").length, 0, "同一文件不重复报两条");
    assert.equal(findings.length, 1);
  });
});

test("校验：目录里新增了没登记的产物 ⇒ not-in-manifest", async () => {
  await withTempDir(async dir => {
    const registered = join(dir, "figs-fig1.svg");
    const unregistered = join(dir, "figs-fig2.svg");
    await writeFile(registered, "<svg/>", "utf8");
    await writeFile(unregistered, "<svg/>", "utf8");
    const manifest = await buildDeliverableManifest([{ role: "figure", path: registered }]);

    const findings = await checkDeliverableManifest({
      manifest,
      current: [
        { role: "figure", path: registered },
        { role: "figure", path: unregistered },
      ],
    });

    const notRegistered = findingsOf(findings, "not-in-manifest");
    assert.equal(notRegistered.length, 1);
    assert.equal(notRegistered[0]?.file, "figs-fig2.svg");
  });
});

test("校验：清单里没有的文件不报 not-in-manifest（非产物文件不参与比对）", async () => {
  await withTempDir(async dir => {
    const registered = join(dir, "figs-fig1.svg");
    await writeFile(registered, "<svg/>", "utf8");
    // 目录里的说明性文本（不是交付产物）不应被当成"新增未登记产物"。
    await writeFile(join(dir, "notes.txt"), "随手记的一笔", "utf8");
    const manifest = await buildDeliverableManifest([{ role: "figure", path: registered }]);

    const findings = await checkDeliverableManifest({
      manifest,
      current: [
        { role: "figure", path: registered },
        { role: "figure", path: join(dir, "notes.txt") },
      ],
    });

    assert.equal(findingsOf(findings, "not-in-manifest").length, 0);
    assert.deepEqual(findings, []);
  });
});

test("校验：产物早于输入件 ⇒ stale-output（每个产物至多一条，点名最早的输入件）", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "figs-fig1.svg");
    await writeFile(path, "<svg/>", "utf8");
    const manifest = await buildDeliverableManifest([{ role: "figure", path }]);
    // 把产物的时间戳推到过去 ⇒ 产物比两个输入件都旧。
    const past = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(path, past, past);
    const artifactMtimeMs = (await stat(path)).mtimeMs;

    const findings = await checkDeliverableManifest({
      manifest,
      current: [{ role: "figure", path }],
      inputs: [
        { label: "说明书.md", mtimeMs: artifactMtimeMs + 60_000 },
        { label: "权利要求书.md", mtimeMs: artifactMtimeMs + 120_000 },
      ],
    });

    const stale = findingsOf(findings, "stale-output");
    assert.equal(stale.length, 1, "不按输入件数量重复报");
    assert.equal(stale[0]?.file, "figs-fig1.svg");
    assert.match(stale[0]?.message ?? "", /说明书\.md/u, "应点名最早的那个输入件");
    assert.doesNotMatch(stale[0]?.message ?? "", /权利要求书\.md/u, "只报一条，不按输入件数量重复");
  });
});

test("校验：产物不早于输入件 ⇒ 不报 stale-output", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "figs-fig1.svg");
    await writeFile(path, "<svg/>", "utf8");
    const manifest = await buildDeliverableManifest([{ role: "figure", path }]);
    const artifactMtimeMs = (await stat(path)).mtimeMs;

    const findings = await checkDeliverableManifest({
      manifest,
      current: [{ role: "figure", path }],
      inputs: [{ label: "说明书.md", mtimeMs: artifactMtimeMs - 60_000 }],
    });

    assert.equal(findingsOf(findings, "stale-output").length, 0);
  });
});

test("校验：清单与目录现状一致 ⇒ 零发现", async () => {
  await withTempDir(async dir => {
    const path = join(dir, "figs-fig1.svg");
    await writeFile(path, "<svg/>", "utf8");
    const manifest = await buildDeliverableManifest([{ role: "figure", path }]);

    const findings = await checkDeliverableManifest({
      manifest,
      current: [{ role: "figure", path }],
      inputs: [{ label: "说明书.md", mtimeMs: 1 }],
    });

    assert.deepEqual(findings, []);
  });
});

test("命名归类：产物文件名 → 角色；图形文件名 → 图号", () => {
  assert.equal(classifyDeliverableFileName("figs-fig1.svg"), "figure");
  assert.equal(classifyDeliverableFileName("figs-fig1-page.svg"), "submission-page");
  assert.equal(classifyDeliverableFileName("figs-figures.html"), "html");
  assert.equal(classifyDeliverableFileName("figs-figures.json"), "sidecar");
  assert.equal(classifyDeliverableFileName("notes.txt"), undefined, "非产物文件不归类");
  assert.equal(deliverableFigureNo("figs-fig3.svg"), 3);
  assert.equal(deliverableFigureNo("figs-fig3-page.svg"), 3);
  assert.equal(deliverableFigureNo("figs-figures.html"), undefined);
});

test("sidecar：交付物清单是可选字段，旧 sidecar 仍可解析（不升版本）", () => {
  const base = {
    version: 1,
    generated_at: "2026-11-12T00:00:00.000Z",
    output_name: "figs",
    renderer: "builtin",
    jurisdiction: "cn",
    check: { stage: "generation", skip_text_rules: true, ok: true, findings: [] },
    figures: [],
  };
  const legacy = parseFigureSidecar(JSON.stringify(base));
  assert.equal(legacy.deliverables, undefined, "旧 sidecar 无 deliverables 字段是合法的");

  const withManifest = parseFigureSidecar(
    JSON.stringify({
      ...base,
      deliverables: [{ role: "figure", file: "figs-fig1.svg", sha256: "a".repeat(64), bytes: 12, mtimeMs: 1000 }],
    }),
  );
  assert.equal(withManifest.deliverables?.length, 1);
  assert.equal(withManifest.deliverables?.[0]?.file, "figs-fig1.svg");
});

test("sidecar：装配时写入清单（buildFigureSidecar 带出 deliverables）", () => {
  const sidecar = buildFigureSidecar({
    outputName: "figs",
    renderer: "builtin",
    jurisdiction: "cn",
    files: [],
    figures: [],
    check: { ok: true, findings: [], refsInFigures: [], refsInText: [] },
    skipTextRules: true,
    deliverables: [{ role: "figure", file: "figs-fig1.svg", sha256: "b".repeat(64), bytes: 12, mtimeMs: 1000 }],
  });
  assert.equal(sidecar.deliverables?.length, 1);
  assert.equal(sidecar.deliverables?.[0]?.role, "figure");

  const without: FigureSidecar = buildFigureSidecar({
    outputName: "figs",
    renderer: "builtin",
    jurisdiction: "cn",
    files: [],
    figures: [],
    check: { ok: true, findings: [], refsInFigures: [], refsInText: [] },
    skipTextRules: true,
  });
  assert.equal(without.deliverables, undefined, "缺省不写清单（旧行为）");
});

test("清单解析：结构不合法即报错（清单坏了不能被当作「没有清单」静默通过）", () => {
  assert.throws(
    () => parseDeliverableEntries([{ role: "unknown", file: "a.svg", sha256: "c".repeat(64), bytes: 1, mtimeMs: 1 }]),
    /role/u,
  );
  assert.throws(
    () => parseDeliverableEntries([{ role: "figure", file: "a.svg", sha256: "短", bytes: 1, mtimeMs: 1 }]),
    /sha256/u,
  );
  assert.throws(() => parseDeliverableEntries({}), /数组/u);
  assert.equal(parseDeliverableEntries(undefined), undefined, "字段缺省是合法的");
});
