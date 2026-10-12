# Agent Note: vitest 5 升级——测试 setup 的 localStorage 垫片安装方式

Status: implemented

## Problem

`ui` 升到 vitest 5 后，**每个**测试文件都在 setup 阶段即失败：

```
TypeError: Cannot set property localStorage of [object Window] which has only a getter
 ❯ ../vitest.setup.ts:9
```

根因是 `vitest.setup.ts` 用**普通赋值**安装内存版 `localStorage` 垫片：

- vitest 4 下全局没有该属性 ⇒ 赋值即新建一个自有属性，正常；
- vitest 5 下 jsdom 的 Window 已经带了一个**只读 getter** `localStorage` ⇒ ESM 严格模式下赋值抛错。

这不是 jsdom 版本差异（`ui` 在两个 vitest 大版本下都是 jsdom 30），而是 vitest 暴露全局的方式变了：vitest 5 里 `globalThis` 就是 jsdom 的 Window 本身，于是它原有的只读访问器直接挡住了赋值。

## Decision

垫片的**实现与语义完全不变**（仍是同一份内存 Map，仍是逐文件新建），只把安装方式从普通赋值换成 `Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: … })`，从而：

- 属性不存在（vitest 4）⇒ 新建自有数据属性（与旧行为等价）；
- 属性是只读访问器（vitest 5）⇒ 以自有数据属性覆盖，不再触发 setter。

## Alternatives considered

- **只在环境缺失时垫片**（`if (typeof globalThis.localStorage === "undefined")`）—— 表面上更贴合原注释的语义（「jsdom 不提供时才补」），且能让 vitest 5 下的测试直接使用 jsdom 的真实 Storage。**实测否决**：7 个文件 22 个用例立刻转红。原因是这些用例的 spy 打在 `window.localStorage` 的**实例方法**上——见 `ui/src/components/chat/hooks/useChatComposerState.draft-debounce.test.ts` 的头注：「spy 必须打在 window.localStorage 实例方法上（jsdom 的 localStorage 是实例自持实现，Storage.prototype 上的 spy 捕获不到）」。换成 jsdom 的 Storage 后，`vi.spyOn(window.localStorage, "setItem")` 不再被被测代码路径命中，草稿落盘类断言一律变成「调用 0 次」。保持垫片即保持这些判据的接线点。
- **保留普通赋值 + try/catch 兜底**—— 捕获后仍要走 `defineProperty`，等价于本方案但多一条分支与一段实际不可达的代码。落选。
- **不升 vitest（关掉该 dependabot PR）**—— 放弃本轮 4→5 的修复，且同一批里还有 10 条同类依赖升级要处理，代价更大。落选。

## Consequences

- 两个 vitest 大版本共用同一份 setup，垫片的语义与既有断言（含实例级 spy）一字不变。
- `localStorage` 从此固定为 setup 安装的自有属性，不再依赖 jsdom/vitest 是否提供它——将来这一层再变也不会波及测试。
- 验证：`ui` 全量套件在 vitest 5.0.3 下 181 文件 / 1286 用例全绿。
