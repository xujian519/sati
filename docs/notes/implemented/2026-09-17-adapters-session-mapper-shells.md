# Agent Note: 渠道 SessionMapper 薄壳删除与接线判据

Status: implemented

## Problem

`src/adapters/channel/*/` 下 13 个渠道（`bluebubbles`/`dingtalk`/`discord`/`email`/`homeassistant`/
`matrix`/`mattermost`/`signal`/`slack`/`sms`/`telegram`/`webhook`/`whatsapp`）各有一个
`<X>SessionMapper.ts`。把类名、渠道名字符串与文件头文档行归一化后，**13 份文件逐字相同**
（同一 shasum），每份 10 行，内容等价于：

```ts
export class SlackSessionMapper extends ChatSessionMapper {
  constructor(state?: SlackSessionMapperState, uuid?: () => string) {
    super("slack", state, uuid);
  }
}
```

行为早已全部落在 `protocol/ChatSessionMapper.ts`（2026-09-11，issue #149）——薄壳**没有任何自有
成员**，唯一信息是那个渠道键字面量。代价有三：新增渠道要照抄一个文件（模板化扩散）；「哪些文件是
真实现、哪些是壳子」必须逐个打开才能分辨；13 个「看起来很具体」的类名会被读成 13 套不同语义。

当时的决策记录（`2026-09-11-adapters-skill-split.md`）把「删除 13 个文件、各渠道直接
`new ChatSessionMapper("xxx")`」列为落选备选，理由是「会改动 13 个 `Channel` 的类型注解与 import
（爆炸半径更大）且丢失『每渠道一个可引用的类名』这一既有 API 面」。本变更推翻了这条理由。

## Decision

13 个薄壳文件删除，渠道直接构造共享实现；并把「渠道键 → 会话命名空间」这条接线做成可执行判据。

1. **删除 13 个 `<X>SessionMapper.ts`**。渠道侧 4 处逐行替换（import / `options.mapper` 注解 /
   私有字段注解 / 构造），13 个文件的**行数一字不变**（每文件 4 增 4 删），因此
   `docs/event-producer-consumer.md` 的 `file:line` 锚点不位移。
2. **删掉 `src/adapters/index.ts` 里 13 条类导出 + 13 条 State 别名导出**（共 26 条，见下「证据」）。
   保留 `feishu`/`weixin`/`qq`/`wecom`/`wecom-callback`/`api-server` 六个**真实现**的导出面
   （它们有各自扩展的 State 与 `resolve` 语义，是本议题之外的既有实现）。
3. **新增 `tests/adapters/channel-session-mapper.spec.ts`**（18 条 = 1 条集合护栏 + 13 条接线 + 4 条
   共享实现语义）：13 条接线用例断言每个渠道默认 mapper 的会话命名空间 == 该渠道自身的
   `channelKey`，且 `resolve()` 产出的键确实是 `<命名空间>:chat=<id>:…`（空态 `:general` 与
   `/new` 的 `:s_<uuid>` 两种形态）；4 条语义用例覆盖 `/new` 建会话并复用、`/new` 后正文回传、
   状态按实例隔离、`snapshot` 是副本。**接线是本次唯一新增的失败模式**——契约从「具名类」变成
   「一个字符串字面量」，写错不会有任何编译期信号。
4. **推导式（`new ChatSessionMapper(this.channelKey)`）不采用**，渠道侧保留字面量：见
   Alternatives 第四条。字面量与 `channelKey` 的一致由上述判据钉住。

**证据（#149 那条理由为何不成立）**：

| # | 论断 | 核码结论 |
|---|---|---|
| 1 | 「丢失每渠道一个可引用的类名」 | 13 个类名 + 13 个 State 别名从 `src/adapters/index.ts` 导出，**全仓零消费者**（`grep` 仅命中各自定义文件与 barrel 自身）；`package.json` 为 `"private": true`，不存在仓外消费者 |
| 2 | 「13 个 `Channel` 的类型注解与 import 会变，爆炸半径更大」 | 那 13 个文件**本来就要改**（构造点 `new XxxSessionMapper()` 无论如何都得换成工厂/共享类）；实际多出的改动只有 1 行注解 `mapper?: XxxSessionMapper` → `mapper?: ChatSessionMapper`，而两者**结构同一**（薄壳不增加成员） |
| 3 | 「State 类型导出面」 | `XxxSessionMapperState` 只出现在自己的文件里（定义 + 构造签名）与 barrel，仓内零外部引用 |

## Alternatives considered

- **工厂函数（`createSessionMapper("slack")`）+ 13 个一行导出**（issue #351 正文的建议方向）—
  落选：一个**只被常量字符串调用**的工厂不产生任何行为，多出来的只是一层间接 + 每渠道仍需一个
  维护文件；而 issue 想要消掉的正是「13 个文件」这件事本身。若真需要「每渠道一个可引用名」，
  正确形态是保留类名（现状）而不是把它换成函数——本仓两个方向都不需要（见证据表）。
