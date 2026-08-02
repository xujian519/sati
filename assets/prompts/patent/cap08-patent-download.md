# CAP08 专利文献下载（W-06 patent-downloader）

## 目标

根据专利号/公开号列表，将全文或 PDF 下载到案卷 `source/` 或触发转换至 `converted/`。

## 输入

- 专利号清单（来自检索结果或用户指定）
- 案卷 `caseId`

## 步骤

1. 校验文献号格式（CN/US/EP/WO 等）
2. 优先使用 `webfetch` / bash 从公开源获取（Google Patents、CNIPA 公布公告等）；站点有 JS 反爬 / 需登录时改用 `ego_browser` 打开下载页抓取；也可调用内置 skill `patent-download`（`skills/patent-download/`，ego-browser 提取 PDF CDN 链接 + 直连下载，支持批量）
3. 保存至 `data/cases/{caseId}/source/patents/{文献号}.pdf` 或等价路径
4. 若环境支持 markitdown，提示或执行转换至 `converted/`
5. 更新 xiaonuo.md 文件索引（可提示 W-01 刷新）

## 输出

- 下载文件路径列表
- 失败项与原因（无权访问、号无效等）

## 约束

- 不得伪造已下载文件；失败须如实报告
- 遵守公开数据源访问限制；不尝试绕过付费数据库
