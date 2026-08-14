# Windows 桌面端打包提速与质量修复计划

> 状态：分析完成，实施完成，端到端验证中。所有数据均来自本机
> （Windows 11, i5-13500H）实测，时间 2026-08-14，对应仓库 0.0.27。

## 一、根因结论（按可量化影响排序）

打包流水线 `apps/desktop/scripts/build-win.bat` 共 11 步。实测发现三个真实卡点，
外加两个"看起来慢"但已证伪的假设。

### 卡点 1（最大）：bundle tar 内 44% 是 junction 物化重复数据

- 运行时架构：安装包内置 `sati-main-bundle.tar`（root `node_modules` + `src` + `dist/src`），
  首启由 `server-manager.ts` 解压。Windows 的 bsdtar **跟随目录 junction**（pnpm 的
  vstore 全部是 junction），归档时把 `node_modules/.pnpm/node_modules/`（hoist 根，866 个
  junction）**逐目录物化成真实拷贝**，与 `.pnpm/<pkg>@<ver>/node_modules/<pkg>` 的
  正本重复。
- 实测现有产物 `sati-main-bundle.tar`：**1.452GB / 177,219 条目**，其中
  **638.6MB / 59,919 条目**（44%）是 `.pnpm/node_modules` 物化副本。
- 连带效应：electron-builder NSIS 要对这 1.45GB 做 7z 压缩（还有 265MB satiui tar、
  110MB bun、83MB node），win-unpacked 2.2GB → 压缩是流水线最长单步（10-30 分钟量级）；
  安装包 418MB、首启解压慢、占用 2.2GB 磁盘，全部被这个重复放大。
- 现有排除清单（`echarts*`、`@univerjs*`、`@biomejs*` 等 30+ 条）**只排除 vstore 正本，
  同一批包仍从 hoist 根漏进来**——排除清单在跟 junction 物化"打地鼠"。

**修复**：tar 增加一条 `--exclude=node_modules/.pnpm/node_modules`，一次消除全部重复。
- 实测（完整排除清单 + 该条）：tar **745MB / 117,337 条目**（vs 现有 1.452GB /
  177,219 条目；−49% 体积，−34% 条目）。tar 创建耗时：热缓存 + 单并发实测 ~9s
  （此前两次并行打 tar ~7.4 分钟，含 AV/磁盘竞争）。
- 安全性：hoist 根 866 个包中仅 18 个在 vstore 无正本，且全部是 dev/browser 工具
  （biomejs、electron-builder、univerjs、radix、lucide-react、eslint-plugin-* 等），
  运行时不依赖；`server-manager.ts` 的 `reconstructPnpmLinks()` 本就按 vstore 重建
  顶层 junction。去重 tar 内 sharp 的 vstore 依赖（detect-libc）、better-sqlite3/
  node-pty 预编译产物、mupdf 均验证在位。L1/L2 冒烟兜底验证。
- satiui tar 同样加该排除（当前 ui 的 .pnpm 是到根 store 的 junction、bsdtar 不跟随，
  实为 no-op 守卫；若布局变化即生效）。

### 卡点 2：step 4b native 依赖重建是纯浪费（5-15 分钟）

- `pnpm install --ignore-scripts` 跳过 postinstall 后，脚本用 bundled node 逐个
  `npm rebuild better-sqlite3 sharp node-pty mupdf`——Windows 上触发 node-gyp/MSVC
  编译（无 MSVC 时静默失败降级）。
- 实测：**四个模块在 bundled node v22.23.2 下全部用官方自带预编译产物正常加载**：
  - better-sqlite3@13.0.2：包内 `prebuilds/win32-x64.node`，FTS5 虚拟表 + MATCH 通过
  - node-pty@1.1.0：包内 `prebuilds/win32-x64/pty.node`，spawn OK
  - sharp@0.35.3：二进制在 optionalDep `@img/sharp-win32-x64`，PNG 渲染 OK
  - mupdf@1.28.0：纯 WASM（`dist/*.wasm`），dynamic import OK
- 结论：**删除 step 4b**，替换为 1 秒 preflight（bundled node 加载四模块，fail-fast）。

### 卡点 3：electron-builder NSIS 输入过大

- win-unpacked 2.2GB，NSIS 7z 单步 10-30 分钟。卡点 1 修复后输入 −700MB，
  该步时间与安装包体积（418MB → 预计 280-320MB）同步下降。

### 已证伪的假设

- **root tsc 全量编译**：实测 `npx tsc -p tsconfig.json` 仅 **11.5s**，不是瓶颈。
  step 1 `pnpm test` 门禁的耗时主体是 280 个测试文件的测试运行，属发布门禁设计，
  保留。
- 二次 `pnpm install`（desktop 目录）：workspace 成员，root install 已覆盖，冗余
  但耗时不显著（保留改动，顺手删除）。

## 二、质量缺陷（同批修复）

