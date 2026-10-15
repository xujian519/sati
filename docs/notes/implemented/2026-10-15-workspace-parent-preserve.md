# Agent Note: 工作区创建失败不再删除已存在的目录

Status: implemented

## Problem

`ui/server/routes/projects.js` 的两条 clone 路径（`POST /create-workspace`、`GET /clone-progress`）
顺序是「先 `mkdir` 目标目录 → 再查 clone 凭据 → 查不到就把该目录 `fs.rm(recursive)` 掉」。

而 `workspaceType: "new"` 并不要求目标路径事先不存在——`validateWorkspacePath` 只拒绝系统关键
目录。于是「路径填一个已存在的目录 + 一个查不到的 `githubTokenId` + 带 `githubUrl`」这一组合，
会连带递归删除整棵已存在的目录树。这是数据毁灭路径，不是权限边界问题。

## Decision

凭据解析前置到任何文件系统改动之前：查不到就直接回 404，**不再有清理动作**（此时什么都还没建）。
两条 clone 路径同此形态。

clone **失败后**清理 `clonePath` 的那处保留——该子目录在 clone 前已确认不存在（存在则回 409），
删它不会波及既有数据。

## Alternatives considered

- **在 `fs.rm` 前加「该目录是否由本次请求创建」的标记** —— 需要在异常路径上正确传递请求级状态，
  失败模式恰是「标记丢了就删」；把凭据前置根本不需要清理动作，代码更少、假设也更少。
- **把 `workspaceType: "new"` 收紧为「路径必须不存在」** —— 会拒绝既有用户的合法用法（先选目录、
  再 clone 进去），且与 `existing`/`new` 的语义分工冲突。
- **只删「本次请求新建的那一层」，不动已存在目录** —— 需要区分 `mkdir` 前后路径是否存在，等于把
  上面的标记换个位置实现；仍是「先建、失败再删」，不如不建。

## Consequences

- **换来**：「已存在目录 + 凭据丢失」不再造成数据丢失。判据为
  `ui/server/routes/projects.workspace-cleanup.test.js`——回退这一行会让两条「保留已存在目录」用例
  直接转红（已实测）。
- **付出**：错误信息仍是 `GitHub token not found`，用户看不到「目录未被改动」的确认；`githubTokenId`
  非法时现在**不再**产生任何副作用，因此也不会顺手建出目标目录（`workspaceType: "new"` + `githubUrl`
  的组合必须先有合法凭据才会落盘）。
- **顺带关闭**：`2026-10-10-token-log-redaction.md` 里挂着的「上游 workspace token cleanup 语义未能
  定位、本项目是否有等价问题未核验」现已核验为**有且完全等价**，该标注在同批更新中关闭。
