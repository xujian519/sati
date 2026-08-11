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
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
import ssl
from datetime import date
from pathlib import Path

EGO_BROWSER_CMD = os.environ.get('EGO_BROWSER_CMD', 'ego-browser')
# 默认输出到智能体当前工作空间下的 专利原文/ 目录（可用 -o 覆盖）
DEFAULT_OUTPUT_DIR = os.path.join(os.getcwd(), '专利原文')

# 确保 ego-browser 在 PATH 中
os.environ['PATH'] = os.path.expanduser('~/.local/bin') + ':' + os.environ.get('PATH', '')

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


def normalize_patent_number(patent_num: str) -> str:
    """标准化专利号格式"""
    patent_num = patent_num.strip().upper()
    patent_num = re.sub(r'[\s\-:/]', '', patent_num)
    return patent_num


def _build_batch_ego_script(patent_numbers: list) -> str:
    """
    构造单次 ego-browser 脚本：复用同一 task space / tab 循环打开所有专利页，
    逐篇提取 PDF 链接与标题，cliLog 输出带专利号前缀的行。
    """
    nums = [normalize_patent_number(n) for n in patent_numbers]
    lines = [
        f"const task = await useOrCreateTaskSpace('patent-download-batch');",
        "const nums = " + json.dumps(nums) + ";",
        "for (const num of nums) {",
        "  try {",
        "    await openOrReuseTab('https://patents.google.com/patent/' + num, { wait: true, timeout: " + str(PAGE_TIMEOUT_SEC) + " });",
        "    const pdfUrl = await js(String.raw`(() => {",
        "      const links = document.querySelectorAll('a[href*=\".pdf\"]');",
        "      for (const link of links) {",
        "        if (link.href && link.href.includes('.pdf')) {",
        "          if (link.href.includes('storage.googleapis.com') || link.href.includes('patentimages')) {",
        "            return link.href;",
        "          }",
        "        }",
        "      }",
        "      for (const link of links) {",
        "        if (link.href) return link.href;",
        "      }",
        "      return null;",
        "    })()`);",
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


def download_pdf_from_url(pdf_url: str, output_path: str, timeout: int = DOWNLOAD_TIMEOUT_SEC) -> dict:
    """
    从 CDN URL 流式下载 PDF 到 output_path（64KB 分块边读边写，先写 .tmp
    再原子重命名；避免整篇 PDF 全量进内存，1-20MB 文件内存占用从 ~20MB 降到 ~64KB）。
    校验 PDF 魔数（%PDF），非 PDF 内容不落盘。
    """
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

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

            # 流式写 .tmp
            fd, tmp_path = tempfile.mkstemp(prefix=output_path.name + '.', suffix='.tmp', dir=str(output_path.parent))
            size = 0
            with os.fdopen(fd, 'wb') as f:
                f.write(head)
                size += len(head)
                while True:
                    chunk = resp.read(DOWNLOAD_CHUNK_SIZE)
                    if not chunk:
                        break
                    f.write(chunk)
                    size += len(chunk)

            if size < 100:
                os.unlink(tmp_path)
                tmp_path = None
                return {'success': False, 'error': f'下载内容过小（{size} bytes），疑似错误页'}

            os.replace(tmp_path, str(output_path))
            tmp_path = None
            return {'success': True, 'path': str(output_path), 'size': size, 'pdf_url': pdf_url}

    except Exception as e:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        return {'success': False, 'error': f'下载失败: {str(e)}'}


def download_one(num: str, item: dict, output_dir: Path) -> dict:
    """下载单个专利（供线程池调用）：跳过已存在文件，提取失败直接返回。"""
    if not item.get('pdf_url'):
        return {'success': False, 'num': num, 'error': '未找到PDF下载链接'}

    safe_title = re.sub(r'[<>:"/\\|?*]', '', item.get('title') or num)[:60]
    file_path = output_dir / f"{num}_{safe_title}.pdf"
    if file_path.exists() and file_path.stat().st_size > 100:
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

    args = parser.parse_args()

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

    # 步骤1: 单次 ego-browser 会话批量提取所有 PDF URL
    print(f"\n[提取] 一次浏览器会话批量打开 {len(patent_numbers)} 篇 Google Patents 页面...")
    extract_result = extract_pdf_urls_with_ego(patent_numbers)

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
            executor.submit(download_one, num, item, output_dir): num
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