| # | 缺陷 | 证据 | 修复 |
|---|---|---|---|
| Q1 | L1 冒烟 4c 的 `require('mupdf')` 结构性必败 | mupdf 是 ESM + top-level await，`require` 必抛 `ERR_REQUIRE_ASYNC_MODULE` → `NATIVE_OK` 永远 ≠4 → verify-installer.bat 永远 exit 1 | 改用 `node --input-type=module -e "await import('mupdf')"` |
| Q2 | publish-win.mjs 会发布遗留/过期 exe | 正则 `^Sati-.*-win-.*\.exe$` 匹配无架构后缀的遗留 `Sati-0.0.26-win.exe`（830MB，旧配置产物）及目录里残留的旧版本（0.0.24 仍在 dist-electron） | 严格按 `Sati-${version}-win-${arch}.exe` 收集；build-win.bat 构建前清理无架构后缀遗留产物 |
| Q3 | 安装包/磁盘占用过大 | 见卡点 1 | tar 去重 |
| Q4 | rebuild 静默失败降级（无 MSVC 时） | 现有 WARN 分支 | preflight fail-fast（better-sqlite3/sharp 硬失败，node-pty/mupdf 警告） |

## 三、实施清单（全部完成）

1. `build-win.bat`
   - step 4b → preflight 检查（`scripts/check-native-win.mjs`，bundled node 0.14s 验证 4 模块）
   - step 8：sati-main + satiui tar 增加 `--exclude=node_modules/.pnpm/node_modules`
   - step 11 前：清理无架构后缀遗留 + 旧版本 exe（含 blockmap）
   - step 3：删除 desktop 二次 install
   - 增加整体耗时统计；electron-builder 前设 CN 镜像默认值（npmmirror，可覆盖）
   - step 0 前切到仓库根（消除 cwd 依赖）
2. `electron-builder.yml`：win.target 移除 `arch: [x64, arm64]`——v26 会把 CLI `--x64` 并入
   配置列表，导致每次构建产出 3 个安装包（合并包 + 双架构）；CLI 旗标成为唯一权威后单次
   只产 1 个
3. `verify-installer.bat`：4c 全部重写（better-sqlite3/node-pty 从 satiui 树、sharp 从
   vstore、mupdf 用 ESM import）；FTS5/4c/5 段全部真执行——修复了**三处让检查从未运行
   的 bat 解析缺陷**：`(no bundled node)` 等括号提前闭合 if 块、`!` 触发延迟展开吞行、
   非 ASCII/非 CRLF 破坏解析；新增 `relink-pnpm-win.mjs`（运行时同款 pnpm vstore 重链，
   顶层+嵌套+工作区包）与 `gateway-smoke-win.mjs`（运行时同款接线 + 健康轮询 120s）
4. `publish-win.mjs`：严格按 `Sati-${version}-win-(x64|arm64).exe` 收集
5. `RELEASING.md`：更新 Windows 构建说明
6. 验证：preflight 实测全过；tar 745MB/117k 条目；L1 全绿 16/0/0；完整构建端到端计时

**附带的既有缺陷（本次暴露并修复）**：L1 的 4b/4c/5 段因 bat 解析缺陷从未执行过
（门禁长期假绿）；打包树缺少 pnpm vstore 嵌套重链导致 @google/genai→p-retry→retry
与 nuo-patent→cheerio→parse5 链在运行时不可解析（dev 树靠 junction 正常）——
`relink-pnpm-win.mjs` 与 `server-manager.ts` 同款逻辑修复。

## 四、验证计划

- tar：`--exclude=node_modules/.pnpm/node_modules` 后体积/条目/耗时对比（已完成，745MB）
- preflight：bundled node 加载 4 模块（已完成，全过）
- L1：修复后对现有 win-unpacked 提取物运行 4c 检查
- 端到端：完整 `build-win.bat` 计时（门禁保留），对比两次历史慢构建
- 冒烟：L1 + L2 对新产物跑通

## 五、实测结果（2026-08-14 本机）

| 项 | 修复前 | 修复后（实测） |
|---|---|---|
| sati-main-bundle.tar | 1.452GB / 177,219 条目 | **763.6MB** / 117k 条目（−47%） |
| win-unpacked | 2.2GB | **1.5GB** |
| x64 安装包 | 438MB（0.0.26） | **311MB**（0.0.27，−29%） |
| 安装包数量/次构建 | 3 个（合并 616MB + x64 + arm64） | **1 个**（311MB x64） |
| native 步骤 | 5-15 分钟（node-gyp/MSVC） | **0.14 秒**（preflight） |
| tar 步骤 | 分钟级（并行时实测 ~7.4 分钟） | 秒级（热缓存实测 8.7s；完整构建内含） |
| 完整构建（--skip-tests） | 估 40-90 分钟（两次慢构建） | **305 秒**（3 安装包版）；单包版见最终计时 |
| L1 门禁 | 4b/4c/5 段从未执行（假绿） | 全绿 16/0/0，含真实 FTS5/native/gateway |
| 首启解压 | ~30s+ | 随 payload −32% 同步缩短 |

**根因总表**（速度侧）：① tar 中 junction 物化重复（44%，638MB/6 万条目，单条排除修复）；
② native 依赖每次 node-gyp 重建（5-15 分钟，4 模块全自带预编译产物，preflight 替代）；
③ electron-builder 一次产出 3 个安装包（合并包 ~616MB 是"历史遗留 830MB"的真身；
yml 移除 arch 列表后单包）；④ GitHub 下载 10 分钟超时挂起（npmmirror 默认值兜底）。
