# PR Self-Review Checklist — turnkey-review 用

> 这是机器自审 checklist，turnkey-review skill 逐条跑、每条标 ✅/⚠️/❌ 并附 evidence。
> **不替代** senior review（NG-03）；目标是减少 senior 要喷的点。

## 1. Diff health

- [ ] diff 行数 ≤ ±500 / file 数 ≤ 20（超出 → warn 并提示拆 PR）
- [ ] 没有 secret/token/password keyword 命中
- [ ] 没有 debug 残留：`console.log` / `print(` / `debugger;` / `binding.pry` / `dbg!`
- [ ] 没有新增的 TODO/FIXME（warn 不阻塞）
- [ ] 改动文件都在 design doc §1 范围内
- [ ] 没有改 `.env*` / 密钥文件 / CI 凭据

## 2. 与 design / spec 一致性

- [ ] design doc Option `<X>` 的所有改动点都在 diff
- [ ] spec §2 每个接口签名跟实际代码一致
- [ ] 没有"design 没说但改了"的 scope creep（如有，列入 PR 的 deferred 段）

## 3. Convention compliance

- [ ] commit message 符合 onboard 抓的 convention
- [ ] 测试文件命名 / 位置符合 convention
- [ ] lint / format pass（cross-check turnkey-test 阶段）

## 4. Test coverage（cross-check 06-test-report）

- [ ] block-ship coverage gaps 都已补
- [ ] nice-to-have deferred 列表会在 PR description 中 explicit
- [ ] CI 模拟全部 ✅ / ⚠️ pre-existing only / 没有 ❌ new

## 5. Trust-blindness final check

- [ ] develop §trust-check 中所有 low confidence 的 step 已二次校验
- [ ] 第三方 API / 库的实际返回值已 confirm（不依赖 type sig 单独的 hallucination）
- [ ] 关键路径已 grep cross-reference 现有同类用法

## 6. Senior async review（如适用）

- [ ] senior 已回复 + ✅ → 继续
- [ ] senior 已回复 + ⚠️ concern → STOP，记 blocker，回退
- [ ] senior ≥24h 未回 → AskUserQuestion 让 junior 决定继续 / 等

## 7. PR description 完整性

- [ ] What / Why / How 都有
- [ ] Test plan 列出
- [ ] Risks & rollback 列出
- [ ] Deferred / non-goals 明示
- [ ] senior async review 状态明示
- [ ] files changed 高层分组

## 8. 安全 / 合规

- [ ] 没有 license 不兼容的依赖新增
- [ ] 没有不该 commit 的 binary（图片 < 1 MB / 视频 / archive 触发 warn）
- [ ] 不修改受保护文件（如 `.github/CODEOWNERS` / `LICENSE` 等，需显式 confirm）
