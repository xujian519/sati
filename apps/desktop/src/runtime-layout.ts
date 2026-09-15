/**
 * 打包运行时的目录布局接线。
 *
 * 打包后的 Sati 不直接运行 `node_modules`：三份 bundle tar 解到 runtimeBaseDir
 * 下**互不相干的子目录**，还要在 runtimeBaseDir 上补一组符号链接，跨 bundle 的
 * ESM 相对导入才解析得到；Windows 上 bsdtar 归档时还会把 pnpm 的 vstore junction
 * 落成实目录，须按 `.pnpm/<name>@<version>` 重链回去。
 *
 * 这两件事原先以 `linkDirectory()` + `resolvePaths()` 内联块 + 私有方法
 * `reconstructPnpmLinks()` 的形式长在 `ServerManager` 里，只能经 Electron 起来
 * 才触达，因此零直测。此模块不 import `electron`，可被单测用合成树直接驱动。
 *
 * 注意**同源实现有三处**（本模块是运行时那份）：`scripts/lib/packaged-runtime.sh`
 * 的 `pd_runtime_stage_links`（L2/L3 验证）与 `scripts/verify-dmg.sh`（L1 验证）
 * 复用同一 shell 函数；`scripts/relink-pnpm-win.mjs`（Windows 安装器验证）与
 * `reconstructPnpmLinks()` 的一致性由 `tests/desktop/pnpm-vstore-relink-parity.spec.ts`
 * 锁定。改布局时四处都要看。
 */

import * as fsSync from "node:fs";
import * as path from "node:path";

/** 建目录链接；win32 用 junction（无需管理员权限），其余平台普通符号链接。 */
function linkDirectory(link: string, target: string): void {
  if (fsSync.existsSync(link) || !fsSync.existsSync(target)) return;
  if (process.platform === "win32") {
    fsSync.symlinkSync(target, link, "junction");
  } else {
    fsSync.symlinkSync(target, link);
  }
}

export type RuntimeLayoutInput = {
  /** 运行时根：三份 bundle 解包目录的 sibling，链接也建在这里。 */
  runtimeBaseDir: string;
  /** sati-main 解包目录（含 `dist/` 与 `node_modules/`）。 */
  satiMainDir: string;
  /** sati-memory-core 解包目录。 */
  satiMemoryDir: string;
};

/**
 * 在 runtimeBaseDir 下铺出运行时能解析的扁平布局（幂等）。
 *
 * 逐条链接的存在理由见各自注释——它们对应**四种不同的解析失败**，删任何一条
 * 都会让某一类导入在打包环境里挂掉，故不要按「看起来冗余」合并。
 */
export function stageRuntimeLayout(input: RuntimeLayoutInput): void {
  const { runtimeBaseDir, satiMainDir, satiMemoryDir } = input;

  // ui/server/ files import compiled JS via relative paths like
  // `../../dist/src/pilot/index.js`. From satiui/server/ that
  // resolves to <runtimeBaseDir>/dist/src/..., but the actual dist/
  // tree lives inside <runtimeBaseDir>/sati-main/dist/. A symlink
  // bridges the gap so all ESM resolve calls succeed at runtime.
  const distLink = path.join(runtimeBaseDir, "dist");
  const distTarget = path.join(satiMainDir, "dist");
  linkDirectory(distLink, distTarget);

  // edgeclaw-memory-core is a file: dependency in the repo's package.json.
  // The release tar excludes the top-level edgeclaw-memory-core/ (it has
  // its own bundle), which also strips the node_modules/ symlink.
  // Compiled code does `import ... from "edgeclaw-memory-core"` (bare
  // specifier), so Node must find it under sati-main/node_modules/.
  const memNodeModLink = path.join(satiMainDir, "node_modules", "edgeclaw-memory-core");
  linkDirectory(memNodeModLink, satiMemoryDir);

  // npm hoists shared deps (ws, express, etc.) into the root node_modules/
  // which ends up inside sati-main-bundle.tar, not satiui-bundle.tar.
  // ESM resolution walks up the directory tree looking for node_modules/ dirs.
  // A symlink at <runtimeBaseDir>/node_modules → sati-main/node_modules
  // lets the resolver find hoisted packages after exhausting satiui's own.
  const hoistedLink = path.join(runtimeBaseDir, "node_modules");
  const hoistedTarget = path.join(satiMainDir, "node_modules");
  linkDirectory(hoistedLink, hoistedTarget);

  // ui/server/ also imports `../../src/web/server/*.js` etc. In dev
  // mode tsx resolves .js → .ts; in packaged mode we need actual .js
  // files. Point src/ → sati-main/dist/src/ (compiled output).
  const srcLink = path.join(runtimeBaseDir, "src");
  const srcTarget = path.join(satiMainDir, "dist", "src");
  linkDirectory(srcLink, srcTarget);

  // satiui/server/routes/memory.js imports edgeclaw-memory-core
  // via `../../../src/context/memory/edgeclaw-memory-core/lib/index.js`.
  // The src/ symlink points to sati-main/dist/src/ (compiled TS),
  // which contains an empty edgeclaw-memory-core/src/ stub (no lib/).
  // Replace that stub with a symlink to the real extracted bundle.
  const memSrcLink = path.join(runtimeBaseDir, "src", "context", "memory", "edgeclaw-memory-core");
  if (fsSync.existsSync(memSrcLink) && !fsSync.lstatSync(memSrcLink).isSymbolicLink()) {
    fsSync.rmSync(memSrcLink, { recursive: true });
  }
  linkDirectory(memSrcLink, satiMemoryDir);
}

