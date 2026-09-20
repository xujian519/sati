import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { auditI18nNamespaces } from "../../scripts/check-i18n-namespaces.js";

/**
 * 负控制：`check:i18n-namespaces` 门禁的自测。
 *
 * 真实事故形态——`locales/zh-CN/tasks.json` 存在而 zh-CN 资源表漏注册 `tasks`：
 * i18next 不报错，静默回落英文。本文件用临时 fixture 证明门禁**真的会红**，
 * 并对仓库真实配置断言为绿（防"门禁写死为通过"）。
 */
function withFixture(
  layout: { config: string; locales: Record<string, string[]> },
  run: (options: { configPath: string; localesDir: string }) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "sati-i18n-"));
  try {
    const localesDir = join(root, "locales");
    for (const [language, namespaces] of Object.entries(layout.locales)) {
      mkdirSync(join(localesDir, language), { recursive: true });
      for (const ns of namespaces) {
        writeFileSync(join(localesDir, language, `${ns}.json`), "{}");
      }
    }
    const configPath = join(root, "config.js");
    writeFileSync(configPath, layout.config);
    run({ configPath, localesDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function configWith(resources: string, ns: string): string {
  return [
    'import i18n from "i18next";',
    "i18n.init({",
    `  resources: ${resources},`,
    `  ns: ${ns},`,
    '  defaultNS: "common",',
    "});",
    "export default i18n;",
  ].join("\n");
}

const CLEAN_CONFIG = configWith(
  `{ en: { common: {}, chat: {} }, "zh-CN": { common: {}, chat: {} } }`,
  `["common", "chat"]`,
);
const CLEAN_LOCALES = { en: ["common", "chat"], "zh-CN": ["common", "chat"] };

test("门禁：一致配置零问题", () => {
  withFixture({ config: CLEAN_CONFIG, locales: CLEAN_LOCALES }, ({ configPath, localesDir }) => {
    const audit = auditI18nNamespaces({ configPath, localesDir });
    assert.deepEqual(audit.issues, []);
    assert.equal(audit.namespaceCount, 2);
  });
});

test("门禁：语言包存在但资源表漏注册 → 报出该 namespace（zh-CN tasks 事故形态）", () => {
  const config = configWith(`{ en: { common: {}, tasks: {} }, "zh-CN": { common: {} } }`, `["common", "tasks"]`);
  withFixture(
    { config, locales: { en: ["common", "tasks"], "zh-CN": ["common", "tasks"] } },
    ({ configPath, localesDir }) => {
      const audit = auditI18nNamespaces({ configPath, localesDir });
      // 同一处漏注册会从三个角度被点名：语言包侧、ns 侧、跨语言 parity 侧。
      assert.ok(audit.issues.some(issue => /locales\/zh-CN\/: 语言包存在但未注册 → tasks/.test(issue)));
      assert.ok(audit.issues.some(issue => /resources\.zh-CN: ns 已声明但未注册 → tasks/.test(issue)));
      assert.ok(audit.issues.some(issue => /跨语言 parity 不一致/.test(issue)));
    },
  );
});

test("门禁：已注册但语言包缺失 → 报出多余键", () => {
  const config = configWith(`{ en: { common: {}, ghost: {} } }`, `["common"]`);
  withFixture({ config, locales: { en: ["common"] } }, ({ configPath, localesDir }) => {
    const audit = auditI18nNamespaces({ configPath, localesDir });
    assert.ok(audit.issues.some(issue => /已注册但语言包缺失 → ghost/.test(issue)));
  });
});

test("门禁：ns 已声明但未注册 → 报出缺项", () => {
  const config = configWith(`{ en: { common: {} } }`, `["common", "kanban"]`);
  withFixture({ config, locales: { en: ["common"] } }, ({ configPath, localesDir }) => {
    const audit = auditI18nNamespaces({ configPath, localesDir });
    assert.ok(audit.issues.some(issue => /resources\.en: ns 已声明但未注册 → kanban/.test(issue)));
  });
});

test("门禁：语言目录整体未注册 → 报出该语言", () => {
  const config = configWith(`{ en: { common: {} } }`, `["common"]`);
  withFixture({ config, locales: { en: ["common"], ja: ["common"] } }, ({ configPath, localesDir }) => {
    const audit = auditI18nNamespaces({ configPath, localesDir });
    assert.ok(audit.issues.some(issue => /locales\/ja\/ 未在 resources 中注册/.test(issue)));
  });
});

test("门禁：跨语言 parity 不一致 → 报出差异两侧", () => {
  const config = configWith(`{ en: { common: {}, chat: {} }, "zh-CN": { common: {} } }`, `["common", "chat"]`);
  withFixture({ config, locales: { en: ["common", "chat"], "zh-CN": ["common"] } }, ({ configPath, localesDir }) => {
    const audit = auditI18nNamespaces({ configPath, localesDir });
    assert.ok(audit.issues.some(issue => /跨语言 parity 不一致/.test(issue)));
  });
});

test("门禁：仓库真实配置为绿（防门禁被写成恒通过）", () => {
  const repoRoot = (() => {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (!existsSync(join(dir, "package.json"))) {
      const parent = dirname(dir);
      if (parent === dir) throw new Error("repo root not found (no package.json ancestor)");
      dir = parent;
    }
    return dir;
  })();
  const audit = auditI18nNamespaces({
    configPath: join(repoRoot, "ui", "src", "i18n", "config.js"),
    localesDir: join(repoRoot, "ui", "src", "i18n", "locales"),
  });
  assert.deepEqual(audit.issues, []);
  assert.ok(audit.languages.includes("zh-CN"));
});
