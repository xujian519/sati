# Agent Note: PR 追溯门禁剥离「渲染后不可见内容」

Status: implemented

## Problem

`pr-traceability` 门禁（`.github/scripts/check-pr-issue.mjs`）是纯正则匹配，**不剥离 HTML 注释**。
而 `.github/PULL_REQUEST_TEMPLATE.md` 的 HTML 注释里**字面写着**填写提示：

```markdown
<!-- 可回溯来源（门禁会识别任一，见 check-pr-issue.mjs）：
     - 关联 issue：`Closes #123` / `Fixes #123` / `关联 Issue: #123`
     - 偿还技术债：写债编号 `TD-*-*`（见 docs/technical-debt/backlog.md）
     - 确无来源：声明「无关联 issue」 -->
```

于是**任何用仓库模板创建、却一个字都没填**的 PR 都无条件通过这道门禁（`LINK_KEYWORD`
命中注释里的 `Closes #123`，`EXEMPT` 命中注释里的「无关联 issue」）——门禁恒真，形同虚设。
它只在「手写 body 且完全不提任何 `#数字`」时才可能变红。

**为何能长期存活**：`.github/scripts/check-pr-issue.test.mjs` 的 10 个用例**没有一条使用
真实模板文本**，缺「模板原样 body 必须失败」的负控制。

顺带发现两处过宽的判定：

- `EXEMPT` 含裸 `n/a` → PR 模板「测试计划」表格里的 `N/A` 会命中；含裸 `no issue` →
  英文行文（"there is no issue with this approach"）会命中。

## Decision

1. `evaluatePrTraceability` 在四路判定**之前**先剥离「渲染后不可见」的片段（新增并导出
   `stripInvisible`）：已闭合的 `<!-- -->`，以及**未闭合的 `<!--` 到文末**。
   - 未闭合注释一并剥离的依据是 CommonMark：HTML block（type 2）从 `<!--` 延续到 `-->` 或
     **文档结束**——未闭合的注释同样不渲染，故与实际显示一致；这同时堵住「复制模板后误删
     `-->`」这条残余路径。
   - 理由：作者能读到、GitHub 却不渲染的内容不构成可追溯来源。
2. 收紧 `EXEMPT` 为**完整声明**：`无关联 issue` / `no|without (associated|linked|related) issue` /
   `skip-issue-check`。移除裸 `n/a` 与裸 `no issue`。
3. `BARE_NUMBER`（裸 `#123`）**保留不动**——见下方 Alternatives。
4. 测试补 6 条负控制，其中**「模板原样 body 必须失败」直接读取真实模板文件**
   （`new URL("../PULL_REQUEST_TEMPLATE.md", import.meta.url)`），模板日后若改回能被利用的
   形态，该用例会同步变红。
5. CLI 失败信息补一行提示：HTML 注释里的文字不计入可回溯来源。

## Alternatives considered

- **只改模板：把提示文字从 HTML 注释里挪走** — 落选；治标不治本。门禁的输入是**任意** PR body，
  任何人都能在注释里写 `Closes #123`，把提示挪出注释并不能阻止这种写法，漏洞依旧。
- **改为解析 GitHub 渲染后的 HTML（如调 API 取 rendered body）** — 落选；门禁在 `pull_request`
  事件上以脚本形式运行，为此引入网络依赖与 token 权限，收益远不抵复杂度。剥离注释已等价于
  「只认可见文本」。
- **删除 `BARE_NUMBER`（裸 `#123` 判定）** — 未采纳。它**不是**模板漏洞的来源：模板剥离注释后
  只剩 `关联 Issue: #`（无数字），命中不了该分支。而项目 PR 描述确有「见 #331」这类指涉惯例
  （GitHub 会渲染成真实链接），删掉会造成真实误判。已在脚本头部把该取舍写明，并保留「若判定过宽
  可删除」的可逆路径。
- **把「无关联 issue」也改为必须带编号或强制 issue 化** — 落选；与 #332 无关，且会与
  `scripts/open-pr.mjs --no-issue` 的既有出口冲突。
- **门禁降级为 warning** — 落选；与仓库「铁律必须有门禁」的既有主张相悖。

## Consequences

- 模板原样、未做任何填写的 PR 现在会**正确失败**（`exit=1`），门禁恢复强制力。
- 真实写法不受影响：`Closes #n` / `关联 Issue: #n` / 裸 `#n` / `TD-*` / 「无关联 issue」
  （含 `open-pr.mjs --no-issue` 产出的 body）全部照旧通过。
- 剥离注释属纯字符串预处理，不引入依赖、不改变退出码语义，CI 自测步骤耗时不变。
- 不改任何工具 `inputSchema`/`outputSchema` 与 `AgentEvent`/gateway frames，LLM replay
  fixtures 与事件矩阵不受影响。
