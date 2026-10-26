# Agent Note: `pnpm install` 不再为 better-sqlite3 触发 node-gyp 重建

Status: implemented

## Problem

锁文件变动导致 `better-sqlite3@13.0.3` 重链接时，`pnpm install` 会在没有 Windows SDK 的 Windows 开发机直接失败：

```
.../node_modules/better-sqlite3 install$ node-gyp rebuild
gyp ERR! find VS - found VC++ toolset: v143
gyp ERR! find VS - missing any Windows SDK
gyp ERR! configure error
gyp ERR! stack Error: Could not find any Visual Studio installation to use
 ELIFECYCLE  Command failed with exit code 1.
```

失败链三段：

1. `better-sqlite3` 的 npm 包不带 `install` 脚本，但带 `binding.gyp`；pnpm 经 `normalize-package-data` 据此**注入**隐式 `install: node-gyp rebuild`（npm 同款默认行为）。
2. `pnpm-workspace.yaml` 的 `allowBuilds` / `onlyBuiltDependencies` 把它列为允许构建 → 注入的脚本被执行。两者是并集：只从 legacy 列表删掉、保留 `allowBuilds: true` 时编译照跑（实测）。
3. 编译要求 MSVC + Windows SDK；只有 VS2022 BuildTools 的 v143 工具集而缺 SDK 时，gyp 在 configure 阶段失败，整个 install 退出码 1。

这次编译对该包没有任何收益：npm tarball 内已带 N-API 预编译产物 `prebuilds/{win32-x64,win32-arm64,darwin-*,linux-*,linuxmusl-*}.node`（绑定 Node-API 而非特定 ABI，FTS5 已编入），`apps/desktop/scripts/check-native-win.mjs` 早已写明「每次 node-gyp rebuild 是纯浪费」。CI 也逃不掉这一次：run 40253818317 的 install 步骤里 `better-sqlite3 install$ node-gyp rebuild` → `Done` 实测 5.4 秒（node 22.23.3 / linux x64），纯属白烧。

## Decision

- `pnpm-workspace.yaml`：`allowBuilds` 的 `better-sqlite3: true` → `false`，并从 legacy `onlyBuiltDependencies` 列表删除同名条目。
- `allowBuilds: false` 是 pnpm 10.32 的规范写法：`getOptionsFromPnpmSettings` 把 `false` 追加进 `ignoredBuiltDependencies`，因此**既不构建、也不再打印** 「Ignored build scripts」 警告。
- 运行时继续用 tarball 内的预编译产物；`node apps/desktop/scripts/check-native-win.mjs` 四项（better-sqlite3 / sharp / node-pty / mupdf）仍全 PASS，`pnpm install --frozen-lockfile` 为 `Already up to date` 且 exit 0。

## Alternatives considered

- **给 Windows 开发机补 Windows 11 SDK，让编译成功** — 只治一台机器的症状：每次重链接仍要编译一个本来就带预编译产物的模块，并把「Windows 开发必须装 MSVC + SDK」变成隐性前提，而本仓库的既定口径是预编译产物即支持路径。
- **`pnpm install --ignore-scripts`** — 会连带跳过真正需要的脚本（`node-pty` postinstall 复制 `conpty.dll`、`vendor/nuo-patent` 的 checksum 校验、根 `prepare`），损伤大于问题本身。
- **只从 `onlyBuiltDependencies` 删除，保留 `allowBuilds: true`** — 实测无效：`allowBuilds` 的 `true` 会反向合并进 `onlyBuiltDependencies`，编译照旧触发。
- **用 `neverBuiltDependencies` / `ignoredBuiltDependencies` 另开一条** — 与 `allowBuilds: false` 语义等价却多一处真相源；pnpm 自身迁移时也会把 legacy 列表折叠回 `allowBuilds`。
- **把 `npm_config_node_gyp` 指向 no-op 包装** — 会把真正需要编译的模块（`node-pty` 的 fallback、将来新增的 native 依赖）一起静默跳过，把显性失败换成隐性错误。

## Consequences

- 缺 SDK 的 Windows 上 `pnpm install` 恢复绿：重链接后 exit 0、无警告、包目录下不再生成 `build/`。
- CI 与此前等价（同样命中预编译产物），只是少了那次 5 秒的无用编译；`allowBuilds: false` 进了 `ignoredBuiltDependencies`，不会触发 `ERR_PNPM_IGNORED_BUILDS`。
- 若将来升到不发预编译产物的版本，或需要自定义编译开关，必须把该键改回 `true` 并显式提供 MSVC/SDK；`check-native-win.mjs` 会在加载阶段硬失败，不会静默降级。
- 无工具 `inputSchema`、事件面、磁盘格式变更，无需重录 llm-replay。
