---
name: patent-download
description: 从 Google Patents 下载专利 PDF 原文。通过专利公开号/授权公告号下载。触发场景：(1) "下载专利PDF"、"获取专利原文"、"下载CN/US/EP专利" (2) 单个或批量下载（支持从文件读取）。支持中国(CN)、美国(US)、欧洲(EP)、PCT(WO)等多国专利。优先使用 ego-browser（浏览器自动化），CDN直连作为备选。
---

# 专利下载技能

通过专利号从 Google Patents 下载 PDF 原文，支持单个和批量下载。

## 执行通道（优先级）

1. **Sati 内置 `ego_browser` 工具（首选）**——真实浏览器复用 ego lite 登录态，直接打开 `https://patents.google.com/patent/<专利号>` 抓取 PDF 下载链接；适用于反爬 / 网络隔离场景。
2. **`scripts/download_patent_ego.py`（CLI 备选）**——ego-browser 打开页面提取真实 PDF CDN URL，再用 urllib 从 CDN 下载（速度快、不受 CORS 限制），中国大陆无需代理。
3. **`scripts/download_patent.py`（旧版参考）**——requests + BeautifulSoup 爬取，中国大陆需代理才能访问。

## 快速使用

**执行方式**：脚本在 `scripts/` 下，使用 `python3` 运行。
> 如需 `patent-download` 命令，创建 alias：`alias patent-download='python3 /path/to/skills/patent-download/scripts/download_patent_ego.py'`

```bash
cd <本 skill 目录，仓库内为 skills/patent-download/>

# 单个专利（推荐：ego-browser 提取链接 + CDN 下载）
python3 scripts/download_patent_ego.py CN115690481A

# 多个专利（批量下载）
python3 scripts/download_patent_ego.py US11452699B2 CN109600000A EP1234567A1

# 从文件读取专利号列表（每行一个）
python3 scripts/download_patent_ego.py -f patent_list.txt

# 指定输出目录
python3 scripts/download_patent_ego.py CN115690481A -o ~/Downloads/patents

# 下载后自动打开 PDF
python3 scripts/download_patent_ego.py CN115690481A --open
```

## 方式一：ego-browser 提取 + CDN 下载（推荐）

`download_patent_ego.py` 用 [ego lite](https://lite.ego.app/) 浏览器自动化引擎驱动 Chromium 打开 Google Patents 页面，精确提取 PDF 下载链接，再用 urllib 从 CDN 下载。

**优点**：
- 在中国大陆无需代理即可访问 Google Patents
- 复用浏览器登录状态
- 精确提取 PDF 下载链接（不依赖猜测的 CDN URL 格式）

**依赖**：本机已安装 ego lite（Sati 内置 `ego_browser` 工具同样依赖它）。

## 方式二：旧版 requests 方式（备选）

`scripts/download_patent.py` 使用 `requests` + `BeautifulSoup` 爬取 Google Patents，在中国大陆需代理才能访问。保留以供参考。

```bash
python3 scripts/download_patent.py CN123456789A --proxy 9981
```

## 支持的专利号格式

| 国家/地区 | 代码 | 示例 |
|---------|------|------|
| 中国 | CN | CN123456789A, CN123456789B |
| 美国 | US | US12345678B2, US1234567 |
| 欧洲 | EP | EP1234567A1, EP1234567B1 |
| PCT | WO | WO2023123456A1 |
| 日本 | JP | JP2023123456A |
| 韩国 | KR | KR102023123456A |
| 德国 | DE | DE102023123456A1 |
| 英国 | GB | GB2023123456A |

## 代理配置

旧版 requests 脚本使用代理访问 Google Patents：

- `--proxy http://host:port` 指定代理
- 默认不配置代理

## 输出目录

默认保存到**当前工作空间**下的 `专利原文/YYYY-MM-DD/`（日期按当天自动生成），可通过 `-o` 参数修改。

## 注意事项

1. **ego-browser 方式**：基于 Chromium 浏览器，在中国大陆可直接访问 Google Patents
2. **CDN 下载**：直接从 Google Patents CDN 下载，无需浏览器，速度快
3. **文件大小**：单个 PDF 通常 1-20MB

## 脚本位置

```
scripts/download_patent_ego.py   # 推荐使用（ego-browser 提取 + CDN 下载）
scripts/download_patent.py       # 旧版（requests + BeautifulSoup，需代理）
```
