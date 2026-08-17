import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Document, isMap, parseDocument } from "yaml";
import { brandEnv, ENV_KEY } from "../../env.js";

const SATI_HOME = brandEnv(process.env, ENV_KEY.HOME) || join(homedir(), ".sati");
const SATI_YAML_PATH = brandEnv(process.env, ENV_KEY.CONFIG_PATH) || join(SATI_HOME, "sati.yaml");

/**
 * `sati config set <key.path> <value>` / `sati config delete <key.path>`
 *
 * Minimal nested-key support: dotted paths create/update/remove keys in
 * `~/.sati/sati.yaml` (SATI_HOME / SATI_CONFIG_PATH override). Only the
 * top-level section being written is touched; other config is preserved.
 * YAML parse/write errors are reported as fatal without touching the file.
 *
 * 用 yaml 的 Document（parseDocument + setIn/deleteIn）做原地编辑：parseYaml/
 * stringify 的 round-trip 会静默丢弃用户注释与 anchors，Document 编辑保留。
 */
export async function runConfigCommand(argv: string[]): Promise<void> {
  try {
    const sub = argv[0];
    if (sub === "set") {
      await setConfigValue(argv[1], argv[2]);
      return;
    }
    if (sub === "delete") {
      await deleteConfigValue(argv[1]);
      return;
    }
    console.error("Usage: sati config set <key.path> <value> | sati config delete <key.path>");
    process.exitCode = 1;
  } catch {
    // validateKeyPath / loadYamlDoc 已打印具体错误；此处仅避免堆栈泄漏。
    process.exitCode = 1;
  }
}

async function setConfigValue(keyPath: string | undefined, value: string | undefined): Promise<void> {
  if (value === undefined) {
    console.error("Usage: sati config set <key.path> <value>");
    process.exitCode = 1;
    return;
  }
  const segments = validateKeyPath(keyPath);
  const doc = loadYamlDoc();
  const result = setNestedInDoc(doc, segments, value);
  if (!result.ok) {
    console.error(`sati: cannot set ${segments.join(".")}: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  saveYamlDoc(doc);
  console.log(`sati: ${segments.join(".")} = ${value} (${SATI_YAML_PATH})`);
}

async function deleteConfigValue(keyPath: string | undefined): Promise<void> {
  const segments = validateKeyPath(keyPath);
  const doc = loadYamlDoc();
  const result = deleteNestedInDoc(doc, segments);
  if (!result.ok) {
    console.error(`sati: cannot delete ${segments.join(".")}: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  saveYamlDoc(doc);
  console.log(`sati: deleted ${segments.join(".")} (${SATI_YAML_PATH})`);
}

/** Dotted key path validation: 1–3 segments, each a non-empty identifier. */
function validateKeyPath(keyPath: string | undefined): string[] {
  if (keyPath === undefined || !/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*){0,2}$/.test(keyPath)) {
    console.error("Usage: sati config <set|delete> <section.key[.key]>");
    throw new Error("invalid config key path");
  }
  return keyPath.split(".");
}

/**
 * 读 `sati.yaml` 为 YAML Document（文件缺失 → 空文档；语法错误 → 致命退出）。
 * 与 parseYaml 不同，parseDocument 不抛错而是收集 doc.errors，需显式检查。
 */
function loadYamlDoc(): Document {
  try {
    if (!existsSync(SATI_YAML_PATH)) return new Document();
    const raw = readFileSync(SATI_YAML_PATH, "utf-8");
    const doc = parseDocument(raw);
    if (doc.errors.length > 0) {
      throw new Error(doc.errors.map(e => e.message).join("; "));
    }
    return doc;
  } catch (error) {
    console.error(`sati: failed to read ${SATI_YAML_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    throw error;
  }
}

function saveYamlDoc(doc: Document): void {
  mkdirSync(dirname(SATI_YAML_PATH), { recursive: true });
  // lineWidth: 0 关闭折行（与旧 stringifyYaml 行为一致），仅在输出端生效。
  writeFileSync(SATI_YAML_PATH, doc.toString({ lineWidth: 0 }), "utf-8");
}

/** 推断 CLI 值的类型：数字 / 布尔原样写入，其余按字符串（避免数字配置被引号包裹）。 */
function inferScalar(value: string): string | number | boolean {
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

/**
 * Set a nested value (path of 1–3 segments), creating intermediate objects.
 * 中间节点须为 YAML 映射（getIn 对标量/数组返回 JS 原语/YAMLSeq，isMap 判 false）。
 */
function setNestedInDoc(doc: Document, segments: string[], value: string): { ok: true } | { ok: false; error: string } {
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = doc.getIn(segments.slice(0, index + 1));
    if (next === undefined) continue; // 缺失路径由 setIn 自动创建
    if (!isMap(next)) {
      return { ok: false, error: `${segments.slice(0, index + 1).join(".")} is not an object` };
    }
  }
  doc.setIn(segments, inferScalar(value));
  return { ok: true };
}

/** Delete a nested key; empty parent sections are pruned (no `patents: {}` residue). */
function deleteNestedInDoc(doc: Document, segments: string[]): { ok: true } | { ok: false; error: string } {
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = doc.getIn(segments.slice(0, index + 1));
    if (next === undefined) {
      return { ok: true }; // 路径不存在，无需删除
    }
    if (!isMap(next)) {
      return { ok: false, error: `${segments.slice(0, index + 1).join(".")} is not an object` };
    }
  }
  doc.deleteIn(segments);
  pruneEmptyInDoc(doc, segments);
  return { ok: true };
}

/** 自底向上删除路径上的空节（不留 `patents: {}` 残节）。 */
function pruneEmptyInDoc(doc: Document, segments: readonly string[]): void {
  for (let len = segments.length - 1; len >= 1; len -= 1) {
    const prefix = segments.slice(0, len);
    const node = doc.getIn(prefix);
    if (isMap(node) && node.items.length === 0) {
      doc.deleteIn(prefix);
    } else {
      break;
    }
  }
}
