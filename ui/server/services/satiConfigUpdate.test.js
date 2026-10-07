import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configRevision, readSatiConfigFile, updateSatiConfig } from "./satiConfig.js";
import { writeConfigAtomically } from "./satiConfigFileIo.js";

const tempDirs = [];

afterEach(() => {
  delete process.env.SATI_CONFIG_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function useTempConfig(contents, filename = "sati.yaml") {
  const dir = mkdtempSync(join(tmpdir(), "sati-config-update-"));
  tempDirs.push(dir);
  const configPath = join(dir, filename);
  if (contents !== null) {
    writeFileSync(configPath, contents, "utf8");
  }
  process.env.SATI_CONFIG_PATH = configPath;
  return configPath;
}

/** 一份带注释、带行尾注释、键序刻意排布的配置，用于验证外科写入。 */
const ANNOTATED_CONFIG = [
  "# 顶部注释：我的 Sati 配置",
  "schemaVersion: 1",
  "agent:",
  "  model: openai/gpt-4o   # 行尾注释：默认模型",
  "model:",
  "  providers:",
  "    openai:",
  "      apiKey: sk-existing",
  "      # 这一行注释必须留下",
  "      models:",
  "        - gpt-4o",
  "        - gpt-4o-mini",
  "",
].join("\n");

describe("updateSatiConfig surgical write", () => {
  it("preserves comments, inline comments and key order outside the changed path", async () => {
    const configPath = useTempConfig(ANNOTATED_CONFIG);

    const outcome = await updateSatiConfig(
      next => {
        next.agent.model = "openai/gpt-4o-mini";
        return true;
      },
      { paths: [["agent", "model"]] },
    );

    expect(outcome.changed).toBe(true);
    const raw = readFileSync(configPath, "utf8");
    expect(raw).toContain("# 顶部注释：我的 Sati 配置");
    expect(raw).toContain("# 这一行注释必须留下");
    expect(raw).toContain("# 行尾注释：默认模型");
    expect(raw).toContain("openai/gpt-4o-mini");
    // 键序：整份重写会按 schema 顺序重排，外科写入应保持用户原有顺序。
    expect(raw.indexOf("schemaVersion")).toBeLessThan(raw.indexOf("agent:"));
    expect(raw.indexOf("agent:")).toBeLessThan(raw.indexOf("model:"));
    expect(raw.indexOf("apiKey")).toBeLessThan(raw.indexOf("# 这一行注释必须留下"));
  });

  it("does not materialize schema defaults into the user file", async () => {
    const configPath = useTempConfig(ANNOTATED_CONFIG);

    await updateSatiConfig(
      next => {
        next.agent.model = "openai/gpt-4o-mini";
        return true;
      },
      { paths: [["agent", "model"]] },
    );

    // 整份重写会走 normalizeSatiConfig，把 buildDefaultSatiConfig 的默认值
    // 物化进用户文件（memory.router.webui…），这是本次改动要避免的行为。
    const raw = readFileSync(configPath, "utf8");
    expect(raw).not.toContain("memory:");
    expect(raw).not.toContain("router:");
    expect(raw).not.toContain("webui:");
    expect(raw).not.toContain("schemaVersion: 1\nmemory");
  });

  it("deletes a key when the mutated value is undefined", async () => {
    const configPath = useTempConfig(ANNOTATED_CONFIG);

    await updateSatiConfig(
      next => {
        delete next.agent.model;
        return true;
      },
      { paths: [["agent", "model"]] },
    );

    const raw = readFileSync(configPath, "utf8");
    expect(raw).not.toContain("openai/gpt-4o");
    expect(raw).toContain("# 顶部注释：我的 Sati 配置");
  });

  it("creates missing parent nodes for a path that does not exist yet", async () => {
    const configPath = useTempConfig("schemaVersion: 1\n");

    await updateSatiConfig(
      next => {
        next.webui = { ...(next.webui ?? {}), theme: "dark" };
        return true;
      },
      { paths: [["webui", "theme"]] },
    );

    const raw = readFileSync(configPath, "utf8");
    expect(raw).toContain("theme: dark");
    expect(readSatiConfigFile().rawYaml.webui.theme).toBe("dark");
  });

  it("returns changed:false and leaves the file byte-identical when mutate declines", async () => {
    const configPath = useTempConfig(ANNOTATED_CONFIG);
    const before = readFileSync(configPath, "utf8");

    const outcome = await updateSatiConfig(() => false, { paths: [["agent", "model"]] });

    expect(outcome.changed).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("requires at least one changed path", async () => {
    useTempConfig(ANNOTATED_CONFIG);

    await expect(updateSatiConfig(() => true, { paths: [] })).rejects.toThrow(TypeError);
    await expect(updateSatiConfig(() => true, {})).rejects.toThrow(TypeError);
  });

  it("keeps the dominant indent width when the file also has a shallower block", async () => {
    // doc.toString({ indent }) 重排整份文档，故缩进探测不能取最小值：这里主流是
    // 4 空格（adapters 块），只有 agent 块是 2 空格——取 min 会把 feishu/appId
    // 一并压成 2 空格，违背「缩进不动」的承诺。
    const configPath = useTempConfig(
      [
        "adapters:",
        "    feishu:",
        "        appId: cli_x",
        "    wecom:",
        "        enabled: false",
        "agent:",
        "  model: openai/gpt-4o",
        "",
      ].join("\n"),
    );

    await updateSatiConfig(
      next => {
        next.adapters.wecom = { enabled: true };
        return true;
      },
      { paths: [["adapters", "wecom"]] },
    );

    const raw = readFileSync(configPath, "utf8");
    expect(raw).toContain("    wecom:\n        enabled: true");
    // 主流宽度胜出：未触及的 4 空格 feishu 块保持原样，没被压成 2 空格。
    expect(raw).toContain("    feishu:\n        appId: cli_x");
    // 缩进是文档级参数，少数派的 2 空格块会被对齐到众数宽度。这是 toString 的
    // 固有行为，取众数只能把受影响的面积压到最小，无法逐行保留。
    expect(raw).toContain("agent:\n    model: openai/gpt-4o");
  });
});

describe("updateSatiConfig concurrency and conflict safety", () => {
  it("serializes concurrent updates: the file is always one writer's complete output", async () => {
    const configPath = useTempConfig(ANNOTATED_CONFIG);
    const models = ["openai/gpt-4o", "openai/gpt-4o-mini", "openai/gpt-4.1"];

    await Promise.all(
      models.map(model =>
        updateSatiConfig(
          next => {
            next.agent.model = model;
            return true;
          },
          { paths: [["agent", "model"]] },
        ),
      ),
    );

    const record = readSatiConfigFile();
    expect(record.parseError).toBeNull();
    expect(models).toContain(record.rawYaml.agent.model);
    // 并发写不得留下 temp 残留或半截内容。
    expect(readFileSync(configPath, "utf8")).toContain("# 顶部注释：我的 Sati 配置");
  });

  it("replays the local change on top of an external save instead of overwriting it", async () => {
    const configPath = useTempConfig(ANNOTATED_CONFIG);

    // 模拟外部编辑器在稳定读的间隔里落盘：单次读会漏掉这次变更并覆盖它。
    const externalEdit = setTimeout(() => {
      writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n# external edit\n`, "utf8");
    }, 120);

    const outcome = await updateSatiConfig(
      next => {
        next.agent.model = "openai/gpt-5";
        return true;
      },
      { paths: [["agent", "model"]] },
    );
    clearTimeout(externalEdit);

    expect(outcome.changed).toBe(true);
    // 外部编辑与本地改动都必须留下——静默覆盖会让用户丢掉手工编辑。
    const raw = readFileSync(configPath, "utf8");
    expect(raw).toContain("# external edit");
    expect(raw).toContain("openai/gpt-5");
  });

  it("rejects a stale expectedRevision at write time instead of clobbering the file", async () => {
    const configPath = useTempConfig(ANNOTATED_CONFIG);
    const staleRevision = configRevision(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# external edit\n`, "utf8");

    const outcome = await writeConfigAtomically({
      writePath: configPath,
      raw: "schemaVersion: 1\n",
      expectedRevision: staleRevision,
    }).then(
      () => null,
      error => error,
    );

    expect(outcome).not.toBeNull();
    expect(outcome.code).toBe("CONFIG_CONFLICT");
    expect(outcome.currentRevision).toBe(configRevision(readFileSync(configPath, "utf8")));
    // 冲突后磁盘仍是外部编辑的那一份。
    expect(readFileSync(configPath, "utf8")).toContain("# external edit");
  });

  it("follows a symlinked config path and keeps the symlink intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-config-update-symlink-"));
    tempDirs.push(dir);
    const targetPath = join(dir, "real-config.yaml");
    writeFileSync(targetPath, ANNOTATED_CONFIG, "utf8");
    const configPath = join(dir, "sati.yaml");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(targetPath, configPath);
    process.env.SATI_CONFIG_PATH = configPath;

    await updateSatiConfig(
      next => {
        next.agent.model = "openai/gpt-4o-mini";
        return true;
      },
      { paths: [["agent", "model"]] },
    );

    expect(readFileSync(targetPath, "utf8")).toContain("openai/gpt-4o-mini");
    expect(readFileSync(targetPath, "utf8")).toContain("# 顶部注释：我的 Sati 配置");
  });
});
