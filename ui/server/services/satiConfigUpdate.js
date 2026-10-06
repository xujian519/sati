import { parse as parseYaml, parseDocument } from "yaml";
import { readSatiConfigFile } from "./satiConfig.js";
import {
  ConfigConflictError,
  configRevision,
  readStableConfigRecord,
  resolveConfigWritePath,
  withConfigWriteLock,
  writeConfigAtomically,
} from "./satiConfigFileIo.js";

/**
 * 外科写（path-scoped update）：只改 `paths` 指到的键，文件其余部分按字节保留
 * ——注释、行尾注释与键序都不动。
 *
 * 缩进是**文档级**参数（`doc.toString({ indent })` 会重排整份文档），故只能保
 * 住"主流宽度"：缩进本就一致的文档（绝大多数）完全不动；文档里若混着不同宽度
 * 的块，少数派会被对齐到众数宽度。取众数而非最小值，是为了让受影响的面积最小
 * ——取 min 会让一行浅缩进把全文拉平，取众数则只有少数派被改。
 *
 * 与 writeSatiConfig（satiConfig.js）的分工：后者走 validateSatiConfig →
 * normalizeSatiConfig，会把 buildDefaultSatiConfig 的默认值物化进用户文件并整份重排
 * （schema 顺序）；IM 渠道配置这类"只改一个键"的调用不该付这个代价，也不该洗掉用户
 * 手写的注释。
 *
 * 事务性与 writeSatiConfig 一致：稳定读 + 进程内串行 + 写前 revision 校验 +
 * temp/rename 原子写。冲突时不静默覆盖——重新读一遍再把本地改动重放到新内容上，
 * 外部编辑与本地改动都保留；重试耗尽才抛 `CONFIG_CONFLICT`。
 *
 * 单列一个模块是因为 satiConfig.js 已触 file-size 棘轮（见
 * docs/technical-debt/architecture-baseline.json），而本能力与配置 schema / 校验无关，
 * 只依赖 I/O 原语。
 */

/** 冲突重试次数：外部编辑落在"稳定读 → 落盘"之间时重新读改写。 */
const CONFIG_UPDATE_ATTEMPTS = 3;

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 从现有文件探测缩进宽度（2..8），保住用户原有排版。
 *
 * 取**出现次数最多**的宽度而非最小值：`doc.toString({ indent })` 会重排整份
 * 文档，只要有一行比主流更浅（例如历史 `writeSatiConfig` 写下的 2 空格块混在
 * 4 空格文档里），min 就会把全文拉成 2 空格——违背本模块"缩进不动"的承诺。
 * 众数让主流宽度胜出；平局取较小者以保证结果确定。
 */
function detectYamlIndent(raw) {
  const indents = String(raw ?? "")
    .split(/\r?\n/)
    .filter(line => line.trim() && !line.trimStart().startsWith("#"))
    .map(line => line.match(/^ +/)?.[0].length ?? 0)
    .filter(value => value > 0);
  if (!indents.length) return 2;
  const counts = new Map();
  for (const width of indents) counts.set(width, (counts.get(width) ?? 0) + 1);
  let best = indents[0];
  let bestCount = 0;
  for (const width of [...counts.keys()].sort((a, b) => a - b)) {
    const count = counts.get(width);
    if (count > bestCount) {
      best = width;
      bestCount = count;
    }
  }
  return Math.max(2, Math.min(8, best));
}

function valueAtPath(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** 路径中间层缺失时补出容器节点，否则 setIn 无处落脚。 */
function prepareYamlPathParents(doc, next, keys) {
  for (let length = 1; length < keys.length; length += 1) {
    const prefix = keys.slice(0, length);
    if (doc.hasIn(prefix)) continue;
    const nextParent = valueAtPath(next, prefix);
    if (Array.isArray(nextParent)) doc.setIn(prefix, doc.createNode([]));
    else if (isRecord(nextParent)) doc.setIn(prefix, doc.createNode({}));
  }
}

/**
 * @param mutate 收到磁盘当前原始对象（可变副本），就地修改后返回 false 表示无需落盘。
 * @param paths 本次容许变更的键路径列表（如 `[["gateway","feishu","appId"]]`）。
 */
export async function updateSatiConfig(mutate, { paths, onWriteCommitted } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new TypeError("updateSatiConfig requires at least one changed path");
  }
  return withConfigWriteLock(async () => {
    let lastConflict;
    for (let attempt = 0; attempt < CONFIG_UPDATE_ATTEMPTS; attempt += 1) {
      const disk = await readStableConfigRecord(readSatiConfigFile, {
        makeUnstableError: previous =>
          new ConfigConflictError(
            "Config is still changing on disk. Retry after the external save finishes.",
            configRevision(previous.raw ?? ""),
          ),
      });
      if (disk.rawYaml === null) {
        const error = new Error(`Config file is not valid YAML: ${disk.parseError}`);
        error.code = "INVALID_CONFIG_YAML";
        throw error;
      }

      const next = clone(disk.rawYaml);
      if ((await mutate(next)) === false) {
        return { changed: false, configPath: disk.configPath, raw: disk.raw, config: disk.config };
      }

      // 空文件（首次配置 / 空 YAML）解析出的 document 没有内容节点，setIn 无处落脚；
      // 用空映射起步，让首次写入也能走同一条路径。
      const doc = parseDocument(disk.raw.trim() ? disk.raw : "{}", { keepSourceTokens: true });
      if (doc.errors.length) {
        const error = new Error(`Config file is not valid YAML: ${doc.errors[0].message}`);
        error.code = "INVALID_CONFIG_YAML";
        throw error;
      }
      for (const keys of paths) {
        prepareYamlPathParents(doc, next, keys);
        const value = valueAtPath(next, keys);
        if (value === undefined) doc.deleteIn(keys);
        else doc.setIn(keys, value);
      }
      const raw = doc.toString({ indent: detectYamlIndent(disk.raw), lineWidth: 0 });
      try {
        parseYaml(raw);
      } catch (error) {
        const invalid = new Error(
          `Config update produced invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
        );
        invalid.code = "INVALID_CONFIG_YAML";
        throw invalid;
      }

      try {
        await writeConfigAtomically({
          writePath: await resolveConfigWritePath(disk.configPath),
          raw,
          expectedRevision: configRevision(disk.raw),
          onWriteCommitted,
        });
        const saved = readSatiConfigFile();
        return { changed: true, configPath: saved.configPath, raw: saved.raw, config: saved.config };
      } catch (error) {
        // 冲突：外部编辑落在读与写之间。重读后重放本地改动，两边都保留。
        validateConfigConflict(error);
        if (attempt === CONFIG_UPDATE_ATTEMPTS - 1) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict;
  });
}

function validateConfigConflict(error) {
  if (error?.code !== "CONFIG_CONFLICT") throw error;
}
