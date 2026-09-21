# Agent Note: rdkit 2026.3.6 适配与 univer 全家桶同版升级

Status: implemented

## Problem

dependabot 2026-09-21 周更开出的两个「真实升级」，都无法靠逐包自动升完成：

**`@rdkit/rdkit` 2025.3.4-1.0.0 → 2026.3.6 是一次双重破坏性变更，其中一半是静默的。**

- **类型面**：包内声明从 `dist/index.d.ts` 换成 `dist/RDKit_minimal.d.ts`，具名导出改名 ——
  分子接口 `JSMol` → `Mol`，模块接口 `RDKitModule` → `MainModule`，加载器改由 default
  export `MainModuleFactory` 承载。`src/patent/chemistry/smiles.ts` 直接 typecheck 失败
  （`TS2724` / `TS2614`）。
- **运行时面（更危险）**：新版新增 `exports` 映射，**只暴露 `"."` 与 `"./RDKit_minimal.wasm"`**，
  而代码写的是深路径 `require.resolve("@rdkit/rdkit/dist/RDKit_minimal.js")` ⇒ 抛
  `ERR_PACKAGE_PATH_NOT_EXPORTED`。该异常落进 `loadRdkitModule()` 的 catch，被归一为
  「RDKit 不可用」⇒ **SMILES 结构校验静默降级为语法正则预检**，只留一条 warn。

  两版**运行时导出形态本身没变**（尾部逐字相同：`module.exports = initRDKitModule;
  module.exports.default = initRDKitModule;`），所以「只把类型改名改对」的实现能过
  typecheck 却仍把 WASM 校验整个关掉 —— 这半边的破坏**不会由类型系统报出**。

  ```
  FAIL  @rdkit/rdkit/dist/RDKit_minimal.js → ERR_PACKAGE_PATH_NOT_EXPORTED
  OK    @rdkit/rdkit                        → …/dist/RDKit_minimal.js
  OK    @rdkit/rdkit/RDKit_minimal.wasm     → …/dist/RDKit_minimal.wasm
  ```

**`@univerjs/*` 必须整组同版。** `ui/package.json` 里 13 个包全部锁死 `0.25.1`，
其类型通过跨包 **interface augmentation** 合并。`#482`（`@univerjs/core`）与
`#486`（`@univerjs/sheets-ui`）各只升一个包 ⇒ 混版树 ⇒ `FUniver` / `FWorksheet` /
`FEventName` 上的接口互相看不见，一次爆 10+ 个 TS2339/TS2345。

> 载体：issue #492。

## Decision

1. **rdkit 升到 `2026.3.6`，改两处**：
   - 类型名迁移（5 处引用）：`JSMol` → `Mol`、`RDKitModule` → `MainModule`
     （`import type`、`RDKitLoader`、`modulePromise`、`loadRdkitModule` 返回值、`mol` 局部变量）。
   - **`require.resolve("@rdkit/rdkit")` 改用包根**，不再写深路径 `dist/RDKit_minimal.js`，
     让解析交给 `main` / `exports["."]`；glue 与 wasm 同目录，`path.dirname` 的用法不变。
     注释里写明**为什么**（深路径抛错会被 catch 吞成静默降级），防止后人为了「更明确」
     又把深路径写回来。
2. **univer 13 个包整体升到 `0.25.2`**（`ui/package.json` 全等 pin 一起动），
   并已在 `.github/dependabot.yml` 加 `groups: univerjs` 阻止再次逐包开单。
3. **行为等价性按产物断言，不按「测试没红」断言**：`tests/patent/chemistry/smiles.spec.ts`
   断言的是**精确**规范化产物（`CC(=O)Oc1ccccc1C(=O)O`）、精确分子式（`C9H8O4`）、
   InChI 前缀与 InChIKey 非空 —— 9/9 通过即新旧 wasm 在这条路径上产物一致。
   头部注释里「MinimalLib 未暴露 `get_canonical_smiles` / `get_molecular_formula`」这条
   G7 结论已按 2026.3.6 的 d.ts **复核仍成立**，故只补版本注记，不改判定逻辑。
4. **univer 的「0.25.2 有无真实破坏」用实测回答**：13 包同版后 `ui` 的 `tsc --noEmit`
   零错误、`vitest run` 976/976 通过 ⇒ `#482`/`#486` 的红是**纯混版假阳性**，
   分组配置即为充分修复（该结论同时回填进 issue #491 的决策记录）。

## Alternatives considered

- **只改类型名、不动 `require.resolve` 路径** — 落选：typecheck 会变绿，
  但 WASM 校验实际已被静默关掉（`isRdkitAvailable()` 返回 false），
  属于「绿着坏」。这正是本次最容易被漏掉的一半。
- **rdkit 改用 `require.resolve("@rdkit/rdkit/RDKit_minimal.wasm")` 取 wasm、
  包根取 glue** — 落选：两条路径都要解析，反而比「包根 + `path.dirname`」多一个假设
  （wasm 与 glue 必须同目录这一点本来由 `path.join(dirname(glue))` 表达得更直接）。
- **把 rdkit 加进 dependabot `ignore`，不升级** — 落选：不升级并不能消除问题
  （深路径写法对旧版的依赖是隐性的），且 `2026.3.6` 承载上游实现改进；
  真正该留下的是「升级时要同时核 `exports` 映射」这条知识，而不是永久冻结版本。
- **univer 保持 0.25.1、只加 `groups` 未来防呆** — 落选：`0.25.2` 修的是
  drawing/formula maps 的原型污染（安全修复），且实测同版升级零代价，没有理由不取。
- **把 13 个 univer 包改成 `^0.25.1` 浮动** — 落选：那样 pnpm 可能解析出混版树而
  无人能预测，恰好是要避免的形态；全等 pin + 整组升级才是可控的。
- **为 rdkit 的 exports 破坏单独写一个 judge 用例** — 落选：
  `smiles.spec.ts` 的「RDKit WASM 真实加载可用」已经覆盖（本次就是它转红抓到的），
  再加一条只是重复。

## Consequences

- SMILES 校验恢复真实 WASM 路径；此前它已在降级态运行而无人察觉（降级本身 fail-open，
  但**触发原因**是依赖兼容性破坏，不会被显式归因）。
- rdkit 的类型面与运行时面从此对齐在同一版本上；升级 rdkit 大版本时需**同时**核
  「导出名」与「`exports` 映射」，这条已写进 `smiles.ts` 头注。
- univer 升级只能整组落地；代价是若某次只有部分包能升需人工介入 —— 而这正是期望行为。
- `src/patent/chemistry/smiles.ts` 行数增加（头注记录 2026.3.6 两处变更），
  故同 PR 刷新 `docs/technical-debt/metrics.md` 基线。
