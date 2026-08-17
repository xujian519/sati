#!/usr/bin/env python3
"""
专利PDF下载工具 - ego-browser 批量混合版本
通过专利公开号/公告号从Google Patents下载PDF原文

策略：
1. 用【一次】 ego-browser 会话打开所有 Google Patents 页面（openOrReuseTab 复用
   同一 tab），批量提取实际 PDF CDN URL —— 不再每篇重启浏览器进程（旧版逐篇
   spawn，12 篇 = 12 次 Chromium 启动，每次 30-60s）。
2. 用 urllib 并发从 CDN 下载（速度快，不受CORS限制），分块流式写盘。

适用于中国大陆网络环境（ego-browser 可正常访问 Google Patents）
"""

import argparse
import concurrent.futures
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import ssl
from datetime import date
from pathlib import Path
from typing import Union

EGO_BROWSER_CMD = os.environ.get('EGO_BROWSER_CMD', 'ego-browser')
# 默认输出到智能体当前工作空间下的 专利原文/ 目录（可用 -o 覆盖）
DEFAULT_OUTPUT_DIR = os.path.join(os.getcwd(), '专利原文')

# 确保 ego-browser 在 PATH 中
os.environ['PATH'] = os.path.expanduser('~/.local/bin') + ':' + os.environ.get('PATH', '')

# P0-02：默认完整校验 SSL 证书链；--no-verify-ssl 显式 opt-in 时才关闭
#（仅企业内网 MITM 代理等特殊场景，由用户在报错引导下显式开启）
NO_VERIFY_SSL = False

# 并发下载线程数（CDN 下载是 IO 密集，网络带宽允许时可调大）
DEFAULT_DOWNLOAD_WORKERS = 4
# 单个页面打开超时（秒）
PAGE_TIMEOUT_SEC = 20
# 提取阶段整体超时 = 基础 + 每篇页面超时（浏览器启动 ~10s + 每页 ~20s）
EXTRACT_BASE_TIMEOUT_SEC = 30
# 单文件下载超时（秒）
DOWNLOAD_TIMEOUT_SEC = 60
# 下载分块大小（64KB）
DOWNLOAD_CHUNK_SIZE = 64 * 1024

# P2-02：下载失败指数退避重试（与 TS fetchPdfFallback 同参数：最多 3 次、
# base 1s、factor 2、上限 30s + 25% jitter；429/5xx 与网络错误重试，
# 404/403 与魔数错误属确定性失败，不重试）
DOWNLOAD_RETRY_ATTEMPTS = 3
DOWNLOAD_RETRY_BASE_DELAY_SEC = 1.0
DOWNLOAD_RETRY_FACTOR = 2
DOWNLOAD_RETRY_MAX_DELAY_SEC = 30.0
DOWNLOAD_RETRY_STATUSES = {408, 409, 425, 429, 500, 502, 503, 504}

# P2-03：产物命名契约统一为 <num>.pdf（与 TS 侧一致，MANIFEST 互相识别）；
# --with-title 恢复旧命名 <num>_<title>.pdf 作为兼容开关
USE_TITLE_SUFFIX = False
# P2-03：MANIFEST 断点续传文件（<outputDir>/.MANIFEST.jsonl，append 追加式）
MANIFEST_FILE = '.MANIFEST.jsonl'

# P2-07：PDF 链接提取 JS 单一事实源（assets/patent/pdf-link-extract.js，与 TS 工具
# patentPdfDownload.ts 两端共用）。脚本路径 skills/patent-download/scripts/ 上溯
# 三级即仓库根；独立分发（文件缺失）时回退内嵌备份 _PDF_LINK_EXTRACT_JS_BACKUP。
PDF_LINK_EXTRACT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'assets', 'patent', 'pdf-link-extract.js')


def normalize_patent_number(patent_num: str) -> str:
    """标准化专利号格式"""
    patent_num = patent_num.strip().upper()
    patent_num = re.sub(r'[\s\-:/]', '', patent_num)
    return patent_num