/**
 * Re-links real package dirs inside an extracted pnpm node_modules tree back to
 * their canonical `.pnpm/<name>@<version>/node_modules/<name>` vstore locations
 * so Node's ESM resolver can reach isolated transitive deps on Windows (where
 * bsdtar materialized the junctions). Version is matched from each package's
 * package.json, preserving pnpm's version isolation. Idempotent and safe on any
 * platform: already-linked entries are skipped.
 *
 * 两个刻意的**弱化**行为，不要顺手改成「报错退出」：
 *   - 单候选回退：vstore 只有一个同名条目时，即使版本对不上也用它（打包树里
 *     同名包被去重到单一版本是常态，严格匹配会漏链）；
 *   - 全 best-effort：`tryLink` 内任何异常都吞掉，锁住/只读的目录保持实目录形态
 *     （解包产物可能落在只读卷上，强硬失败会让启动整体挂掉）。
 */
export function reconstructPnpmLinks(satiMainDir: string, extraRoots: string[]): void {
  const pnpmDir = path.join(satiMainDir, "node_modules", ".pnpm");
  if (!fsSync.existsSync(pnpmDir)) return; // not a pnpm virtual-store layout

  const encode = (name: string): string => (name.startsWith("@") ? name.replace("/", "+") : name);

  const versionOf = (dir: string): string | null => {
    try {
      const pkg = JSON.parse(fsSync.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string };
      return pkg.version ?? null;
    } catch {
      return null;
    }
  };

  const tryLink = (pkgDir: string, name: string): void => {
    let st: fsSync.Stats;
    try {
      st = fsSync.lstatSync(pkgDir);
    } catch {
      return;
    }
    if (st.isSymbolicLink() || st.isFile()) return;
    const ver = versionOf(pkgDir);
    if (!ver) return;

    let candidates: string[];
    try {
      candidates = fsSync.readdirSync(pnpmDir).filter(d => d.startsWith(`${encode(name)}@`));
    } catch {
      return;
    }
    if (candidates.length === 0) return;
    const pick =
      candidates.find(c => c === `${encode(name)}@${ver}`) ?? (candidates.length === 1 ? candidates[0] : null);
    if (!pick) return;

    const target = path.join(pnpmDir, pick, "node_modules", name);
    if (!fsSync.existsSync(target)) return;
    if (path.resolve(target) === path.resolve(pkgDir)) return; // self-link
    try {
      fsSync.rmSync(pkgDir, { recursive: true, force: true });
      fsSync.symlinkSync(target, pkgDir, "junction");
    } catch {
      /* best-effort: locked/read-only dirs are left as real dirs */
    }
  };

  const processNodeModules = (nm: string): void => {
    let entries: string[];
    try {
      entries = fsSync.readdirSync(nm);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === ".pnpm" || e === ".bin") continue;
      const p = path.join(nm, e);
      let st: fsSync.Stats;
      try {
        st = fsSync.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (e.startsWith("@")) {
        let scopeEntries: string[];
        try {
          scopeEntries = fsSync.readdirSync(p);
        } catch {
          continue;
        }
        for (const child of scopeEntries) {
          const cp = path.join(p, child);
          let cst: fsSync.Stats;
          try {
            cst = fsSync.lstatSync(cp);
          } catch {
            continue;
          }
          if (!cst.isSymbolicLink() && cst.isDirectory()) tryLink(cp, `${e}/${child}`);
        }
      } else if (st.isDirectory()) {
        tryLink(p, e);
      }
    }
  };

  // Collect every node_modules/ dir in the tree, including inside the vstore.
  const found = new Set<string>();
  const dirs: string[] = [path.join(satiMainDir, "node_modules"), ...extraRoots.map(r => path.join(r, "node_modules"))];
  let pnpmPkgs: string[];
  try {
    pnpmPkgs = fsSync.readdirSync(pnpmDir);
  } catch {
    pnpmPkgs = [];
  }
  for (const pkg of pnpmPkgs) {
    const inner = path.join(pnpmDir, pkg, "node_modules");
    if (fsSync.existsSync(inner)) dirs.push(inner);
  }
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (!d || found.has(d)) continue;
    found.add(d);
    let entries: string[];
    try {
      entries = fsSync.readdirSync(d);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e === ".pnpm" || e === ".bin") continue;
      const p = path.join(d, e);
      let st: fsSync.Stats;
      try {
        st = fsSync.lstatSync(p);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const inner = path.join(p, "node_modules");
      if (fsSync.existsSync(inner)) dirs.push(inner);
    }
  }
  for (const d of found) processNodeModules(d);
}
