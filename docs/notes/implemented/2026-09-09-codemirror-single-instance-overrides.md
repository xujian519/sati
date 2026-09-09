# Agent Note: codemirror 依赖单实例钉版（修桌面端打开 md 文件崩溃）

Status: implemented

## Problem

桌面端 0.1.11（及 dev 环境）在 Files 工作台打开 `.md` 文件时整树崩溃，ErrorBoundary
显示 "Something went wrong / An error occurred while loading the chat interface"。
浏览器控制台真实错误为：

```
Error: Unrecognized extension value in extension set ([object Object]).
This sometimes happens because multiple instances of @codemirror/state are
loaded, breaking instanceof checks.
  at Configuration.resolve / EditorState.create / <CodeMirror>
```

即 CodeMirror `flatten()` 遍历 extension 集时用 `instanceof` 判定
StateEffect/StateField，而扩展对象与宿主编辑器来自两份不同的
`@codemirror/state` 实例，判定全部落空。

根因在依赖解析层：2026-09-07 重建 pnpm-lock.yaml 后，`@uiw/react-codemirror`
依赖的 `codemirror@6.0.2` 元包子树被重新解析到更新的版本组合
（`@codemirror/view@6.43.11` → `@codemirror/state@6.7.2`、
`@codemirror/commands@6.11.0`、`@codemirror/autocomplete@6.20.3`），
而 ui 直接依赖仍是 `@codemirror/state@6.7.1` / `@codemirror/view@6.43.8`。
pnpm 按版本各存一份，vite 构建把两份都打进了 bundle（源码层面只有
`@codemirror/state` 的 state/view 有跨实例 `instanceof` 问题）。

## Decision

在根 `package.json` 的 `pnpm.overrides` 中把 CodeMirror 核心包钉到 ui 直接
依赖声明的版本，强制全 workspace 单一实例：

- `@codemirror/state`: `6.7.1`
- `@codemirror/view`: `6.43.8`
- `@codemirror/commands`: `6.10.3`
- `@codemirror/autocomplete`: `6.20.2`

全部落在各依赖方的 semver 范围内（`^6.7.0` / `^6.0.0` / `^6.27.0`），
只是消除 lockfile 里的版本分裂。

## Alternatives considered

- **升级 ui 直接依赖到最新（state 6.7.2 / view 6.43.11 等）** — 同样能收敛单实例，
  但引入未验证的新 patch 行为（view 6.43.9/6.43.11 与 6.43.8 之间的渲染差异），
  且 overrides 锁"最新"在下次 lockfile 重建时仍需人工跟进；钉在 ui 声明版本上
  与 package.json 直接依赖保持一致，语义最直白。
- **`vite.config.js` `resolve.alias` 强制 `@codemirror/state` 指向单一路径** —
  只治 vite 构建层，node 侧（vitest、ssr 预览）仍可能拿到两份；且 alias 绕过
  pnpm 解析，升级直接依赖时易漏改。overrides 在包管理器层根治，所有消费方一致。
- **改代码绕开 `instanceof`（不用 `markdown()` 等官方扩展）** — 不可能根治：
  双实例是全局污染，view/language 之间同样有跨实例调用，只是先崩在 state。
- **构建后置脚本扫 bundle 查重复并 fail** — 作为门禁有价值，但属于附加保险
  而非修复；本次先以 overrides 根治，未引入额外脚本。

## Consequences

- 打开任意文件（含 md）编辑器正常渲染；md 预览、diff、minimap 等依赖扩展管线
  的特性一并恢复。
- lockfile 重建（如再次 repair）不会再把 codemirror 子树解析到新版本组合，
  overrides 优先于解析。
- 将来升级 `@codemirror/*` 直接依赖时需同步更新 overrides 四处版本号，
  否则安装期即报版本不满足。