def validate_patent_numbers(patent_numbers: list) -> list:
    """P1-02：专利号归一化后拒绝路径穿越字符（\\ 与 ..），防止文件名拼接逃逸。

    归一化已去除 / 与空白；保留绝对路径/自定义目录能力（-o 不限制）。
    返回规范化后的列表；非法输入直接报错退出。
    """
    normalized = [normalize_patent_number(n) for n in patent_numbers]
    for n in normalized:
        if '\\' in n or '..' in n:
            raise SystemExit(f"错误: 专利号包含非法路径字符（拒绝）: {n}")
    return normalized


# P2-07：内嵌备份（与 assets/patent/pdf-link-extract.js 内容一致，含 allLinks 兜底；
# 同样遵守无反引号与 ${ 的约束，便于 String.raw 模板嵌入）
_PDF_LINK_EXTRACT_JS_BACKUP = '''(() => {
  const links = document.querySelectorAll('a[href*=".pdf"]');
  for (const link of links) {
    if (link.href && (link.href.includes('storage.googleapis.com') || link.href.includes('patentimages'))) return link.href;
  }
  for (const link of links) { if (link.href) return link.href; }
  // Google Patents 新版把 PDF URL 放在某些 data 属性或按钮附近，兜底扫描全部 href
  const allLinks = [...document.querySelectorAll('a[href]')];
  for (const link of allLinks) {
    if (link.href && (link.href.includes('.pdf') || link.href.includes('download'))) return link.href;
  }
  return null;
})()'''


def _load_pdf_extract_js() -> str:
    """P2-07：读取单一事实源 pdf-link-extract.js（首行版本标记校验）。

    读文件失败（独立分发场景）或首行版本标记缺失（内容可能被误改）时，
    回退内嵌备份 _PDF_LINK_EXTRACT_JS_BACKUP 并打印警告便于排查。
    """
    try:
        with open(PDF_LINK_EXTRACT_PATH, 'r', encoding='utf-8') as f:
            source = f.read()
        first_line = source.splitlines()[0] if source.splitlines() else ''
        if re.match(r'^// PDF_LINK_EXTRACT_VERSION=\d+$', first_line):
            return source
        print(f"警告: {PDF_LINK_EXTRACT_PATH} 缺少版本标记，回退内嵌备份", file=sys.stderr)
    except OSError as e:
        print(f"警告: 读取 {PDF_LINK_EXTRACT_PATH} 失败（{e}），回退内嵌备份", file=sys.stderr)
    return _PDF_LINK_EXTRACT_JS_BACKUP