- **保留 13 个薄壳不动（#149 现状）** — 落选：理由经核不成立（见证据表 1–3）。这里推翻的是
  #149 的**这条推论**，不是它的主决策：mapper 实现共享化本身继续有效，本 note 里删除薄壳正是
  它的最后一步。
- **把 13 个类集中到 `protocol/channelSessionMappers.ts` 一个文件（保住类名与 `new X()` 语法）**—
  落选：保住的是零消费者的名字；换来的是一个「13 个近同构类」的集中文件，且新增渠道仍要记得去
  那里补一条。它没有触及根因（「加一个渠道就得改 N 处」），只是在同一个地方复制。
- **渠道键改为从 `this.channelKey` 派生（消除字面量）** — 落选：会把「会话命名空间」与
  「网关路由词表」（`GatewayChannelKey`）耦成同一个事实源。会话键会落进渠道状态文件
  （`activeByChatId`）并据此恢复，改名 `channelKey` 就**静默改掉**已落盘的键前缀 ⇒ 用户既有
  会话绑定失效。保留字面量 + 用判据钉住两侧一致，是「可观测的失败」优于「结构上的耦合」。
- **不加测试（「只是删文件」，纯删除无需新判据）** — 落选：删除本身确实等价，但渠道 → mapper 的
  绑定**从具名类降级为字符串**，这是本次唯一新增的失败模式且无编译期保护；13 个渠道此前对这条
  接线**零覆盖**（迁到共享实现时同样没补）。
- **顺带把 factory/注册表推进到 `loadEnabledChannels` 的渠道注册表（TD-ADAPTERS-N10）** —
  落选：不同轴（那是「启动清单未覆盖全部渠道」），且要动 15 个 loader 的注册形态，与本次
  「删无信息量的壳」不同源。

## Consequences

- 13 个文件（130 行）与 26 条死导出消失；新增渠道不再需要任何 mapper 文件——在渠道自身写
  `new ChatSessionMapper("<渠道键>")` 即可，`channelKey` 字面量在渠道文件里只有一处。
- 会话键前缀与变更前**逐字相同**（判据表里 13 个命名空间即登记值），因此已落盘的
  `activeByChatId` 与进行中的会话不受影响。
- 渠道 → mapper 的接线获得首个判据（13 条 + 1 条集合护栏），共享实现获得首个直测（4 条）。这条判据同时覆盖
  「渠道之间共享 mapper 状态」（负控制 M5）：若状态退化为模块级共享，第一个之后的渠道会在空态
  断言上立刻红——这正是薄壳时代被「每渠道一个类」意外掩盖的性质。
- 明确的**未做**：不引入工厂/注册表/别名映射；不改动 6 个真实现 mapper；不做
  `mapper?: XxxSessionMapper` 的类型别名兼容层（那会立即把刚删掉的名字造回来）。

### 负控制（变异 → 红名单 → 是否命中）

每条变异单独注入、单独跑目标 spec、跑完一律从备份 `cp` 还原（不用 `git checkout --`，避免抹掉
本轮未提交改动）。「相邻用例仍绿」一列用于确认判据有区分度，而不是「一并崩」。

| 变异 | 注入点 | 预期转红 | 实测 | 相邻用例仍绿 |
|---|---|---|---|---|
| M1 | slack 的 mapper 键 → `"slack_2"` | slack 1 条 | ✅ 1 条（slack） | 其余 12 条接线绿 |
| M2 | discord 的 `channelKey` → `"discord2"` | discord 1 条 | ✅ 1 条（discord） | 其余 12 条接线绿 |
| M3 | slack ↔ telegram 键对调 | slack + telegram 2 条 | ✅ 2 条 | 其余 11 条接线绿 |
| M4 | 删掉共享实现 `/new` 分支的记录行 | 复用/隔离/snapshot 3 条 | ✅ 3 条 | 13 条接线 + guard + 「`/new` 后正文」绿 |
| M5 | 状态默认值改成模块级共享对象 | 12 条接线 + 隔离 1 条 | ✅ 13 条 | 首个渠道（bluebubbles，状态尚空）+ guard 绿 |
| M6 | `snapshot()` 直接返回内部状态 | snapshot 1 条 | ✅ 1 条 | 其余 17 条绿 |

M5 的「12 而非常 13」是**预期内**的：首个用例跑时共享状态仍为空，故其空态断言恰好成立；这与
「共享状态会让后跑到的渠道读到前一个渠道的会话」这一事实一致。

三条操作性教训（首轮踩到、已计入结论）：

1. **注入必须串行**。首次把 M2/M3 并行发到同一工作树，两趟都看到两处变异、各报同样的 3 条红——
   红名单与预测不符时先怀疑注入环境，别怀疑判据。
2. **驱动器参数不能拼 shell 字符串**：末尾多一个 `|` 会让它粘进替换串（`replace|`）⇒ 语法错误，
   整份 spec 退化成「文件名」那一条红。多行替换要用真实换行。
3. **注入后必须确认变异真的生效**：上面那两次「整份 spec 崩」是靠 esbuild 的
   `TransformError` 暴露的；若错误被静默吞掉，会得到「判据没红」的假结论。
