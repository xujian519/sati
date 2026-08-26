#!/usr/bin/env node
/**
 * benchmark-pack-snapshot —— 打包被进化角色（`<source>` 目录，含 SKILL.md）为版本快照。
 *
 * 语义（对齐 PenguinHarness snapshots/v<N>.tar.gz）：
 *   - 版本只增不减、不重用：`v<N>` 已存在即报错，绝不覆盖。
 *   - 密钥/凭据/env 文件（`.vault.toml`、`.env`、secret/credential/token/apiKey/.pem 等）
 *     永不进快照——对齐"值只进子进程环境、永不进上下文"的约定。
 *
 * 前置：pnpm build（脚本依赖 dist/ 编译产物）。
 *
 * 用法：
 *   node scripts/benchmark-pack-snapshot.mjs \
 *       --source <角色目录> --benchmark-root <benchmarks 根> --benchmark-id <id> --version <N>
 *
 * 示例：
 *   node scripts/benchmark-pack-snapshot.mjs --source ./skills/patent/drafting \
 *       --benchmark-root ~/.sati/benchmarks --benchmark-id claims-drafting-quality --version 2
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchmarkPaths, packSnapshot } from "../dist/src/patent/evaluate/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function printHelp() {
  console.log(`用法: node scripts/benchmark-pack-snapshot.mjs
  --source <dir>               要打包的角色目录（含 SKILL.md）
  --benchmark-root <dir>       benchmarks 根目录（默认 ~/.sati/benchmarks）
  --benchmark-id <id>          基准 id
  --version <N>                快照版本（正整数）
  -h, --help                   显示本帮助`);
}

function parseArgs(argv) {
  const opts = {
    source: undefined,
    root: resolve(homedir(), ".sati", "benchmarks"),
    id: undefined,
    version: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--source":
        opts.source = argv[++i];
        break;
      case "--benchmark-root":
        opts.root = resolve(homedir(), argv[++i].replace(/^~/, ""));
        break;
      case "--benchmark-id":
        opts.id = argv[++i];
        break;
      case "--version":
        opts.version = Number(argv[++i]);
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`未知参数: ${a}`);
        printHelp();
        process.exit(1);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.source || !opts.id || !Number.isInteger(opts.version) || opts.version < 1) {
    console.error("需提供 --source、--benchmark-id 与正整数 --version。");
    printHelp();
    process.exit(1);
  }
  const source = resolve(ROOT, opts.source.replace(/^~/, ""));
  if (!existsSync(source)) {
    console.error(`source 不存在: ${source}`);
    process.exit(1);
  }
  if (!existsSync(resolve(ROOT, "dist/src/patent/evaluate/index.js"))) {
    console.error("dist/ 编译产物不存在，请先执行 pnpm build。");
    process.exit(1);
  }
  const paths = benchmarkPaths(opts.root, opts.id);
  const result = await packSnapshot(source, paths.snapshotsDir, opts.version);
  console.log(`[snapshot] v${result.version} -> ${result.root} (${result.files.length} files)`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