def _build_batch_ego_script(patent_numbers: list) -> str:
    """
    构造单次 ego-browser 脚本：复用同一 task space / tab 循环打开所有专利页，
    逐篇提取 PDF 链接与标题，cliLog 输出带专利号前缀的行。
    """
    nums = [normalize_patent_number(n) for n in patent_numbers]
    # P2-07：提取 JS 来自单一事实源；嵌入 String.raw 模板前转义反引号与 ${（
    # 文件/备份已约定不出现，此处防御性处理，防止误改内容截断模板字面量）
    escaped_extract_js = _load_pdf_extract_js().replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')
    lines = [
        f"const task = await useOrCreateTaskSpace('patent-download-batch');",
        "const nums = " + json.dumps(nums) + ";",
        "for (const num of nums) {",
        "  try {",
        "    await openOrReuseTab('https://patents.google.com/patent/' + num, { wait: true, timeout: " + str(PAGE_TIMEOUT_SEC) + " });",
        "    // Google Patents 是 SPA：openOrReuseTab 的 wait 只保证导航事件，DOM 可能",
        "    // 仍在异步更新。提取前校验当前页 URL 确实指向目标专利，避免复用 tab 时",
        "    // 把上一篇专利的 PDF 链接错配给本篇（短重试 3 次等 SPA 渲染）。",
        "    // 大小写不敏感 + 专利号后按 '/' 或 '?' 边界判定，防误通过。",
        "    let onPage = false;",
        "    const numLower = num.toLowerCase();",
        "    for (let attempt = 0; attempt < 3 && !onPage; attempt++) {",
        "      const href = await js(String.raw`location.href.toLowerCase()`);",
        "      const marker = '/patent/' + numLower;",
        "      const idx = href.indexOf(marker);",
        "      if (idx !== -1) {",
        "        const after = href.charAt(idx + marker.length);",
        "        onPage = after === '' || after === '/' || after === '?';",
        "      }",
        "      if (!onPage) await wait(1);",
        "    }",
        "    if (!onPage) throw new Error('page mismatch: ' + num);",
        "    const pdfUrl = await js(String.raw`" + escaped_extract_js + "`);",
        "    const title = await js(String.raw`(() => {",
        "      const headings = document.querySelectorAll('h1, h2, h3');",
        "      for (const h of headings) {",
        "        const raw = h.innerText.trim();",
        "        const text = raw.replace(/\\s*-\\s*Google Patents\\s*$/, '');",
        "        if (text && text !== 'Patents' && text.length > 4 && !text.startsWith('Similar') && !text.startsWith('Priority') && !text.startsWith('Legal')) {",
        "          return text;",
        "        }",
        "      }",
        "      return document.title.replace(' - Google Patents', '').trim();",
        "    })()`);",
        "    cliLog('PDF_URL:' + num + ':' + (pdfUrl || 'NULL'));",
        "    cliLog('TITLE:' + num + ':' + (title || '未知'));",
        "  } catch (e) {",
        "    cliLog('PDF_URL:' + num + ':NULL');",
        "    cliLog('TITLE:' + num + ':ERROR');",
        "  }",
        "}",
        "await completeTaskSpace(task.id, { keep: false });",
    ]
    return "\n".join(lines)


def extract_pdf_urls_with_ego(patent_numbers: list) -> dict:
    """
    使用【一次】 ego-browser 调用批量打开 Google Patents 页面，提取各专利的
    PDF 实际下载链接与标题。返回 {num: {pdf_url, title}}，提取失败项缺省为
    {'pdf_url': None}，不中断其他专利。
    """
    nums = [normalize_patent_number(n) for n in patent_numbers]
    if not nums:
        return {'success': True, 'items': {}}

    ego_script = _build_batch_ego_script(nums)
    # 整体超时 = 浏览器启动 + 每篇页面超时 + 缓冲
    total_timeout = EXTRACT_BASE_TIMEOUT_SEC + PAGE_TIMEOUT_SEC * len(nums) + 15

    try:
        result = subprocess.run(
            [EGO_BROWSER_CMD, 'nodejs'],
            input=ego_script,
            capture_output=True,
            text=True,
            timeout=total_timeout,
            env=os.environ
        )

        # cliLog 输出在 stderr 而非 stdout
        output = result.stderr
        items = {num: {'pdf_url': None, 'title': num} for num in nums}

        for line in output.split('\n'):
            line = line.strip()
            if line.startswith('PDF_URL:'):
                _, num, raw = line.split(':', 2)
                if num in items:
                    items[num]['pdf_url'] = None if raw == 'NULL' else raw
            elif line.startswith('TITLE:'):
                _, num, title = line.split(':', 2)
                if num in items and title != 'ERROR':
                    items[num]['title'] = title

        # 过滤：完全没有 PDF 链接的项（仍保留在 items，由调用方判定失败）
        return {'success': True, 'items': items}

    except subprocess.TimeoutExpired:
        return {'success': False, 'error': f'ego-browser 批量提取超时（{total_timeout}秒，{len(nums)} 篇）'}
    except FileNotFoundError:
        return {'success': False, 'error': 'ego-browser 未安装。请先安装 ego lite: https://lite.ego.app/'}
    except Exception as e:
        return {'success': False, 'error': f'ego-browser 执行异常: {str(e)}'}


