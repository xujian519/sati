# Agent Note: 领域输入声明表改为显式懒取（getInputDeclarations）

Status: implemented

## Problem

`DOMAIN_INPUT_DECLARATIONS` 是一个带四个 getter 的模块级对象，用来绕开「domains 各文件 ↔ graph barrel」的循环 import：顶层对象会在模块初始化时求值四个声明表，触碰 TDZ。getter 能工作，但把契约藏了起来——读代码的人看到的是一个普通记录，实际每次属性访问都在执行 getter；原因只写在注释里。消费方 `DOMAIN_INPUT_DECLARATIONS[graph][node]` 也看起来像静态数据，下一次「简化」成字面量对象就会在 import 期失败，且报错位置离改动很远。

## Decision

- `src/patent/graph/domains/index.ts` 改为导出 `getInputDeclarations(graphName: DomainGraphName)`，函数内部用 switch 按图名返回对应子图的声明表。延迟求值发生在调用时，那时各模块已完整加载。
- 未知图名由 `DomainGraphName` 在编译期挡住；运行期防御性返回 `undefined`，消费方用 `?? []`。
- 更新 re-export（`src/patent/graph/index.ts`、`src/patent/index.ts`）与唯一消费方 `src/tool/builtin/patent-workflow-run/graphRun.ts`。
- 在 `tests/patent/graph/domains.spec.ts` 增加断言：四图均可取、返回值与各子图声明表**同一引用**（不是拷贝）、未知图名返回 `undefined`、表内每项为字符串数组。

## Alternatives considered

- **保留 getter 对象，只补注释** — 正是要修的形态：读代码的人必须知道 getter 技巧才能理解求值时机，而把对象「简化」成字面量会在 import 期崩，报错点离改动很远。显式函数把延迟求值变成看得见的契约。
- **改成一个 import 完成后构建的顶层常量** — 在现有循环 import 下做不到：引用 barrel 的模块正是定义这些常量的模块。彻底消除环需要把声明表下沉到叶子模块，属于更大的 import 图重构，会波及图构建行为，超出本次卫生项。
- **用动态 `import()` 异步取表** — 给同步的图构建路径引入 `await`，API 形状变化大，且这里的问题是模块初始化顺序，不是加载时机。
- **未知图名抛错 fail-loud** — 类型层已经挡住；运行期抛错会把 JS 调用方的误用变成溯源钩子内的崩溃，而该钩子整体设计为 fail-open。返回 `undefined` 让调用方自行决定 `?? []` 或记录缺口。
- **把整张记录传给 `wrapNode`** — 消费方只需要单个节点的声明键；按图返回表可以保持调用形状不变。

## Consequences

- 行为中性：`wrapNode` 对 `undefined` 与 `[]` 的处理一致（都先过滤到已写入的快照键），溯源输出不变；相关 11 条 provenance 测试保持绿。
- 循环 import 仍在，本次只把「延迟求值」从隐式 getter 变成显式函数；彻底拆环另做。
- `DOMAIN_INPUT_DECLARATIONS` 公共导出被移除。仓库内无其他消费者；它是专利图内部 API，未进入插件契约。
- 测试用引用相等锁定「同源」，未来若复制一份声明表会被立即发现。
