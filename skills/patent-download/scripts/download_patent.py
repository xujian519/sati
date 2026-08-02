#!/usr/bin/env python3
"""
专利PDF下载工具
通过专利公开号、公告号等从Google Patents下载PDF原文
"""

import argparse
import re
import sys
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("错误: 需要安装依赖")
    print("请运行: pip3 install requests beautifulsoup4")
    sys.exit(1)


def normalize_patent_number(patent_num: str) -> str:
    """
    标准化专利号格式
    支持格式: CN123456789A, US12345678B2, EP1234567A1, WO2023123456A1 等
    """
    # 移除空格和特殊字符
    patent_num = patent_num.strip().upper()
    patent_num = re.sub(r'[\s\-:/]', '', patent_num)
    return patent_num


def get_patent_pdf_url(patent_num: str, proxies: dict = None) -> dict:
    """
    从Google Patents获取专利PDF下载链接
    
    参数:
        patent_num: 专利号
        proxies: 代理设置 {'http': '...', 'https': '...'}
    
    返回:
        dict: {
            'success': bool,
            'pdf_url': str (成功时),
            'title': str (成功时),
            'error': str (失败时)
        }
    """
    normalized_num = normalize_patent_number(patent_num)
    patent_url = f"https://patents.google.com/patent/{normalized_num}"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    }
    
    try:
        response = requests.get(patent_url, headers=headers, timeout=30, proxies=proxies)
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        return {
            'success': False,
            'error': f'无法访问专利页面: {str(e)}'
        }
    
    soup = BeautifulSoup(response.text, 'html.parser')
    
    # 查找PDF下载链接
    # Google Patents 页面上的PDF链接通常有以下几种模式:
    # 1. <a href="...pdf"> 链接
    # 2. data-pdf 属性
    # 3. 特定的下载按钮
    
    pdf_url = None
    title = None
    
    # 方法1: 查找包含 "PDF" 或 "Download" 的链接
    for link in soup.find_all('a', href=True):
        href = link.get('href', '')
        link_text = link.get_text().lower()
        
        # 检查是否是PDF链接
        if '.pdf' in href.lower():
            # 优先选择原始PDF
            if 'original' in href.lower() or 'download' in link_text or 'pdf' in link_text:
                if href.startswith('http'):
                    pdf_url = href
                elif href.startswith('//'):
                    pdf_url = 'https:' + href
                elif href.startswith('/'):
                    pdf_url = 'https://patents.google.com' + href
                else:
                    pdf_url = 'https://patents.google.com/' + href
                break
    
    # 方法2: 如果没找到，尝试从专利存储服务获取
    if not pdf_url:
        # 提取国家代码和编号
        match = re.match(r'^([A-Z]{2})(\d+)([A-Z]\d?)?$', normalized_num)
        if match:
            country = match.group(1)
            number = match.group(2)
            kind_code = match.group(3) or ''
            
            # 中国专利 - 尝试从 CNIPA 获取
            if country == 'CN':
                # 中国专利PDF通常可以从 patents.google.com 的 CDN 获取
                pdf_url = f"https://patentimages.storage.googleapis.com/{normalized_num[:2].lower()}/{number[:4]}/{number[4:]}/{normalized_num}.pdf"
            
            # 美国专利
            elif country == 'US':
                pdf_url = f"https://patentimages.storage.googleapis.com/{number[:4]}/{number[4:6]}/{number[6:]}/{normalized_num}.pdf"
            
            # PCT专利
            elif country == 'WO':
                pdf_url = f"https://patentimages.storage.googleapis.com/{normalized_num[2:6]}/{normalized_num[6:8]}/{normalized_num[8:-2]}/{normalized_num}.pdf"
    
    # 获取专利标题
    title_elem = soup.find('h1', {'class': 'title'}) or soup.find('title')
    if title_elem:
        title = title_elem.get_text().strip()
        # 清理标题
        title = re.sub(r'\s*-\s*Google Patents\s*$', '', title)
        title = re.sub(r'\s+', ' ', title)
    
    if pdf_url:
        return {
            'success': True,
            'pdf_url': pdf_url,
            'title': title or normalized_num,
            'patent_url': patent_url
        }
    else:
        return {
            'success': False,
            'error': f'未找到PDF下载链接，请手动访问: {patent_url}'
        }


