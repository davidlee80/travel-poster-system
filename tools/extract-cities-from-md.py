#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从亚洲旅游景点 markdown 文件中提取城市信息，补充到 cities.json。

用法:
    python tools/extract-cities-from-md.py

输入:
    E:/Doc/Prompt/亚洲/*.md  (每个国家一个文件，Markdown 表格格式)

输出:
    apps/web/src/data/cities.json  (更新后的城市数据)

格式说明:
    md 文件的表格列:
    | 景点ID | 景点中文名 | 景点英文名 | 所在大洲 | 所在国家 | 所在城市 | 所属区域 | 经度 | 纬度 | ... |

    cities.json 的格式:
    {
      "code": "CN",
      "name": "中国",
      "cities": [
        { "id": "cn-beijing", "name": "北京", "lat": 39.9042, "lng": 116.4074 }
      ]
    }
"""

import json
import re
import sys
from pathlib import Path
from typing import Dict, List, Set, Tuple

# Windows 终端 emoji 兼容:设置 stdout 编码为 utf-8
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# 国家中文名 → ISO 3166-1 alpha-2 代码映射
COUNTRY_NAME_TO_CODE = {
    '中国': 'CN',
    '中国香港': 'CN',  # 香港归入中国
    '中国澳门': 'CN',  # 澳门归入中国
    '日本': 'JP',
    '韩国': 'KR',
    '泰国': 'TH',
    '新加坡': 'SG',
    '马来西亚': 'MY',
    '越南': 'VN',
    '印度尼西亚': 'ID',
    '菲律宾': 'PH',
    '印度': 'IN',
    '尼泊尔': 'NP',
    '斯里兰卡': 'LK',
    '马尔代夫': 'MV',
    '柬埔寨': 'KH',
    '老挝': 'LA',
    '缅甸': 'MM',
    '土耳其': 'TR',
    # 以下是亚洲文件夹里有但我们 cities.json 里没有的国家(可选添加)
    '不丹': 'BT',
    '东帝汶': 'TL',
    '乌兹别克斯坦': 'UZ',
    '也门': 'YE',
    '亚美尼亚': 'AM',
    '以色列': 'IL',
    '伊拉克': 'IQ',
    '伊朗': 'IR',
    '卡塔尔': 'QA',
    '叙利亚': 'SY',
    '吉尔吉斯斯坦': 'KG',
    '哈萨克斯坦': 'KZ',
    '土库曼斯坦': 'TM',
    '塔吉克斯坦': 'TJ',
    '塞浦路斯': 'CY',
    '孟加拉国': 'BD',
    '巴勒斯坦': 'PS',
    '巴基斯坦': 'PK',
    '巴林': 'BH',
    '文莱': 'BN',
    '朝鲜': 'KP',
    '格鲁吉亚': 'GE',
    '沙特阿拉伯': 'SA',
    '科威特': 'KW',
    '约旦': 'JO',
    '蒙古国': 'MN',
    '阿塞拜疆': 'AZ',
    '阿富汗': 'AF',
    '阿拉伯联合酋长国': 'AE',
    '阿曼': 'OM',
    '黎巴嫩': 'LB',
}

# 城市中文名 → 英文 slug 映射(用于生成城市 ID)
# 如果城市名不在映射里,会用拼音或英文名生成 slug
CITY_NAME_TO_SLUG = {
    '北京': 'beijing',
    '上海': 'shanghai',
    '广州': 'guangzhou',
    '深圳': 'shenzhen',
    '杭州': 'hangzhou',
    '成都': 'chengdu',
    '重庆': 'chongqing',
    '西安': 'xian',
    '南京': 'nanjing',
    '武汉': 'wuhan',
    '苏州': 'suzhou',
    '天津': 'tianjin',
    '青岛': 'qingdao',
    '大连': 'dalian',
    '厦门': 'xiamen',
    '昆明': 'kunming',
    '三亚': 'sanya',
    '拉萨': 'lhasa',
    '乌鲁木齐': 'urumqi',
    '哈尔滨': 'harbin',
    '沈阳': 'shenyang',
    '长春': 'changchun',
    '济南': 'jinan',
    '郑州': 'zhengzhou',
    '长沙': 'changsha',
    '南昌': 'nanchang',
    '福州': 'fuzhou',
    '合肥': 'hefei',
    '石家庄': 'shijiazhuang',
    '太原': 'taiyuan',
    '呼和浩特': 'hohhot',
    '兰州': 'lanzhou',
    '西宁': 'xining',
    '银川': 'yinchuan',
    '贵阳': 'guiyang',
    '南宁': 'nanning',
    '海口': 'haikou',
    '香港': 'hongkong',
    '澳门': 'macau',
    '台北': 'taipei',
    '东京': 'tokyo',
    '大阪': 'osaka',
    '京都': 'kyoto',
    '札幌': 'sapporo',
    '福冈': 'fukuoka',
    '名古屋': 'nagoya',
    '横滨': 'yokohama',
    '神户': 'kobe',
    '广岛': 'hiroshima',
    '仙台': 'sendai',
    '那霸': 'naha',
    '金泽': 'kanazawa',
    '高山': 'takayama',
    '奈良': 'nara',
    '日光': 'nikko',
    '首尔': 'seoul',
    '釜山': 'busan',
    '济州岛': 'jeju',
    '仁川': 'incheon',
    '大邱': 'daegu',
    '光州': 'gwangju',
    '大田': 'daejeon',
    '水原': 'suwon',
    '曼谷': 'bangkok',
    '清迈': 'chiangmai',
    '普吉岛': 'phuket',
    '芭提雅': 'pattaya',
    '甲米': 'krabi',
    '苏梅岛': 'samui',
    '华欣': 'huahin',
    '大城': 'ayutthaya',
    '新加坡': 'singapore',
    '吉隆坡': 'kualalumpur',
    '槟城': 'penang',
    '兰卡威': 'langkawi',
    '马六甲': 'malacca',
    '亚庇': 'kotakinabalu',
    '河内': 'hanoi',
    '胡志明市': 'hochiminh',
    '岘港': 'danang',
    '会安': 'hoian',
    '芽庄': 'nhatrang',
    '下龙湾': 'halong',
    '雅加达': 'jakarta',
    '巴厘岛': 'bali',
    '日惹': 'yogyakarta',
    '泗水': 'surabaya',
    '万隆': 'bandung',
    '马尼拉': 'manila',
    '宿务': 'cebu',
    '长滩岛': 'boracay',
    '巴拉望': 'palawan',
    '薄荷岛': 'bohol',
    '新德里': 'delhi',
    '孟买': 'mumbai',
    '斋浦尔': 'jaipur',
    '阿格拉': 'agra',
    '瓦拉纳西': 'varanasi',
    '果阿': 'goa',
    '喀拉拉邦': 'kerala',
    '乌代浦尔': 'udaipur',
    '阿姆利则': 'amritsar',
    '瑞诗凯诗': 'rishikesh',
    '加德满都': 'kathmandu',
    '博卡拉': 'pokhara',
    '巴克塔普尔': 'bhaktapur',
    '奇特旺': 'chitwan',
    '蓝毗尼': 'lumbini',
    '科伦坡': 'colombo',
    '康提': 'kandy',
    '加勒': 'galle',
    '锡吉里耶': 'sigiriya',
    '努沃勒埃利耶': 'nuwara-eliya',
    '米瑞莎': 'mirissa',
    '马累': 'male',
    '胡鲁马累': 'hulhumale',
    '马富士岛': 'maafushi',
    '暹粒': 'siem-reap',
    '金边': 'phnom-penh',
    '西哈努克': 'sihanoukville',
    '马德望': 'battambang',
    '琅勃拉邦': 'luang-prabang',
    '万象': 'vientiane',
    '万荣': 'vang-vieng',
    '巴色': 'pakse',
    '仰光': 'yangon',
    '蒲甘': 'bagan',
    '曼德勒': 'mandalay',
    '茵莱湖': 'inle-lake',
    '额布里': 'ngapali',
    '伊斯坦布尔': 'istanbul',
    '卡帕多奇亚': 'cappadocia',
    '安塔利亚': 'antalya',
    '棉花堡': 'pamukkale',
    '伊兹密尔': 'izmir',
    '博德鲁姆': 'bodrum',
}


def parse_md_file(md_path: Path) -> List[Dict[str, str]]:
    """解析一个 markdown 文件,提取景点信息"""
    with open(md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 匹配表格行(跳过表头和分隔线)
    rows = []
    for line in content.split('\n'):
        line = line.strip()
        if not line.startswith('|') or '---' in line or '景点ID' in line:
            continue

        # 分割单元格
        cells = [cell.strip() for cell in line.split('|')[1:-1]]
        if len(cells) < 9:
            continue

        rows.append({
            'attraction_id': cells[0],
            'attraction_name_zh': cells[1],
            'attraction_name_en': cells[2],
            'continent': cells[3],
            'country': cells[4],
            'city': cells[5],
            'region': cells[6],
            'lng': cells[7],
            'lat': cells[8],
        })

    return rows


def extract_cities(attractions: List[Dict[str, str]], country_code: str) -> Dict[str, Dict[str, float]]:
    """从景点列表中提取城市信息(去重,取第一个景点的经纬度)"""
    cities = {}
    for attr in attractions:
        city_name = attr['city'].strip()
        if not city_name or city_name in cities:
            continue

        try:
            lat = float(attr['lat'])
            lng = float(attr['lng'])
            cities[city_name] = {'lat': lat, 'lng': lng}
        except ValueError:
            print(f"⚠️  跳过无效坐标: {country_code} {city_name} ({attr['lng']}, {attr['lat']})")
            continue

    return cities


def generate_city_id(country_code: str, city_name: str) -> str:
    """生成城市 ID(英文 slug)"""
    # 优先用预定义的 slug
    slug = CITY_NAME_TO_SLUG.get(city_name)
    if slug:
        return f"{country_code.lower()}-{slug}"

    # 用 pypinyin 自动生成拼音 slug
    try:
        from pypinyin import pinyin, Style
        import re

        # 去掉括号、斜杠等特殊字符,只保留中文、英文、数字
        cleaned = re.sub(r'[^一-龥a-zA-Z0-9\s]', '', city_name)
        # 生成拼音(无声调,小写)
        pinyin_list = pinyin(cleaned, style=Style.NORMAL)
        slug = '-'.join([p[0] for p in pinyin_list if p[0]])
        # 空格转连字符,去掉连续的连字符
        slug = slug.replace(' ', '-').lower()
        slug = re.sub(r'-+', '-', slug).strip('-')

        # 如果 slug 为空或全是非 ASCII 字符,返回 None 表示需要手动补充
        if not slug or not slug.isascii():
            return None

        return f"{country_code.lower()}-{slug}"
    except ImportError:
        # pypinyin 未安装,返回 None
        return None


def merge_cities(
    existing_countries: List[Dict],
    new_cities_by_country: Dict[str, Dict[str, Dict[str, float]]],
) -> List[Dict]:
    """合并新城市到现有 cities.json"""
    # 按国家代码分组现有城市
    existing_by_code = {c['code']: c for c in existing_countries}

    for country_name, cities in new_cities_by_country.items():
        country_code = COUNTRY_NAME_TO_CODE.get(country_name)
        if not country_code:
            print(f"⚠️  跳过未映射的国家: {country_name}")
            continue

        if country_code not in existing_by_code:
            # 新国家,添加到列表
            print(f"➕ 新增国家: {country_name} ({country_code}), {len(cities)} 个城市")
            existing_by_code[country_code] = {
                'code': country_code,
                'name': country_name,
                'cities': []
            }

        country = existing_by_code[country_code]
        existing_city_ids = {c['id'] for c in country['cities']}
        existing_city_names = {c['name'] for c in country['cities']}

        added = 0
        skipped = 0
        for city_name, coords in cities.items():
            if city_name in existing_city_names:
                continue  # 城市已存在,跳过

            city_id = generate_city_id(country_code, city_name)
            if city_id is None:
                print(f"    ⚠️  跳过无英文 slug 的城市: {country_name} {city_name}(请手动补充到 CITY_NAME_TO_SLUG)")
                skipped += 1
                continue

            if city_id in existing_city_ids:
                # ID 冲突,加后缀
                i = 2
                while f"{city_id}-{i}" in existing_city_ids:
                    i += 1
                city_id = f"{city_id}-{i}"

            country['cities'].append({
                'id': city_id,
                'name': city_name,
                'lat': coords['lat'],
                'lng': coords['lng'],
            })
            existing_city_ids.add(city_id)
            existing_city_names.add(city_name)
            added += 1

        if added > 0 or skipped > 0:
            print(f"  ✓ {country_name}: 新增 {added} 个城市,跳过 {skipped} 个(现有 {len(country['cities'])} 个)")

    # 转换回列表,按国家代码排序
    return sorted(existing_by_code.values(), key=lambda c: c['code'])


def main():
    # 读取现有 cities.json
    cities_json_path = Path('apps/web/src/data/cities.json')
    with open(cities_json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    existing_countries = data['countries']
    print(f"📖 读取现有 cities.json: {len(existing_countries)} 个国家")

    # 解析所有 md 文件
    md_dir = Path('E:/Doc/Prompt/亚洲')
    if not md_dir.exists():
        print(f"❌ 目录不存在: {md_dir}")
        return

    md_files = sorted(md_dir.glob('*.md'))
    print(f"📂 找到 {len(md_files)} 个 markdown 文件")

    # 按国家分组提取城市
    new_cities_by_country = {}
    for md_file in md_files:
        print(f"  📄 解析 {md_file.name}...")
        attractions = parse_md_file(md_file)
        if not attractions:
            print(f"    ⚠️  未提取到景点数据")
            continue

        # 按国家分组(一个 md 文件可能包含多个城市,但应该只有一个国家)
        country_name = attractions[0]['country']
        cities = extract_cities(attractions, country_name)
        new_cities_by_country[country_name] = cities
        print(f"    ✓ 提取到 {len(cities)} 个城市")

    # 合并新城市
    print(f"\n🔄 合并新城市到 cities.json...")
    merged_countries = merge_cities(existing_countries, new_cities_by_country)

    # 统计
    total_cities_before = sum(len(c['cities']) for c in existing_countries)
    total_cities_after = sum(len(c['cities']) for c in merged_countries)
    added_cities = total_cities_after - total_cities_before

    # 更新 cities.json
    data['countries'] = merged_countries
    data['updated_at'] = '2026-09-08'

    # 备份原文件(在内存中深拷贝,避免引用问题)
    import copy
    backup_data = copy.deepcopy(data)
    backup_data['countries'] = copy.deepcopy(existing_countries)

    backup_path = cities_json_path.with_suffix('.json.bak')
    with open(backup_path, 'w', encoding='utf-8') as f:
        json.dump(backup_data, f, ensure_ascii=False, indent=2)
    print(f"💾 已备份原文件到: {backup_path}")

    # 写入新文件
    with open(cities_json_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n✅ 完成!")
    print(f"  原有: {len(existing_countries)} 个国家, {total_cities_before} 个城市")
    print(f"  现有: {len(merged_countries)} 个国家, {total_cities_after} 个城市")
    print(f"  新增: {added_cities} 个城市")


if __name__ == '__main__':
    main()
