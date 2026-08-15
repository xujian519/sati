import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildBrandStyle,
  findChrome,
  loadBrandFromPath,
  mergeBrand,
  readTemplateManifest,
  renderPatentDocument,
} from "../../../src/patent/document/index.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-doc-"));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test("模板根目录与 manifest 可解析", () => {
  const manifest = readTemplateManifest();
  assert.ok(Array.isArray(manifest.templates));
  assert.ok(manifest.templates?.includes("patentability-opinion"));
});

test("默认品牌配置文件可加载", () => {
  const brand = loadBrandFromPath("products/_example/brand/theme.json");
  assert.equal(brand.firm, "宝宸知识产权代理事务所");
  assert.equal(brand.accent, "#1f3a5f");
});

test("品牌 CSS 生成包含引号与颜色", () => {
  const css = buildBrandStyle({ firm: "Test Firm", accent: "#123456" });
  assert.match(css, /--sati-doc-firm: "Test Firm";/);
  assert.match(css, /--sati-doc-accent: #123456;/);
});

test("合并品牌：显式覆盖配置文件", () => {
  const brand = mergeBrand({ firm: "Explicit" }, { firm: "Config", accent: "#000" });
  assert.equal(brand.firm, "Explicit");
  assert.equal(brand.accent, "#000");
});

test("渲染生成 HTML 并正确注入内容与品牌", async () => {
  const dir = makeTempDir();
  try {
    const result = await renderPatentDocument(
      {
        template: "patentability-opinion",
        outputName: "test-opinion",
        outputDir: dir,
        format: "html",
        brand: { firm: "测试事务所" },
        sections: {
          "meta-client": "委托方 A",
          "meta-title": "智能保温杯",
          "sum-conclusion": "授权前景良好。",
        },
      },
      process.cwd(),
    );

    assert.ok(existsSync(result.htmlPath));
    const html = readFileSync(result.htmlPath, "utf8");

    assert.match(html, /测试事务所/);
    assert.match(html, /委托方 A/);
    assert.match(html, /智能保温杯/);
    assert.match(html, /授权前景良好。/);
    assert.equal(result.pdfPath, undefined);
    assert.equal(result.pdfError, undefined);
  } finally {
    cleanup(dir);
  }
});

test("无 brand 时回退到默认 tokens.css 变量", async () => {
  const dir = makeTempDir();
  try {
    const result = await renderPatentDocument(
      {
        template: "patentability-opinion",
        outputName: "test-default-brand",
        outputDir: dir,
        format: "html",
        brandPath: join(dir, "nonexistent.json"),
        sections: { "meta-title": "默认品牌测试" },
      },
      process.cwd(),
    );

    const html = readFileSync(result.htmlPath, "utf8");
    // tokens.css 默认所名
    assert.match(html, /XX 知识产权代理事务所/);
  } finally {
    cleanup(dir);
  }
});

test("caseId 使用 data/cases/<caseId>/outputs 目录", async () => {
  const dir = makeTempDir();
  try {
    const result = await renderPatentDocument(
      {
        template: "search-report",
        outputName: "sr-001",
        caseId: "case-2026-001",
        format: "html",
        sections: { "meta-title": "检索报告测试" },
      },
      dir,
    );

    assert.match(result.htmlPath, /data[\\/]cases[\\/]case-2026-001[\\/]outputs[\\/]sr-001\.html$/);
    assert.ok(existsSync(result.htmlPath));
  } finally {
    cleanup(dir);
  }
});

test("非法输出文件名 fail-closed", async () => {
  const dir = makeTempDir();
  try {
    await assert.rejects(
      renderPatentDocument(
        {
          template: "patentability-opinion",
          outputName: "../escape",
          outputDir: dir,
          format: "html",
          sections: {},
        },
        process.cwd(),
      ),
      /非法输出文件名/,
    );
  } finally {
    cleanup(dir);
  }
});

test("系统 Chrome 存在时可生成 PDF", async () => {
  if (findChrome() === undefined) {
    // 在 CI 或无 Chrome 环境跳过；核心功能已由 HTML 测试覆盖。
    return;
  }
  const dir = makeTempDir();
  try {
    const result = await renderPatentDocument(
      {
        template: "patentability-opinion",
        outputName: "test-pdf",
        outputDir: dir,
        format: "pdf",
        sections: { "meta-title": "PDF 生成测试" },
      },
      process.cwd(),
    );

    assert.ok(result.pdfPath !== undefined);
    assert.ok(existsSync(result.pdfPath));
    assert.ok(existsSync(result.htmlPath));
  } finally {
    cleanup(dir);
  }
});

test("容器型 section id 注入不破坏结构", async () => {
  const dir = makeTempDir();
  try {
    const result = await renderPatentDocument(
      {
        template: "patentability-opinion",
        outputName: "container-inject",
        outputDir: dir,
        format: "html",
        sections: { "executive-summary": "<h3>新摘要</h3><p>内容 A</p>" },
      },
      process.cwd(),
    );
    const html = readFileSync(result.htmlPath, "utf8");
    assert.match(html, /<section id="executive-summary"[^>]*>\s*<h3>新摘要<\/h3><p>内容 A<\/p>\s*<\/section>/);
  } finally {
    cleanup(dir);
  }
});

test("未命中/非法 section id 返回警告且不污染 HTML", async () => {
  const dir = makeTempDir();
  try {
    const result = await renderPatentDocument(
      {
        template: "patentability-opinion",
        outputName: "warn-ids",
        outputDir: dir,
        format: "html",
        sections: { "meta-title": "正常", "no-such-id": "丢弃", "../bad": "非法" },
      },
      process.cwd(),
    );
    assert.ok(result.warnings !== undefined);
    assert.match(result.warnings.join(" "), /no-such-id/);
    const html = readFileSync(result.htmlPath, "utf8");
    assert.match(html, /正常/);
    assert.doesNotMatch(html, /丢弃/);
  } finally {
    cleanup(dir);
  }
});

test("非法案卷号 fail-closed（防路径穿越）", async () => {
  const dir = makeTempDir();
  try {
    await assert.rejects(
      renderPatentDocument(
        {
          template: "patentability-opinion",
          outputName: "escape",
          caseId: "../../etc",
          format: "html",
          sections: {},
        },
        dir,
      ),
      /非法案卷号/,
    );
  } finally {
    cleanup(dir);
  }
});

test("品牌 CSS 值剔除破坏性字符（防注入）", () => {
  const css = buildBrandStyle({ accent: "#123; } body { display:none", firm: 'A"B' });
  assert.equal((css.match(/\{/g) ?? []).length, 1);
  assert.equal((css.match(/\}/g) ?? []).length, 1);
  assert.doesNotMatch(css, /\{ body|\} body/);
  assert.match(css, /--sati-doc-firm: "A\\"B";/);
});

test("重复渲染同名文档可覆盖（原子写）", async () => {
  const dir = makeTempDir();
  try {
    await renderPatentDocument(
      {
        template: "patentability-opinion",
        outputName: "dup",
        outputDir: dir,
        format: "html",
        sections: { "meta-title": "第一版" },
      },
      process.cwd(),
    );
    const result = await renderPatentDocument(
      {
        template: "patentability-opinion",
        outputName: "dup",
        outputDir: dir,
        format: "html",
        sections: { "meta-title": "第二版" },
      },
      process.cwd(),
    );
    const html = readFileSync(result.htmlPath, "utf8");
    assert.match(html, /第二版/);
    assert.doesNotMatch(html, /第一版/);
  } finally {
    cleanup(dir);
  }
});

test("显式 brandPath 不存在时返回警告并回退默认", async () => {
  const dir = makeTempDir();
  try {
    const result = await renderPatentDocument(
      {
        template: "patentability-opinion",
        outputName: "missing-brand",
        outputDir: dir,
        format: "html",
        brandPath: join(dir, "not-there.json"),
        sections: { "meta-title": "品牌回退测试" },
      },
      process.cwd(),
    );
    assert.ok(result.warnings !== undefined);
    assert.match(result.warnings.join(" "), /品牌配置文件不存在/);
  } finally {
    cleanup(dir);
  }
});
