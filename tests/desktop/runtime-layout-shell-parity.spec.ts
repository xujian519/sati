import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stageRuntimeLayout } from "../../apps/desktop/src/runtime-layout.js";

/**
 * 运行时布局铺陈的 **TS ↔ shell 跨语言一致性**判据。
 *
 * 同一件事有两份实现，且**没有类型面把它们连起来**：
 *   - TS：`runtime-layout.ts` 的 `stageRuntimeLayout()`，用户机器上的 Electron 主进程跑；
 *   - shell：`scripts/lib/packaged-runtime.sh` 的 `pd_runtime_stage_links()`，
 *     L1（verify-dmg.sh）与 L2/L3（release-l2/l3.sh）共用。
 * 二选一漏改的后果正是 issue 点名的「脚本校验通过但用户跑不起来」。本用例把两版拉到
 * 同一棵合成树上跑，逐条比对产生的链接映射。
 *
 * 平台：依赖 bash（CI 为 ubuntu）。无 bash 时显式 skip，不静默通过。
 *
 * 刻意不等同的一点：**已存在条目的处理**。TS 侧 `linkDirectory` 用 `existsSync` 守卫
 * 跳过（运行时每次启动都会跑到，必须幂等且不得动到既有内容）；shell 侧用 `ln -sfn`
 * 覆盖（只在 mktemp 出的新沙箱里跑一次）。新建树上两者产物相同，故本用例用新树。
 */

const specDir = path.dirname(fileURLToPath(import.meta.url));

/** 同时可从 dist/tests/desktop/ 与 tests/desktop/ 解析到仓库里的 shell 库。 */
function libPath(): string {
  const candidates = [
    path.join(specDir, "../../../apps/desktop/scripts/lib/packaged-runtime.sh"),
    path.join(specDir, "../../apps/desktop/scripts/lib/packaged-runtime.sh"),
  ];
  const hit = candidates.find(existsSync);
  assert.ok(hit, `找不到 packaged-runtime.sh，候选：${candidates.join(", ")}`);
  return hit;
}

function bashAvailable(): boolean {
  return spawnSync("bash", ["-c", "true"]).status === 0;
}

function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/** 造一棵最小运行时树：三份解包目录 + sati-main 的 dist/node_modules + 一个空壳。 */
function makeTree(root: string) {
  const sandbox = path.join(root, "sandbox");
  const ccm = path.join(sandbox, "sati-main");
  const mem = path.join(sandbox, "sati-memory-core");
  mkdirp(path.join(ccm, "dist", "src", "context", "memory", "edgeclaw-memory-core", "src"));
  mkdirp(path.join(ccm, "node_modules"));
  mkdirp(path.join(sandbox, "satiui", "server"));
  mkdirp(path.join(mem, "lib"));
  fs.writeFileSync(path.join(mem, "lib", "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(ccm, "dist", "src", "context", "memory", "edgeclaw-memory-core", "src", "i.ts"), "");
  return { sandbox, ccm, mem };
}

/** 逐条收集符号链接 → 目标（相对 sandbox），不进入符号链接。 */
function linkMap(sandbox: string): Record<string, string> {
  const out: Record<string, string> = {};
  const realBase = fs.realpathSync(sandbox);
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        out[relPath] = path.relative(realBase, fs.realpathSync(abs));
        continue;
      }
      if (st.isDirectory()) walk(abs, relPath);
    }
  };
  walk(sandbox, "");
  return out;
}

function runShellStaging(sandbox: string, ccm: string, mem: string): { status: number | null; stderr: string } {
  // 与 verify-dmg.sh 的调用形态一致（第 4 参 0 = 不建根级 edgeclaw-memory-core）
  const script = 'set -uo pipefail\nsource "$1"\npd_runtime_stage_links "$2" "$3" "$4" 0\n';
  const res = spawnSync("bash", ["-c", script, "sati-shell-parity", libPath(), sandbox, ccm, mem], {
    encoding: "utf8",
  });
  return { status: res.status, stderr: res.stderr ?? "" };
}

test("shell 与 TS 的布局铺陈对同一棵树产出一致的链接映射", t => {
  if (!bashAvailable()) {
    t.skip("bash 不可用");
    return;
  }
  const rootTs = fs.mkdtempSync(path.join(os.tmpdir(), "sati-stage-ts-"));
  const tsTree = makeTree(rootTs);
  stageRuntimeLayout({ runtimeBaseDir: tsTree.sandbox, satiMainDir: tsTree.ccm, satiMemoryDir: tsTree.mem });
  const fromTs = linkMap(tsTree.sandbox);

  const rootSh = fs.mkdtempSync(path.join(os.tmpdir(), "sati-stage-sh-"));
  const shTree = makeTree(rootSh);
  const res = runShellStaging(shTree.sandbox, shTree.ccm, shTree.mem);
  assert.equal(res.status, 0, `shell 铺陈失败：${res.stderr}`);
  const fromShell = linkMap(shTree.sandbox);

  assert.deepEqual(fromShell, fromTs, "TS 与 shell 的链接映射必须逐条相同");
  // 顺带确认这棵树确实触发了全部五条（否则「两边都什么都没做」也会过）
  assert.deepEqual(Object.keys(fromTs).sort(), [
    "dist",
    "node_modules",
    "sati-main/dist/src/context/memory/edgeclaw-memory-core",
    "sati-main/node_modules/edgeclaw-memory-core",
    "src",
  ]);
  fs.rmSync(rootTs, { recursive: true, force: true });
  fs.rmSync(rootSh, { recursive: true, force: true });
});

test("shell 侧第 4 参为 1 时多建根级 edgeclaw-memory-core（release-l2/l3 的原行为）", t => {
  if (!bashAvailable()) {
    t.skip("bash 不可用");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sati-stage-root-"));
  const tree = makeTree(root);
  const script = 'set -uo pipefail\nsource "$1"\npd_runtime_stage_links "$2" "$3" "$4" 1\n';
  const res = spawnSync("bash", ["-c", script, "x", libPath(), tree.sandbox, tree.ccm, tree.mem], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr ?? "");

  const extra = path.join(tree.sandbox, "edgeclaw-memory-core");
  assert.equal(fs.lstatSync(extra).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(extra), fs.realpathSync(tree.mem));
  fs.rmSync(root, { recursive: true, force: true });
});

test("shell 与 TS 都先删掉 tsc 产出的同名空壳目录再建链接", t => {
  if (!bashAvailable()) {
    t.skip("bash 不可用");
    return;
  }
  for (const which of ["ts", "shell"] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `sati-stage-stub-${which}-`));
    const tree = makeTree(root);
    if (which === "ts") {
      stageRuntimeLayout({ runtimeBaseDir: tree.sandbox, satiMainDir: tree.ccm, satiMemoryDir: tree.mem });
    } else {
      assert.equal(runShellStaging(tree.sandbox, tree.ccm, tree.mem).status, 0);
    }
    const stub = path.join(tree.ccm, "dist", "src", "context", "memory", "edgeclaw-memory-core");
    assert.equal(fs.lstatSync(stub).isSymbolicLink(), true, `${which}：空壳应被换成链接`);
    assert.equal(fs.existsSync(path.join(stub, "src", "i.ts")), false, `${which}：空壳内容应已消失`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
