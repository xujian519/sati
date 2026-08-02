#!/usr/bin/env python3
"""
专利智能检索工具
支持技术方案理解、自动构建检索式、生成检索报告
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

try:
    from tabulate import tabulate
except ImportError:
    tabulate = None


# 默认配置
DEFAULT_OUTPUT_DIR = Path("~/Documents/云熙工作/专利检索").expanduser()
DEFAULT_NUM_RESULTS = 20
GOOGLE_PATENTS_URL = "https://patents.google.com/"


def extract_keywords_from_text(text: str) -> dict:
    """
    从技术描述中提取关键词
    
    注意：此函数仅做简单的关键词提取，
    实际使用时应由 AI 进行深度分析
    """
    # 提取中文术语（2-10个字符）
    words = re.findall(r'[\u4e00-\u9fa5]{2,10}', text)
    
    # 词频统计
    from collections import Counter
    word_freq = Counter(words)
    
    # 过滤常见停用词
    stopwords = {'所述', '其中', '进行', '可以', '设置', '通过', '根据', '包括', 
                 '具有', '以及', '或者', '一种', '本发明', '上述', '以下', '之间'}
    
    core_terms = [w for w, _ in word_freq.most_common(20) if w not in stopwords]
    
    return {
        'core_terms': core_terms[:10],
        'raw_text': text,
    }


def build_search_query(core_terms: list, synonyms: dict = None) -> str:
    """
    构建检索式
    
    参数:
        core_terms: 核心关键词列表
        synonyms: 同义词字典 {词: [同义词]}
    """
    if not core_terms:
        return ""
    
    query_parts = []
    
    for term in core_terms[:5]:
        if synonyms and term in synonyms:
            # 构建同义词组合
            syns = [term] + synonyms[term][:2]
            query_parts.append('(' + ' OR '.join(syns) + ')')
        else:
            query_parts.append(term)
    
    return ' AND '.join(query_parts)


def generate_search_url(query: str, num_results: int = 20) -> str:
    """生成 Google Patents 检索链接"""
    params = {
        'q': query,
        'num': num_results,
        'hl': 'zh-CN',
    }
    return f"{GOOGLE_PATENTS_URL}?{urlencode(params)}"


def generate_report(query: str, search_url: str, analysis: dict, 
                   output_dir: Path, num_results: int) -> Path:
    """生成检索报告"""
    output_dir.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_query = re.sub(r'[^\w\s-]', '', query)[:30].strip().replace(' ', '_')
    
    # Markdown 报告
    report_path = output_dir / f"检索报告_{timestamp}_{safe_query}.md"
    
    content = f"""# 专利检索报告

**检索时间**: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}  
**检索式**: `{query}`  
**检索链接**: [{search_url}]({search_url})  
**结果数量设置**: {num_results}

---

## 检索分析

### 输入描述

{analysis.get('raw_text', 'N/A')[:500]}...

### 提取的核心术语

{', '.join(analysis.get('core_terms', []))}

### 构建的检索式

```
{query}
```

### 检索策略说明

1. 从技术描述中提取核心术语
2. 构建布尔检索式（AND 连接主要术语）
3. 可根据需要在 Google Patents 中调整检索式

---

## 下一步操作

点击上方检索链接，在浏览器中查看检索结果。

如需下载专利 PDF，请告诉我：
- 下载全部
- 下载指定专利号（如：CN123456789A）
- 下载第 1-10 篇

---

*报告由云熙专利检索工具生成*
"""
    
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    # JSON 数据（供 AI 分析使用）
    json_path = output_dir / f"检索数据_{timestamp}_{safe_query}.json"
    data = {
        'timestamp': datetime.now().isoformat(),
        'query': query,
        'search_url': search_url,
        'num_results': num_results,
        'analysis': analysis,
        'patents': [],  # 待填充
    }
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    
    return report_path, json_path


def display_report_summary(query: str, search_url: str, analysis: dict):
    """显示报告摘要"""
    print("\n" + "="*70)
    print("📋 检索报告摘要")
    print("="*70)
    
    print(f"\n🔍 检索式: {query}")
    print(f"\n📊 核心术语: {', '.join(analysis.get('core_terms', [])[:5])}")
    
    print(f"\n🔗 检索链接:")
    print(f"   {search_url}")
    
    print("\n" + "-"*70)
    print("💡 请在浏览器中打开检索链接查看结果")
    print("   确认后，告诉我需要下载哪些专利")
    print("="*70)


def main():
    parser = argparse.ArgumentParser(
        description='专利智能检索工具 - 分析技术方案并构建检索式',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
示例:
  # 输入技术描述
  %(prog)s "一种基于深度学习的图像识别方法，包括数据预处理、特征提取和分类器训练"
  
  # 使用预构建的检索式
  %(prog)s --query "(深度学习 OR 神经网络) AND 图像识别"
  
  # 指定结果数量
  %(prog)s "骨髓腔输液装置" -n 50
        '''
    )
    
    parser.add_argument('description', nargs='?', help='技术方案描述')
    parser.add_argument('--query', '-q', type=str, help='直接使用检索式')
    parser.add_argument('-n', '--num', type=int, default=DEFAULT_NUM_RESULTS,
                        help=f'返回结果数量 (默认: {DEFAULT_NUM_RESULTS})')
    parser.add_argument('--output', '-o', type=str, default=None,
                        help='输出目录')
    
    args = parser.parse_args()
    
    if not args.description and not args.query:
        parser.print_help()
        print("\n错误: 请提供技术描述或检索式")
        sys.exit(1)
    
    output_dir = Path(args.output) if args.output else DEFAULT_OUTPUT_DIR
    
    print("\n" + "="*70)
    print("🔍 专利智能检索")
    print("="*70)
    
    # 分析和构建检索式
    if args.query:
        query = args.query
        analysis = {
            'raw_text': '使用用户提供的检索式',
            'core_terms': re.findall(r'[\u4e00-\u9fa5]{2,10}', args.query)[:5],
        }
        print(f"\n📝 使用检索式: {query}")
    else:
        print(f"\n📝 分析技术描述...")
        analysis = extract_keywords_from_text(args.description)
        query = build_search_query(analysis['core_terms'])
        print(f"   提取术语: {', '.join(analysis['core_terms'][:5])}")
        print(f"   构建检索式: {query}")
    
    # 生成检索链接
    search_url = generate_search_url(query, args.num)
    
    # 生成报告
    report_path, json_path = generate_report(query, search_url, analysis, output_dir, args.num)
    
    # 显示摘要
    display_report_summary(query, search_url, analysis)
    
    print(f"\n📄 报告已保存: {report_path}")
    print(f"📊 数据已保存: {json_path}")
    
    print("\n✅ 检索完成！请在浏览器中查看结果，确认后告诉我需要下载哪些专利。")


if __name__ == '__main__':
    main()
