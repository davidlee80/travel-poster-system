#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扩展 cities.json 的数据结构，添加搜索索引字段。

用法:
    python tools/extend-cities-data.py

输入:
    apps/web/src/data/cities.json  (现有城市数据)

输出:
    apps/web/src/data/cities.json  (扩展后的城市数据)

新增字段:
    - localName: 本地语言名(暂时与 name 相同,后续可手动补充)
    - aliases: 别名数组(暂时为空,后续可手动补充)
    - iata: 机场代码数组(暂时为空,后续可手动补充)
    - popularity: 热门程度(0-100,根据城市重要性估算)
    - searchText: 搜索索引(name + localName + aliases + iata + 拼音,全小写)
"""

import json
import sys
from pathlib import Path

# Windows 终端 emoji 兼容
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# 热门城市列表(用于估算 popularity)
POPULAR_CITIES = {
    # 中国一线城市
    '北京': 100, '上海': 100, '广州': 95, '深圳': 95,
    # 中国热门旅游城市
    '杭州': 90, '成都': 90, '西安': 88, '三亚': 85, '厦门': 85,
    # 国际热门城市
    '东京': 100, '大阪': 95, '首尔': 95, '曼谷': 90, '新加坡': 95,
    '巴黎': 100, '伦敦': 100, '纽约': 100, '洛杉矶': 95, '旧金山': 90,
    '迪拜': 90, '悉尼': 90, '墨尔本': 85,
    # 欧洲热门城市
    '罗马': 95, '巴塞罗那': 90, '阿姆斯特丹': 88, '维也纳': 85,
    '布拉格': 85, '雅典': 85, '圣托里尼': 90,
    # 东南亚热门
    '巴厘岛': 90, '普吉岛': 88, '清迈': 85, '河内': 80, '岘港': 80,
}


def estimate_popularity(city_name: str, country_code: str) -> int:
    """估算城市的热门程度(0-100)"""
    # 热门城市直接返回
    if city_name in POPULAR_CITIES:
        return POPULAR_CITIES[city_name]

    # 首都城市给 85-90 分
    capitals = {
        'CN': '北京', 'JP': '东京', 'KR': '首尔', 'TH': '曼谷', 'SG': '新加坡',
        'MY': '吉隆坡', 'VN': '河内', 'ID': '雅加达', 'PH': '马尼拉',
        'GB': '伦敦', 'FR': '巴黎', 'IT': '罗马', 'ES': '马德里', 'DE': '柏林',
        'CH': '苏黎世', 'AT': '维也纳', 'NL': '阿姆斯特丹', 'BE': '布鲁塞尔',
        'CZ': '布拉格', 'HU': '布达佩斯', 'PL': '华沙', 'GR': '雅典', 'PT': '里斯本',
        'US': '华盛顿', 'CA': '渥太华', 'AU': '堪培拉', 'NZ': '惠灵顿',
        'AE': '阿布扎比', 'TR': '安卡拉', 'EG': '开罗', 'MA': '拉巴特', 'ZA': '比勒陀利亚',
        'IN': '新德里', 'NP': '加德满都', 'LK': '科伦坡', 'MV': '马累', 'KH': '金边',
        'LA': '万象', 'MM': '内比都', 'MX': '墨西哥城', 'PE': '利马', 'AR': '布宜诺斯艾利斯',
        'CL': '圣地亚哥', 'BR': '巴西利亚', 'CU': '哈瓦那',
    }
    if country_code in capitals and city_name == capitals[country_code]:
        return 88

    # 其他城市默认 70 分
    return 70


def generate_search_text(city: dict, country_name: str) -> str:
    """生成搜索索引(全小写,包含所有可搜索的字段)"""
    parts = [
        city['name'],  # 中文名
        city.get('localName', city['name']),  # 本地语言名
        country_name,  # 国家名
    ]

    # 加别名
    if 'aliases' in city:
        parts.extend(city['aliases'])

    # 加机场代码
    if 'iata' in city:
        parts.extend(city['iata'])

    # 加拼音(用 pypinyin 生成)
    try:
        from pypinyin import pinyin, Style
        pinyin_list = pinyin(city['name'], style=Style.NORMAL)
        pinyin_str = ' '.join([p[0] for p in pinyin_list if p[0]])
        parts.append(pinyin_str)
        # 拼音首字母
        pinyin_initials = ''.join([p[0][0] for p in pinyin_list if p[0]])
        parts.append(pinyin_initials)
    except ImportError:
        pass

    return ' '.join(parts).lower()


def main():
    cities_json_path = Path('apps/web/src/data/cities.json')
    with open(cities_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    total_cities = 0
    for country in data['countries']:
        country_code = country['code']
        country_name = country['name']

        for city in country['cities']:
            # 添加 localName(暂时与 name 相同)
            if 'localName' not in city:
                city['localName'] = city['name']

            # 添加 aliases(暂时为空)
            if 'aliases' not in city:
                city['aliases'] = []

            # 添加 iata(暂时为空)
            if 'iata' not in city:
                city['iata'] = []

            # 添加 popularity
            if 'popularity' not in city:
                city['popularity'] = estimate_popularity(city['name'], country_code)

            # 添加 searchText
            city['searchText'] = generate_search_text(city, country_name)

            total_cities += 1

    # 更新版本号
    data['version'] = '1.1.0'
    data['updated_at'] = '2026-09-10'

    # 写入文件
    with open(cities_json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f'✅ 完成! 已扩展 {total_cities} 个城市的数据结构')
    print(f'   新增字段: localName / aliases / iata / popularity / searchText')
    print(f'   版本: 1.0.0 → 1.1.0')


if __name__ == '__main__':
    main()