def download_pdf(pdf_url: str, output_path: Path, patent_num: str, proxies: dict = None) -> dict:
    """
    下载PDF文件
    
    参数:
        pdf_url: PDF下载链接
        output_path: 输出路径
        patent_num: 专利号
        proxies: 代理设置
    """
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    }
    
    try:
        response = requests.get(pdf_url, headers=headers, timeout=60, stream=True, proxies=proxies)
        response.raise_for_status()
        
        # 检查是否是PDF
        content_type = response.headers.get('Content-Type', '')
        if 'pdf' not in content_type.lower() and not pdf_url.lower().endswith('.pdf'):
            return {
                'success': False,
                'error': f'下载的不是PDF文件 (Content-Type: {content_type})'
            }
        
        # 写入文件
        with open(output_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                f.write(chunk)
        
        return {
            'success': True,
            'path': str(output_path),
            'size': output_path.stat().st_size
        }
        
    except requests.exceptions.RequestException as e:
        return {
            'success': False,
            'error': f'下载失败: {str(e)}'
        }


def main():
    parser = argparse.ArgumentParser(
        description='从Google Patents下载专利PDF原文',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
示例:
  # 下载单个专利
  %(prog)s CN123456789A
  %(prog)s US12345678B2
  
  # 指定输出目录
  %(prog)s CN123456789A -o ./patents
  
  # 使用代理
  %(prog)s CN123456789A --proxy 9981
  
  # 批量下载 (通过文件)
  %(prog)s --file patent_list.txt --proxy 9981

支持的专利号格式:
  - 中国专利: CN123456789A, CN123456789B
  - 美国专利: US12345678B2, US1234567
  - 欧洲专利: EP1234567A1, EP1234567B1
  - PCT专利: WO2023123456A1
  - 其他国家: JP, KR, DE, GB 等
        '''
    )
    
    parser.add_argument('patent_numbers', nargs='*', 
                        help='专利公开号/公告号 (可指定多个)')
    parser.add_argument('-o', '--output', default='.',
                        help='输出目录或文件路径 (默认: 当前目录)')
    parser.add_argument('-f', '--file', 
                        help='从文件读取专利号列表 (每行一个)')
    parser.add_argument('--open', action='store_true',
                        help='下载后打开PDF')
    parser.add_argument('--info', action='store_true',
                        help='只显示信息，不下载')
    parser.add_argument('--proxy', type=str, default=None,
                        help='代理端口或地址 (例如: 9981 或 http://127.0.0.1:9981)')
    
    args = parser.parse_args()
    
    # 设置代理
    proxies = None
    if args.proxy:
        if args.proxy.isdigit():
            proxy_url = f"http://127.0.0.1:{args.proxy}"
        else:
            proxy_url = args.proxy
        proxies = {
            'http': proxy_url,
            'https': proxy_url
        }
        print(f"使用代理: {proxy_url}")
    
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
    
    # 处理输出路径
    output_path = Path(args.output)
    if len(patent_numbers) == 1 and output_path.suffix.lower() == '.pdf':
        # 单个专利，指定了完整文件路径
        single_file = True
        output_dir = output_path.parent
        output_dir.mkdir(parents=True, exist_ok=True)
    else:
        # 多个专利或目录
        single_file = False
        output_dir = output_path
        output_dir.mkdir(parents=True, exist_ok=True)
    
    # 下载每个专利
    success_count = 0
    for i, patent_num in enumerate(patent_numbers, 1):
        normalized_num = normalize_patent_number(patent_num)
        print(f"\n[{i}/{len(patent_numbers)}] 处理: {patent_num} → {normalized_num}")
        
        # 获取PDF信息
        result = get_patent_pdf_url(patent_num, proxies)
        
        if not result['success']:
            print(f"  ❌ {result['error']}")
            continue
        
        print(f"  📄 标题: {result.get('title', 'N/A')}")
        print(f"  🔗 专利页: {result.get('patent_url', 'N/A')}")
        
        if args.info:
            print(f"  ℹ️  PDF链接: {result['pdf_url']}")
            continue
        
        print(f"  ⬇️  下载中...")
        
        # 确定输出文件名
        if single_file:
            file_path = output_path
        else:
            # 清理文件名中的非法字符
            safe_title = re.sub(r'[<>:"/\\|?*]', '', result.get('title', normalized_num))
            safe_title = safe_title[:80]  # 限制长度
            file_path = output_dir / f"{normalized_num}_{safe_title}.pdf"
        
        # 下载PDF
        download_result = download_pdf(result['pdf_url'], file_path, normalized_num, proxies)
        
        if download_result['success']:
            size_kb = download_result['size'] / 1024
            print(f"  ✅ 下载成功: {file_path} ({size_kb:.1f} KB)")
            success_count += 1
            
            if args.open:
                import subprocess
                subprocess.run(['open', str(file_path)])
        else:
            print(f"  ❌ {download_result['error']}")
    
    # 汇总
    print(f"\n{'='*50}")
    print(f"完成: {success_count}/{len(patent_numbers)} 个专利下载成功")
    
    if success_count < len(patent_numbers):
        sys.exit(1)


if __name__ == '__main__':
    main()
