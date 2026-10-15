# Agent Note: edit_file 把 new_string 按字面量写入

Status: implemented

## Problem

`src/tool/builtin/editFile.ts` 的单次替换走的是 `content.replace(oldString, newString)`，即
`String.prototype.replace` 的**字符串替换器**——它会把 `new_string` 里的 `$$`、`$&`、`` $` ``、
`$'` 当替换模式展开。于是落盘的不是用户给的字符串，而是展开后的结果：`$$HOME` 写成 `$HOME`，
LaTeX 的 `$$E=mc^2$$` 掉成单 `$`，`IFS=$'\n'` 变成插入「匹配之后的内容」，`x $& y` 变成
「`x` + 被匹配的原文 + `y`」。

受害面是含 `$` 的代码与配置（shell/Makefile 的 `$$`、ANSI-C 引用、LaTeX 公式、正则里的 `$&`），
而失败是**静默**的：写入成功、无报错，只是内容不对。

## Decision

改用函数替换器 `content.replace(actualOldString, () => normalizedNew)`，`new_string` 原样落盘。
`replace_all` 分支本就走 `split().join()`，不受此影响，但一并加了覆盖它的用例以防回退。

不改 `EditFileInput`（`inputSchema` 未动），因此不触发 llm-replay fixture 重录。

## Alternatives considered

- **把 `new_string` 里的 `$` 手动转义成 `$$` 再交给字符串替换器** —— 等价于自己实现转义表，
  但漏一项就重现同一缺陷（`$` 后跟什么字符才需转义本身就是 replace 的隐规则）；函数替换器由
  引擎保证不做模式展开。
- **换成正则替换并转义 pattern** —— 需要把 `old_string` 转义成合法正则，复杂度更高，且引入
  `$1`/`$<name>` 的组引用语义（同样要转义），不若函数替换器直白。
- **在上层（写入前）做一次字面量校验/回读比对** —— 只增加检测，不修成因；且要读回全文比对，
  在 `replace_all` 与部分匹配形态下成本更高。

## Consequences

- **换来**：`new_string` 就是落盘内容；判据为 `tests/tool/edit-file-literal-replacement.spec.ts`
  （8 类替换模式字符 × `replace_all` 两态 + 全局替换 + 失败签名）。实测：回退这一行，恰好在
  `replace_all=false` 的 6 条模式用例与失败签名用例上转红，`replace_all=true` 的用例全绿——与该
  分支本来不受影响的分析一致。
- **付出**：无契约变化。此前依赖「`$$` 会被折叠成 `$`」的调用方不存在（该行为从未被记录为特性，
  且只在写入含 `$` 文本时可见）。