def _should_retry_urllib_error(err: Exception) -> bool:
    """P2-02：urllib 异常分类——429/5xx 与网络层错误（超时/连接重置/DNS 等）
    重试；404/403（HTTPError 不在重试集）与应用层错误（魔数/内容过小）确定性失败。
    注意 HTTPError 是 URLError 的子类，需先查 HTTPError。
    """
    if isinstance(err, urllib.error.HTTPError):
        return err.code in DOWNLOAD_RETRY_STATUSES
    # 仅网络层错误可重试；URLError/TimeoutError/ConnectionError 均为 OSError 子类，
    # 其余 OSError（FileNotFoundError/PermissionError 等本地确定性错误）不重试。
    if isinstance(err, (urllib.error.URLError, TimeoutError, ConnectionError)):
        return True
    return False


def download_pdf_from_url(pdf_url: str, output_path: Union[Path, str], timeout: int = DOWNLOAD_TIMEOUT_SEC) -> dict:
    """
    从 CDN URL 流式下载 PDF 到 output_path（64KB 分块边读边写，先写 .tmp
    再原子重命名；避免整篇 PDF 全量进内存，1-20MB 文件内存占用从 ~20MB 降到 ~64KB）。
    校验 PDF 魔数（%PDF），非 PDF 内容不落盘。
    失败按 _should_retry_urllib_error 分类指数退避重试（最多 3 次）。
    """
    ctx = ssl.create_default_context()
    if NO_VERIFY_SSL:
        # 显式 opt-in（--no-verify-ssl）：默认不再禁用证书校验
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    # 兼容 str 调用方；内部统一按 Path 使用 .name/.parent
    output_path = output_path if isinstance(output_path, Path) else Path(output_path)

    last_err = None
    for attempt in range(DOWNLOAD_RETRY_ATTEMPTS):
        tmp_path = None
        try:
            req = urllib.request.Request(pdf_url, headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            })
            with urllib.request.urlopen(req, context=ctx, timeout=timeout) as resp:
                # 先读头部校验魔数
                head = resp.read(4)
                if head != b'%PDF':
                    return {'success': False, 'error': f'下载的内容不是有效的PDF（magic={head!r}）'}

                # 流式写 .tmp（顺带计算 SHA-1，供 MANIFEST 记录）
                fd, tmp_path = tempfile.mkstemp(prefix=output_path.name + '.', suffix='.tmp', dir=str(output_path.parent))
                size = 0
                sha1 = hashlib.sha1()
                with os.fdopen(fd, 'wb') as f:
                    f.write(head)
                    sha1.update(head)
                    size += len(head)
                    while True:
                        chunk = resp.read(DOWNLOAD_CHUNK_SIZE)
                        if not chunk:
                            break
                        f.write(chunk)
                        sha1.update(chunk)
                        size += len(chunk)

                if size < 500:
                    os.unlink(tmp_path)
                    tmp_path = None
                    return {'success': False, 'error': f'下载内容过小（{size} bytes），疑似错误页'}

                os.replace(tmp_path, str(output_path))
                tmp_path = None
                return {'success': True, 'path': str(output_path), 'size': size, 'sha1': sha1.hexdigest(), 'pdf_url': pdf_url}

        except Exception as e:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            last_err = e
            if attempt < DOWNLOAD_RETRY_ATTEMPTS - 1 and _should_retry_urllib_error(e):
                delay = DOWNLOAD_RETRY_BASE_DELAY_SEC * (DOWNLOAD_RETRY_FACTOR ** attempt)
                delay = min(delay, DOWNLOAD_RETRY_MAX_DELAY_SEC)
                delay += random.uniform(0, max(1.0, delay * 0.25))
                time.sleep(delay)
                continue
            return {'success': False, 'error': f'下载失败: {str(e)}'}

    # 理论不可达（最后一次尝试已 return），兜底
    return {'success': False, 'error': f'下载失败: {str(last_err)}'}


def _artifact_path(output_dir: Path, num: str, title: str) -> Path:
    """P2-03：产物命名契约——默认 <num>.pdf（与 TS 侧一致，MANIFEST 互相识别）；
    --with-title 时保留旧命名 <num>_<safe_title>.pdf 兼容历史产物。"""
    if USE_TITLE_SUFFIX:
        safe_title = re.sub(r'[<>:"/\\|?*]', '', title or num)[:60]
        return output_dir / f"{num}_{safe_title}.pdf"
    return output_dir / f"{num}.pdf"


