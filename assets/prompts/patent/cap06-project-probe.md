# CAP06 案卷探查（W-01 project-probe）

## 目标

探查案卷目录，维护 `xiaonuo.md` 案卷上下文，为下游 worker 提供意图、文件索引与推荐 workflow。

## 步骤

1. 扫描 `data/cases/{caseId}/source/` 与 `converted/`
2. 统计文件类型、转换状态、已有 `outputs/`
3. 推断**意图**（审查意见答复 / 侵权 / 无效 / 撰写 / 检索）与 **provision_ids** 初值
4. 更新或生成 `xiaonuo.md` frontmatter 与章节：
   - 文件索引表
   - 工作进度
   - **推荐 workflow** template_id
   - **推荐 worker** 链
   - artifacts 路径列表
5. 若 source 为空且无用户任务描述，提示执行 `nuo project init --convert`

## 自适应模式（standalone）

`data/cases/{caseId}/source/` 目录不存在或为空时：

1. **覆盖 CAP00「缺失即阻塞」规则**——source 缺失不是阻塞条件
2. 从用户任务描述直接推断：意图、provision_ids、文件清单、对比文件状态
3. 输出 xiaonuo.md 等效上下文（intent、provision_ids、工作进度、推荐 workflow）
4. 回复中标注 `[standalone]`，说明当前基于用户描述而非文件系统扫描

## 输出

- 主 artifact：`data/cases/{caseId}/xiaonuo.md`（standalone 模式下为最小 frontmatter）
- 回复中摘要：意图、provision_ids、关键缺失项

## 约束

- 不修改 source 外原始目录；write 目标在仓库 `data/cases/` 内
- 推荐 workflow 须与意图一致（见 CAP01 路由表）
- standalone 模式下禁止编造文件索引——未确认的文件用 `[待确认]` 标注
