#!/usr/bin/env python3
"""
专利PDF下载工具 - ego-browser 混合版本
通过专利公开号/公告号从Google Patents下载PDF原文

策略：
1. 用 ego-browser 打开 Google Patents 页面，提取实际 PDF CDN URL
2. 用 urllib 从 CDN 下载（速度快，不受CORS限制）

适用于中国大陆网络环境（ego-browser 可正常访问 Google Patents）
"""

import argparse
import os
import re
import subprocess
import sys
import urllib.request
import ssl
from datetime import date
from pathlib import Path

EGO_BROWSER_CMD = os.environ.get('EGO_BROWSER_CMD', 'ego-browser')
DEFAULT_OUTPUT_DIR = os.path.expanduser('~/Documents/小诺工作记录/专利原文')

# 确保 ego-browser 在 PATH 中
os.environ['PATH'] = os.path.expanduser('~/.local/bin') + ':' + os.environ.get('PATH', '')


def normalize_patent_number(patent_num: str) -> str:
    """标准化专利号格式"""
    patent_num = patent_num.strip().upper()
    patent_num = re.sub(r'[\s\-:/]', '', patent_num)
    return patent_num


def extract_pdf_url_with_ego(patent_num: str) -> dict:
    """
    使用 ego-browser 打开 Google Patents 页面，提取 PDF 实际下载链接
    """
    normalized_num = normalize_patent_number(patent_num)
    patent_url = f"https://patents.google.com/patent/{normalized_num}"
    
    ego_script = f'''
const task = await useOrCreateTaskSpace('pd {normalized_num}');
await openOrReuseTab('{patent_url}', {{ wait: true, timeout: 30 }});

// 从页面中提取所有PDF链接
const pdfUrl = await js(String.raw`(() => {{
  const links = document.querySelectorAll('a[href*=".pdf"]');
  for (const link of links) {{
    if (link.href && link.href.includes('.pdf')) {{
      if (link.href.includes('storage.googleapis.com') || link.href.includes('patentimages')) {{
        return link.href;
      }}
    }}
  }}
  for (const link of links) {{
    if (link.href) return link.href;
  }}
  return null;
}})()`);
cliLog('PDF_URL:' + (pdfUrl || 'NULL'));

// 获取专利标题（不是页面导航中的 "Patents"）
const title = await js(String.raw`(() => {{
  // 查找包含专利标题的heading，通常在h1之后的第二个heading
  const headings = document.querySelectorAll('h1, h2, h3');
  for (const h of headings) {{
    const raw = h.innerText.trim();
    const text = raw.replace(/\\s*-\\s*Google Patents\\s*$/, '');
    // 跳过 "Patents" 导航标题和其他短标题
    if (text && text !== 'Patents' && text.length > 4 && !text.startsWith('Similar') && !text.startsWith('Priority') && !text.startsWith('Legal')) {{
      return text;
    }}
  }}
  // 如果找不到，使用页面标题
  return document.title.replace(' - Google Patents', '').trim();
}})()`);
cliLog('TITLE:' + (title || '未知'));

await completeTaskSpace(task.id, {{ keep: false }});
'''
    
    try:
        result = subprocess.run(
            [EGO_BROWSER_CMD, 'nodejs'],
            input=ego_script,
            capture_output=True,
            text=True,
            timeout=60,
            env=os.environ
        )
        
        # cliLog 输出在 stderr 而非 stdout
        output = result.stderr
        pdf_url = None
        title = None

        for line in output.split('\n'):
            line = line.strip()
            if line.startswith('PDF_URL:'):
                raw = line[len('PDF_URL:'):].strip()
                pdf_url = None if raw == 'NULL' else raw
            elif line.startswith('TITLE:'):
                title = line[len('TITLE:'):].strip()

        if not pdf_url:
            return {'success': False, 'error': '未找到PDF下载链接'}
        
        return {'success': True, 'pdf_url': pdf_url, 'title': title or normalized_num}
        
    except subprocess.TimeoutExpired:
        return {'success': False, 'error': 'ego-browser 执行超时（60秒）'}
    except FileNotFoundError:
        return {'success': False, 'error': 'ego-browser 未安装。请先安装 ego lite: https://lite.ego.app/'}
    except Exception as e:
        return {'success': False, 'error': f'ego-browser 执行异常: {str(e)}'}


def download_pdf_from_url(pdf_url: str, output_path: str) -> dict:
    """
    从 CDN URL 直接下载 PDF
    """
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    
    try:
        req = urllib.request.Request(pdf_url, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        })
        with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
            data = resp.read()
            
        if len(data) < 100 or data[:4] != b'%PDF':
            return {'success': False, 'error': f'下载的内容不是有效的PDF（{len(data)} bytes）'}
        
        with open(output_path, 'wb') as f:
            f.write(data)
        
        return {'success': True, 'path': output_path, 'size': len(data), 'pdf_url': pdf_url}
    
    except Exception as e:
        return {'success': False, 'error': f'下载失败: {str(e)}'}


def main():
    parser = argparse.ArgumentParser(
        description='从Google Patents下载专利PDF原文 (ego-browser版)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='示例:\n  %(prog)s CN218100837U\n  %(prog)s CN218100837U CN115690481A\n  %(prog)s CN218100837U -o ~/Downloads/\n  %(prog)s -f patent_list.txt'
    )
    
    parser.add_argument('patent_numbers', nargs='*', help='专利公开号/公告号')
    parser.add_argument('-o', '--output', default=None, help='输出目录（默认: ~/Documents/小诺工作记录/专利原文/YYYY-MM-DD/）')
    parser.add_argument('-f', '--file', help='从文件读取专利号列表（每行一个）')
    parser.add_argument('--open', action='store_true', help='下载后自动打开PDF')
    
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
    
    print(f"专利PDF下载工具 (ego-browser版)")
    print(f"输出目录: {output_dir}")
    print("=" * 50)
    
    success_count = 0
    for i, patent_num in enumerate(patent_numbers, 1):
        normalized_num = normalize_patent_number(patent_num)
        print(f"\n[{i}/{len(patent_numbers)}] {patent_num} → {normalized_num}")
        
        # 步骤1: 用 ego-browser 提取 PDF URL
        print(f"  → 打开 Google Patents 页面提取下载链接...")
        extract_result = extract_pdf_url_with_ego(patent_num)
        
        if not extract_result['success']:
            print(f"  ✗ 提取失败: {extract_result['error']}")
            continue
        
        pdf_url = extract_result['pdf_url']
        title = extract_result['title']
        print(f"  ✓ 标题: {title}")
        print(f"  ✓ PDF链接: {pdf_url}")
        
        # 步骤2: 从CDN下载
        safe_title = re.sub(r'[<>:"/\\|?*]', '', title)[:60]
        file_path = output_dir / f"{normalized_num}_{safe_title}.pdf"
        
        print(f"  → 下载中...")
        download_result = download_pdf_from_url(pdf_url, str(file_path))
        
        if download_result['success']:
            size_kb = download_result['size'] / 1024
            print(f"  ✓ 下载成功: {size_kb:.1f} KB")
            print(f"  ✓ 保存至: {file_path}")
            success_count += 1
            
            if args.open:
                subprocess.run(['open', str(file_path)])
        else:
            print(f"  ✗ 下载失败: {download_result['error']}")
    
    # 汇总
    print(f"\n{'='*50}")
    print(f"完成: {success_count}/{len(patent_numbers)} 个专利下载成功")
    return 0 if success_count == len(patent_numbers) else 1


if __name__ == '__main__':
    sys.exit(main())