def load_manifest(output_dir: Path) -> dict:
    """P2-03：加载 MANIFEST（按 patent 去重，最后一条 wins）。

    单行损坏容忍跳过（仅影响该条目续传）；文件整体损坏（无任何有效行）
    时改名 .bak 保护现场并返回空。
    """
    manifest_path = output_dir / MANIFEST_FILE
    if not manifest_path.exists():
        return {}
    entries = {}
    valid_lines = 0
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    if entry.get('status') == 'ok' and entry.get('patent'):
                        entries[entry['patent']] = entry
                    valid_lines += 1
                except (json.JSONDecodeError, AttributeError):
                    pass
    except OSError:
        return {}
    if valid_lines <= 0:
        try:
            manifest_path.rename(manifest_path.with_suffix('.jsonl.bak'))
        except OSError:
            pass
        return {}
    return entries


def save_manifest_entry(output_dir: Path, entry: dict) -> None:
    """P2-03：追加一条 MANIFEST 记录（append 式，重复行由加载去重兜底）。"""
    manifest_path = output_dir / MANIFEST_FILE
    with open(manifest_path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def download_one(num: str, item: dict, output_dir: Path, force: bool = False) -> dict:
    """下载单个专利（供线程池调用）：跳过已存在文件，提取失败直接返回。
    force=True 时绕过"已存在跳过"（--force 强制重跑）。"""
    if not item.get('pdf_url'):
        return {'success': False, 'num': num, 'error': '未找到PDF下载链接'}

    # MANIFEST 记录绝对路径：跨 cwd 重跑（续传判断 Path(entry['path'])）也能命中。
    file_path = _artifact_path(output_dir, num, item.get('title') or num).resolve()
    if not force and file_path.exists() and file_path.stat().st_size > 500:
        return {'success': True, 'num': num, 'path': str(file_path), 'size': file_path.stat().st_size, 'skipped': True}

    result = download_pdf_from_url(item['pdf_url'], file_path)
    result['num'] = num
    result['title'] = item.get('title') or num
    return result


def main():
    parser = argparse.ArgumentParser(
        description='从Google Patents下载专利PDF原文 (ego-browser批量版)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='示例:\n  %(prog)s CN218100837U\n  %(prog)s CN218100837U CN115690481A\n  %(prog)s CN218100837U -o ~/Downloads/\n  %(prog)s -f patent_list.txt'
    )

    parser.add_argument('patent_numbers', nargs='*', help='专利公开号/公告号')
    parser.add_argument('-o', '--output', default=None, help='输出目录（默认: 当前工作空间/专利原文/YYYY-MM-DD/）')
    parser.add_argument('-f', '--file', help='从文件读取专利号列表（每行一个）')
    parser.add_argument('--open', action='store_true', help='下载后自动打开PDF')
    parser.add_argument('-j', '--jobs', type=int, default=DEFAULT_DOWNLOAD_WORKERS,
                        help=f'并发下载线程数（默认 {DEFAULT_DOWNLOAD_WORKERS}）')
    parser.add_argument('--no-verify-ssl', action='store_true',
                        help='禁用 SSL 证书校验（仅企业内网 MITM 代理等特殊场景；默认完整校验）')
    parser.add_argument('--with-title', action='store_true',
                        help='产物命名保留标题后缀（<专利号>_<标题>.pdf，兼容旧产物；默认 <专利号>.pdf）')
    parser.add_argument('--force', action='store_true',
                        help='忽略 MANIFEST 断点续传，强制重跑全部专利')

    args = parser.parse_args()
    global NO_VERIFY_SSL, USE_TITLE_SUFFIX
    NO_VERIFY_SSL = args.no_verify_ssl
    USE_TITLE_SUFFIX = args.with_title

    # 收集专利号
    patent_numbers = list(args.patent_numbers)
    if args.file:
        with open(args.file, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    patent_numbers.append(line)

    if not patent_numbers:
        parser.print_help()
        print("\n错误: 请提供至少一个专利号")
        sys.exit(1)

    # P1-02：路径穿越防御（归一化后拒绝 \ 与 ..），不限制绝对路径能力
    patent_numbers = validate_patent_numbers(patent_numbers)

    # 设置输出目录
    if args.output:
        output_dir = Path(args.output)
    else:
        output_dir = Path(DEFAULT_OUTPUT_DIR) / date.today().strftime('%Y-%m-%d')
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"专利PDF下载工具 (ego-browser批量版)")
    print(f"输出目录: {output_dir}")
    print(f"并发下载线程: {max(1, args.jobs)}")
    print("=" * 50)

    # P2-03：加载 MANIFEST（断点续传）——status=ok 且磁盘 size 匹配的直接跳过；
    # --force 时全部视为未下载。
    manifest = load_manifest(output_dir)
    pending = []
    for num in patent_numbers:
        entry = manifest.get(num)
        if (not args.force and entry and entry.get('path')
                and Path(entry['path']).exists()
                and Path(entry['path']).stat().st_size == entry.get('size')):
            continue  # 命中续传，跳过
        pending.append(num)
    skipped_n = len(patent_numbers) - len(pending)
    if skipped_n:
        print(f"  ↻ 断点续传命中：{skipped_n} 篇已下载，跳过（--force 可强制重跑）")

    # 旧命名产物提示（不自动删除）
    for num in patent_numbers:
        if not (output_dir / f"{num}.pdf").exists():
            old = list(output_dir.glob(f"{num}_*.pdf"))
            if old:
                print(f"  ⚠ 检测到旧命名产物 {old[0].name}（新契约为 {num}.pdf），未自动删除，请手动处理")

    if not pending:
        print("全部专利已在 MANIFEST 中，无需下载")
        return 0

    # 步骤1: 单次 ego-browser 会话批量提取所有 PDF URL
    print(f"\n[提取] 一次浏览器会话批量打开 {len(pending)} 篇 Google Patents 页面...")
    extract_result = extract_pdf_urls_with_ego(pending)

    if not extract_result['success']:
        print(f"  ✗ 批量提取失败: {extract_result['error']}")
        return 1

    items = extract_result['items']
    found = sum(1 for it in items.values() if it.get('pdf_url'))
    print(f"  ✓ 提取完成: {found}/{len(items)} 篇找到 PDF 链接")

    # 步骤2: 并发下载
    print(f"\n[下载] 并发下载中（{max(1, args.jobs)} 线程）...")
    success_count = 0
    fail_count = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as executor:
        future_map = {
            executor.submit(download_one, num, item, output_dir, args.force): num
            for num, item in items.items()
        }
        for future in concurrent.futures.as_completed(future_map):
            num = future_map[future]
            try:
                result = future.result()
            except Exception as e:
                result = {'success': False, 'num': num, 'error': f'下载线程异常: {e}'}

            if result['success']:
                size_kb = result['size'] / 1024
                skipped = ' (已存在，跳过)' if result.get('skipped') else ''
                print(f"  ✓ [{num}] {result.get('title', '')} · {size_kb:.1f} KB{skipped}")
                success_count += 1
                # P2-03：成功条目追加进 MANIFEST（下次执行命中即跳过）
                if not result.get('skipped'):
                    save_manifest_entry(output_dir, {
                        'patent': num,
                        'status': 'ok',
                        'path': str(result['path']),
                        'size': result['size'],
                        'sha1': result.get('sha1', ''),
                        'ts': int(time.time()),
                    })
                if args.open and not result.get('skipped'):
                    subprocess.run(['open', str(result['path'])])
            else:
                print(f"  ✗ [{num}] {result['error']}")
                fail_count += 1

    # 汇总
    print(f"\n{'='*50}")
    print(f"完成: {success_count}/{len(items)} 个专利下载成功" + (f"，{fail_count} 个失败" if fail_count else ""))
    return 0 if fail_count == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
