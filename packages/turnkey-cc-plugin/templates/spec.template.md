# Spec — ticket `<ticket_id>`

> 由 turnkey-spec skill 生成。仅在 design 阶段 junior 选了 "spec-driven" 时才有此文件。

## 1. 范围

被本 spec 约束的接口 / 模块 / 文件：
- `<file:symbol>`
- `<file:symbol>`

不在本 spec 范围内的（明确 non-goal）：
- …

## 2. 接口契约

对每个 public 函数 / endpoint / CLI 命令：

### 2.1 `<name>`

- 签名：
  ```
  <type signature>
  ```
- 参数语义：
  - param 1: type, required/optional, default, validation rules
  - …
- 返回值：
  - success shape: …
  - failure shape: …
- 错误码 / 错误形式：
  | code | trigger | recovery hint |
  |------|---------|---------------|
  | E_… | … | … |
- 副作用：
  - 写哪些状态 / 文件 / DB / external service
  - 是否幂等
- 性能 / 容量约束（如果 design 说要管）：
  - p50 / p99：
  - max payload：

### 2.2 `<name>`
…

## 3. 状态机（如适用）

```
state A --(event)--> state B
state B --(event)--> state C
…
```

非法转移：
- A → C 直接跳：illegal，必须经过 B

## 4. 数据模型变更

| table/file/key | before | after | migration script |
|-|-|-|-|

## 5. 与现有约定的对齐

- 命名约定：跟 onboard 阶段抓的 convention 对齐 / 如果偏离，说明 why
- 错误处理：跟现有 errors module 一致 / 如果新增错误类型，说明
- log / metric：跟现有 telemetry 风格一致

## 6. spec 自检 (agent 已跑)

- ☐ 没有"未定义"的 behavior（每个分支都有 explicit fallback）
- ☐ 错误码集合 closed（不会出现"unknown error"）
- ☐ 接口能被现有 caller 平滑替换（兼容性 / breaking change 显式标注）
- ☐ 可测——每个接口 / 状态转移都有可写的 test

## 7. 验证清单（给 develop / test 阶段）

- [ ] interface 1 happy path
- [ ] interface 1 each error code at least once
- [ ] interface 1 边界值
- [ ] state machine 每条转移
- [ ] data migration round-trip

## 8. spec 决策记录（junior confirm 过的）

- 决策 1: …（junior signed off）
- 决策 2: …（junior signed off）
