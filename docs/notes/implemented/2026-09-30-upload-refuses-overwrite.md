# Agent Note: 工作区文件上传拒绝覆盖已有文件

Status: implemented

## Problem

`uploadFilesHandler` 把上传的暂存文件直接 `copyFile` 到工作区目标路径，同名文件被**静默覆盖**且不留痕迹——对案卷这类不可再生资料，一次同名"补传"就换掉了已有版本。同一条链路里，越界的目标路径此前是 `continue` 静默跳过，调用方拿到的是"成功"。

前端也帮不上忙：`FilesV2` 对 `!response.ok` 只做 `logError`（转 `console.error`），用户看不见任何提示。

## Decision

发布改用 `copyFile(..., COPYFILE_EXCL)`：目标已存在（含目录、悬挂软链）即抛 `EEXIST`，不覆盖。冲突与写入失败**按文件**收集，响应分三态——全部成功 200（保持原响应形状，向后兼容）、部分写入 207、全部被拒 409；后两者带 `files`（已落盘）、`conflicts`（被拒的同名文件）、`errors`（其它失败）。越界路径从静默跳过改为进 `errors`。

前端只补最小的可见性：新增 `workspaceUploadOutcome.ts` 归纳响应，冲突时先刷新文件树再派发 `sati:toast` 列出被拒文件名。判据是载荷里的 `conflicts` 而不是 `response.ok`——207 落在 `ok` 区间内，只看 `ok` 会把失败当成功吞掉。

## Alternatives considered

- **先查存在再写** — 落选：TOCTOU，两个并发上传同名文件会双双通过检查再互相覆盖。
- **硬链接发布（`fs.link` + EXDEV 回退）** — 落选：多出跨设备回退与暂存文件清理两条路径；`COPYFILE_EXCL` 给出同样的"不覆盖"保证且跨设备天然可用。代价是目标文件在复制期间可见（非原子发布），但该目标此前并不存在，没有并发读者。
- **自动重命名（`name-1.txt`）** — 落选：`moveUploadedAttachment`（聊天附件）可以这样做，因为它的目录是私有命名空间；工作区上传的 `relativePaths` 是用户显式给的目标路径，静默改名会让文件"消失"。
- **只改后端不改前端** — 落选：冲突会变成用户不可见的失败，比原先的静默覆盖只是换了个位置。
- **移植上游整套上传重做（暂存目录 + 校验和 + 进度/取消/重试组件）** — 落选：超出缺陷范围，且依赖 Sati 没有的 `workspaceFileUpload.js`／`useWorkspaceUpload` 等文件；此处只取"拒绝覆盖 + 回报冲突"的语义。

## Consequences

- 同名上传不再覆盖，用户得到明确提示；批量上传中其余文件照常落盘。
- 越界路径不再静默跳过，改为出现在 `errors` 里。
- 归纳逻辑抽成独立模块后 `FilesV2.tsx` 净减 2 行（该文件在架构基线豁免清单内，棘轮要求不得增长），归纳逻辑也因此可单测。
- 207/409 是新响应形态；Sati 内该端点的调用方只有 `FilesV2`，已同步适配。
