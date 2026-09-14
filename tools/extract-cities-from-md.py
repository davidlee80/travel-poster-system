#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从旅游景点 Markdown 提取城市，国家数据唯一保存，大洲索引引用。

用法:
    python -m pip install pypinyin
    python tools/extract-cities-from-md.py "E:/Doc/Prompt/亚洲" --dry-run
    python tools/extract-cities-from-md.py "E:/Doc/Prompt/亚洲"

名称补全: Markdown 中的国家代码/城市英文名 → Wikidata 联网查询 → 拼音兜底。
联网查询单次超时 10 秒；无结果、有歧义或网络失败时使用拼音。

输入:
    E:/Doc/Prompt/亚洲/*.md  (每个国家一个文件，Markdown 表格格式)

输出:
    apps/web/public/data/countries/<所在国家>.json（包含该国全部城市）
    apps/web/public/data/<大洲英文名>/index.json（引用相关国家）
    apps/web/public/data/index.json  (国家索引，不含城市明细)

输出目录自动创建。国家和城市来自 Markdown，不预加载旧 cities.json。
重复导入时增量合并已生成的国家文件，保持已有城市 ID。
备份和中断恢复记录位于 tmp/city-data-backups/。dry-run 不创建目录或文件。

格式说明:
    md 文件的表格列:
    | 景点ID | 景点中文名 | 景点英文名 | 所在大洲 | 所在国家 | 所在城市 | 所属区域 | 经度 | 纬度 | ... |
    可选列: 国家代码（或 country_code）、城市英文名（或 city_en）。
    有表头时按列名读取，可调整列序；无表头时使用上述前九列，额外列不猜测含义。
    也支持“国家中文名（CN）”和“城市中文名（English）”；景点英文名不当作城市英文名。

    国家 JSON 的格式:
    {
      "code": "CN",
      "name": "中国",
      "continents": ["Asia"],
      "cities": [
        { "id": "cn-beijing", "name": "北京", "continents": ["Asia"], "lat": 39.9042, "lng": 116.4074 }
      ]
    }
"""

import copy
import hashlib
import json
import math
import os
import re
import shutil
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Dict, List
from urllib.parse import urlencode
from urllib.request import Request, urlopen

# Windows 终端 emoji 兼容:设置 stdout 编码为 utf-8
if sys.platform == 'win32' and __name__ == '__main__':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# 大洲是固定的目录分类；国家和城市不预置名称或代码映射。
CONTINENTS = {
    '亚洲': 'Asia', '欧洲': 'Europe', '非洲': 'Africa',
    '北美洲': 'NorthAmerica', '南美洲': 'SouthAmerica',
    '大洋洲': 'Oceania', '南极洲': 'Antarctica',
}


def continent_directory(name):
    name = validate_name(name)
    if name in CONTINENTS:
        return CONTINENTS[name]
    normalized = re.sub(r'[\s_-]+', '', name).casefold()
    for english in CONTINENTS.values():
        if normalized == english.casefold():
            return english
    raise ValueError(f'无法识别大洲: {name}，请使用七大洲的中文或英文名称')


class Progress:
    """交互终端刷新同一行；重定向输出保留普通进度行。"""

    def __init__(self, total, stream=None):
        self.total = total
        self.done = 0
        self.stream = stream or sys.stdout
        self.interactive = self.stream.isatty()
        self.line_width = 0

    def clear(self):
        if self.interactive and self.line_width:
            self.stream.write('\r' + ' ' * self.line_width + '\r')
            self.line_width = 0

    def draw(self):
        width = max(4, min(30, shutil.get_terminal_size((80, 24)).columns - 30))
        ratio = self.done / self.total if self.total else 0
        filled = int(width * ratio)
        line = f"处理进度 [{'#' * filled}{'-' * (width - filled)}] {int(ratio * 100)}%  {self.done}/{self.total}"
        self.clear()
        self.stream.write(line + ('' if self.interactive else '\n'))
        self.stream.flush()
        self.line_width = len(line) + 4  # 中文显示宽度

    def advance(self):
        self.done += 1
        self.draw()

    def log(self, message):
        self.clear()
        self.stream.write(str(message) + '\n')
        if self.interactive:
            self.draw()
        self.stream.flush()

    def finish(self):
        if self.interactive:
            self.stream.write('\n')
            self.stream.flush()
        self.line_width = 0


_progress = None


def log(message):
    if _progress is not None:
        _progress.log(message)
    else:
        print(message, flush=True)


def parse_md_file(md_path: Path) -> List[Dict[str, str]]:
    """解析一个 markdown 文件,提取景点信息"""
    with open(md_path, 'r', encoding='utf-8-sig') as f:
        content = f.read()

    aliases = {
        'attraction_id': ('景点id', 'attraction_id'),
        'attraction_name_zh': ('景点中文名', 'attraction_name_zh'),
        'attraction_name_en': ('景点英文名', 'attraction_name_en'),
        'continent': ('所在大洲', '大洲', 'continent'),
        'country': ('所在国家', '国家', '国家中文名', 'country'),
        'city': ('所在城市', '城市', '城市中文名', 'city'),
        'region': ('所属区域', '区域', 'region'),
        'lng': ('经度', 'lng', 'longitude'),
        'lat': ('纬度', 'lat', 'latitude'),
        'country_code': ('国家代码', '国家code', '国家缩写', '国家缩略code', 'country_code', 'iso_code'),
        'city_en': ('城市英文名', '城市英文名称', '所在城市英文名', 'city_en', 'city_name_en'),
    }
    columns = None
    rows = []
    for line in content.split('\n'):
        line = line.strip()
        if not line.startswith('|'):
            continue
        cells = [cell.strip() for cell in line.strip('|').split('|')]
        if all(re.fullmatch(r':?-+:?', cell) for cell in cells):
            continue
        headings = [re.sub(r'\s+', '', cell.strip('*')).lower() for cell in cells]
        detected = {key: i for key, names in aliases.items() for i, heading in enumerate(headings) if heading in names}
        required = {'continent', 'country', 'city', 'lng', 'lat'}
        if required.issubset(detected):
            columns = detected
            continue
        if columns is None:
            if len(cells) < 9:
                continue
            fields = list(aliases)[:9]
            row = dict(zip(fields, cells[:9]))
        else:
            if len(cells) <= max(columns[key] for key in required):
                raise ValueError('表格数据行缺少大洲、国家、城市或坐标列')
            row = {key: cells[i] if i < len(cells) else '' for key, i in columns.items()}
        for key in ('country_code', 'city_en'):
            row[key] = row.get(key, '').strip()
            if row[key].lower() in ('-', '--', '—', 'n/a', 'none', '无'):
                row[key] = ''
        # 中文后括号内的英文属于城市名称，而不是景点的英文名称。
        inline = re.fullmatch(r'(.+?)\s*[（(]([A-Za-z][A-Za-z .\x27-]*)[）)]', row['city'])
        if inline:
            city_name, english_name = (part.strip() for part in inline.groups())
            if row['city_en'] and row['city_en'].casefold() != english_name.casefold():
                raise ValueError(f'{city_name} 的城市英文名与括号内容不一致')
            row['city'], row['city_en'] = city_name, english_name
        inline_code = re.fullmatch(r'(.+?)\s*[（(]([A-Za-z]{2})[）)]', row['country'])
        if inline_code:
            country_name, code = (part.strip() for part in inline_code.groups())
            if row['country_code'] and row['country_code'].upper() != code.upper():
                raise ValueError(f'{country_name} 的国家代码与括号内容不一致')
            row['country'], row['country_code'] = country_name, code.upper()
        rows.append(row)

    return rows


def extract_cities(attractions: List[Dict[str, str]], country_code: str) -> Dict[str, Dict]:
    """从景点列表中提取城市信息(去重,取第一个景点的经纬度)"""
    cities = {}
    for attr in attractions:
        city_name = attr['city'].strip()
        if not city_name:
            continue
        try:
            lat = float(attr['lat'])
            lng = float(attr['lng'])
            if not (math.isfinite(lat) and math.isfinite(lng) and -90 <= lat <= 90 and -180 <= lng <= 180):
                raise ValueError('坐标超出范围')
        except ValueError:
            log(f"⚠️  跳过无效坐标: {country_code} {city_name} ({attr['lng']}, {attr['lat']})")
            continue
        continent = continent_directory(attr['continent'])
        english_name = attr.get('city_en', '').strip()
        if city_name in cities:
            previous = cities[city_name].get('city_en', '')
            if previous and english_name and previous.casefold() != english_name.casefold():
                raise ValueError(f'{city_name} 的城市英文名不一致')
            if english_name:
                cities[city_name]['city_en'] = english_name
            cities[city_name]['continents'] = sorted(set(cities[city_name]['continents']) | {continent})
            continue
        cities[city_name] = {'lat': lat, 'lng': lng, 'continents': [continent]}
        if english_name:
            cities[city_name]['city_en'] = english_name

    return cities


def wikidata_names(name: str) -> str:
    """生成 SPARQL 名称字面量，同时查询中英文标签和别名。"""
    literal = json.dumps(name, ensure_ascii=False)
    return ' '.join(f'{literal}@{lang}' for lang in ('zh', 'zh-cn', 'zh-hans', 'en'))


@lru_cache(maxsize=512)
def lookup_online(name: str, country_name: str = '', country_code: str = '') -> str:
    """查询国家 ISO code 或指定国家内的城市英文名；失败或歧义返回空串。"""
    if country_name or country_code:
        if re.fullmatch(r'[A-Z]{2}', country_code):
            country_filter = f'?country wdt:P297 {json.dumps(country_code)} .'
        else:
            country_filter = (
                f'VALUES ?countryName {{ {wikidata_names(country_name)} }} '
                '?country (rdfs:label|skos:altLabel) ?countryName .'
            )
        selection = (
            '?place rdfs:label ?value . FILTER(LANG(?value) = "en") '
            'FILTER EXISTS { ?place wdt:P17 ?country . ' + country_filter + ' }'
            'FILTER EXISTS { ?place wdt:P31/wdt:P279* <http://www.wikidata.org/entity/Q486972> . '
            'hint:Prior hint:gearing "forward" . }'
        )
    else:
        selection = '?place wdt:P297 ?value . FILTER(REGEX(STR(?value), "^[A-Z]{2}$"))'

    # 固定从名称开始匹配，避免查询优化器先扫描全库英文标签。
    query = '''
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX hint: <http://www.bigdata.com/queryHints#>
SELECT DISTINCT ?value WHERE {
hint:Query hint:optimizer "None" .
''' + f'VALUES ?name {{ {wikidata_names(name)} }}\n' + '''
?place (rdfs:label|skos:altLabel) ?name .
''' + selection + '\n} LIMIT 2'
    request = Request(
        'https://query.wikidata.org/sparql?' + urlencode({'query': query, 'format': 'json'}),
        headers={
            'Accept': 'application/sparql-results+json',
            'User-Agent': 'TravelPosterCityExtractor/1.0 (Python urllib)',
        },
    )
    log(f'    🌐 正在联网补全: {country_name} {name}'.strip())
    try:
        with urlopen(request, timeout=10) as response:
            result = json.load(response)
        values = {row['value']['value'] for row in result['results']['bindings']}
        if len(values) == 1:
            value = next(iter(values)).strip()
            if country_name or country_code or re.fullmatch(r'[A-Z]{2}', value):
                log(f'    🌐 联网查询: {name} → {value}')
                return value
        candidates = ', '.join(sorted(values)) or '无结果'
        log(f'    ⚠️  联网未找到唯一匹配: {name} ({candidates})，使用拼音兜底')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        log(f'    ⚠️  联网查询失败: {name} ({exc})，使用拼音兜底')
    return ''


def generate_pinyin_slug(name: str) -> str:
    """将名称转为无声调拼音 slug，英文和数字原样保留。"""
    try:
        from pypinyin import pinyin, Style
    except ImportError as exc:
        raise SystemExit('缺少拼音依赖，请先运行: python -m pip install pypinyin') from exc

    cleaned = re.sub(r'[^一-龥a-zA-Z0-9\s]', '', name)
    pinyin_list = pinyin(cleaned, style=Style.NORMAL)
    slug = '-'.join(p[0] for p in pinyin_list if p[0])
    slug = re.sub(r'-+', '-', re.sub(r'\s+', '-', slug.lower())).strip('-')
    if not slug or not slug.isascii():
        raise ValueError(f'无法生成拼音标识，请在 Markdown 中补充国家代码或城市英文名: {name}')
    return slug


def english_slug(name):
    if not name or re.search(r'[\u3400-\u9fff]', name):
        return ''
    ascii_name = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode('ascii')
    return re.sub(r'[^a-z0-9]+', '-', ascii_name.lower()).strip('-')


def generate_city_id(country_code: str, city_name: str, country_name: str = '', city_en: str = '') -> str:
    """优先使用 Markdown 英文名，其次联网查询，最后拼音兜底。"""
    slug = english_slug(city_en) or english_slug(city_name)
    if not slug:
        english_name = lookup_online(city_name, country_name, country_code)
        slug = english_slug(english_name)
    slug = slug or generate_pinyin_slug(city_name)
    return f"{country_code.lower()}-{slug}"


def validate_name(name):
    """名称直接用于 Windows 文件名；拒绝路径跳转和非法字符。"""
    if not isinstance(name, str) or not name.strip():
        raise ValueError('大洲或国家名称为空')
    name = name.strip()
    if (name in ('.', '..') or re.search(r'[<>:"/\\|?*\x00-\x1f]', name)
            or name.endswith('.') or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', name, re.I)):
        raise ValueError(f'不能用于目录或文件名: {name}')
    return name


def data_path(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or path == root.resolve():
        raise ValueError(f'输出路径越界: {relative}')
    return path


def country_relative(country):
    return f"countries/{validate_name(country['name'])}.json"


def normalize_country(country):
    """把旧单一大洲记录转换为多大洲记录，保留名称、ID 和坐标。"""
    country = copy.deepcopy(country)
    legacy_continent = country.pop('continent', None)
    fallback = country.get('continents', [legacy_continent] if legacy_continent else [])
    if not isinstance(fallback, list):
        raise ValueError('国家 continents 必须是数组')
    country['continents'] = sorted({continent_directory(c) for c in fallback})
    for city in country['cities']:
        values = city.get('continents', country['continents'])
        if not isinstance(values, list):
            raise ValueError('城市 continents 必须是数组')
        city['continents'] = sorted({continent_directory(c) for c in values})
    return country


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8')


def validate_country(country, require_continent=False):
    validate_name(country['name'])
    if not isinstance(country['code'], str) or not re.fullmatch(r'[A-Za-z0-9-]+', country['code']):
        raise ValueError(f"无效国家 code: {country['code']}")
    if require_continent:
        if not country.get('continents'):
            raise ValueError('国家缺少大洲信息')
        if country['continents'] != sorted({continent_directory(c) for c in country['continents']}):
            raise ValueError('国家 continents 必须是去重排序的英文大洲名称')
    ids, names = set(), set()
    for city in country['cities']:
        if require_continent:
            if not city.get('continents') or city['continents'] != sorted({continent_directory(c) for c in city['continents']}):
                raise ValueError('城市 continents 必须是非空、去重排序的英文大洲名称')
        if not isinstance(city['id'], str) or not city['id'] or not isinstance(city['name'], str) or not city['name']:
            raise ValueError('城市 ID 或名称为空')
        if city['id'] in ids or city['name'] in names:
            raise ValueError(f"国家 {country['name']} 存在重复城市 ID 或名称")
        if not (-90 <= float(city['lat']) <= 90 and -180 <= float(city['lng']) <= 180):
            raise ValueError(f"城市 {city['name']} 坐标无效")
        ids.add(city['id'])
        names.add(city['name'])
    if require_continent and country['cities']:
        expected = sorted({c for city in country['cities'] for c in city['continents']})
        if country['continents'] != expected:
            raise ValueError('国家与城市大洲关联不一致')
    json_bytes(country)


class CountryStore:
    """运行中复用国家索引，每次只复制正在合并的国家。"""

    def __init__(self, countries):
        self.by_code, self.by_name = {}, {}
        for country in countries:
            country = normalize_country(country)
            validate_country(country, bool(country.get('continents')))
            if country['code'] in self.by_code or country['name'] in self.by_name:
                raise ValueError(f"重复国家: {country['name']}")
            self.by_code[country['code']] = copy.deepcopy(country)
            self.by_name[country['name']] = country['code']

    def merge(self, country_name, cities, continent=None, country_code=''):
        country_name = validate_name(country_name)
        supplied_code = country_code.strip().upper()
        if supplied_code and not re.fullmatch(r'[A-Z]{2}', supplied_code):
            raise ValueError(f'Markdown 国家代码必须是两位英文字母: {country_code}')
        previous_code = self.by_name.get(country_name)
        if supplied_code and previous_code and supplied_code != previous_code:
            raise ValueError(f'{country_name} 国家代码冲突: 已有 {previous_code}，Markdown 为 {supplied_code}')
        code = supplied_code or previous_code
        code = code or lookup_online(country_name)
        if not code:
            base = generate_pinyin_slug(country_name).upper()
            code, suffix = base, 2
            while code in self.by_code:
                code = f'{base}-{suffix}'
                suffix += 1
        existing = self.by_code.get(code)
        canonical_name = existing['name'] if existing else country_name
        fallback = [continent_directory(continent)] if continent is not None else []
        country = copy.deepcopy(existing) if existing else {'code': code, 'name': canonical_name, 'continents': [], 'cities': []}
        city_ids = {city['id'] for city in country['cities']}
        city_by_name = {city['name']: city for city in country['cities']}
        added = skipped = 0
        for name, coords in cities.items():
            continents = sorted({continent_directory(c) for c in coords.get('continents', fallback)})
            if name in city_by_name:
                city = city_by_name[name]
                city['continents'] = sorted(set(city['continents']) | set(continents))
                continue
            try:
                city_id = generate_city_id(code, name, country_name, coords.get('city_en', ''))
            except ValueError as exc:
                log(f'    ⚠️  {country_name}: {exc}')
                skipped += 1
                continue
            base_id, suffix = city_id, 2
            while city_id in city_ids:
                city_id = f'{base_id}-{suffix}'
                suffix += 1
            city = {'id': city_id, 'name': name, 'continents': continents, 'lat': coords['lat'], 'lng': coords['lng']}
            country['cities'].append(city)
            city_ids.add(city_id)
            city_by_name[name] = city
            added += 1
        country['continents'] = sorted({c for city in country['cities'] for c in city['continents']})
        validate_country(country, bool(country['continents']))
        # 全部通过后才提交该文件的合并结果。
        self.by_code[code] = country
        self.by_name[country_name] = code
        self.by_name[canonical_name] = code
        log(f"  ✓ {canonical_name}: 新增 {added} 个城市, 跳过 {skipped} 个（现有 {len(country['cities'])} 个）")
        return country

    def countries(self):
        return sorted(self.by_code.values(), key=lambda country: country['code'])


def merge_cities(existing_countries, new_cities_by_country):
    """独立合并入口；命令行在所有文件间复用 CountryStore。"""
    store = CountryStore(existing_countries)
    for country_name, cities in new_cities_by_country.items():
        store.merge(country_name, cities)
    return store.countries()


def build_data_files(countries):
    """国家数据只有一份；大洲文件只包含导航引用和该洲城市数量。"""
    files, entries, paths = {}, [], set()
    for source in sorted(countries, key=lambda c: c['code']):
        country = normalize_country(source)
        validate_country(country, True)
        relative = country_relative(country)
        if relative.casefold() in paths:
            raise ValueError(f'国家输出路径冲突: {relative}')
        paths.add(relative.casefold())
        payload = json_bytes(country)
        files[relative] = payload
        entries.append({
            'code': country['code'], 'name': country['name'],
            'continents': country['continents'], 'city_count': len(country['cities']),
            'data_file': relative, 'revision': hashlib.sha256(payload).hexdigest(),
        })
    continent_entries = []
    for continent in sorted({c for entry in entries for c in entry['continents']}):
        related = []
        for entry in entries:
            if continent not in entry['continents']:
                continue
            country = json.loads(files[entry['data_file']])
            count = sum(continent in city['continents'] for city in country['cities'])
            related.append({
                'code': entry['code'], 'name': entry['name'],
                # 所有索引 data_file 都相对于 data 根目录，而非索引所在目录。
                'data_file': entry['data_file'], 'revision': entry['revision'],
                'city_count': count, 'total_city_count': entry['city_count'],
            })
        relative = f'{continent}/index.json'
        payload = json_bytes({'schema_version': 3, 'continent': continent, 'countries': related})
        files[relative] = payload
        continent_entries.append({
            'name': continent, 'country_count': len(related),
            'city_count': sum(entry['city_count'] for entry in related),
            'data_file': relative, 'revision': hashlib.sha256(payload).hexdigest(),
        })
    return files, entries, continent_entries


def load_countries(root):
    countries = {}
    index_path = root / 'index.json'
    if not index_path.exists():
        return []
    index = json.loads(index_path.read_text(encoding='utf-8'))
    version = index.get('schema_version')
    if version not in (2, 3):
        raise ValueError('不支持的国家索引版本')
    for entry in index['countries']:
        path = data_path(root, entry['data_file'])
        payload = path.read_bytes()
        source = json.loads(payload)
        if version == 2:
            continent = continent_directory(source['continent'])
            expected_paths = (
                f"{continent}/{source['name']}.json",
                f"{source['continent']}/{source['name']}.json",
            )
            if source['continent'] != entry['continent'] or entry['data_file'] not in expected_paths:
                raise ValueError(f'旧索引与国家文件不一致: {path}')
            country = normalize_country(source)
        else:
            country = source
            if country['continents'] != entry['continents'] or country_relative(country) != entry['data_file']:
                raise ValueError(f'索引与国家文件不一致: {path}')
        validate_country(country, True)
        if (country['code'] != entry['code'] or country['name'] != entry['name']
                or len(country['cities']) != entry['city_count']):
            raise ValueError(f'索引与国家文件不一致: {path}')
        if country['code'] in countries:
            raise ValueError(f"索引重复国家: {country['code']}")
        if hashlib.sha256(payload).hexdigest() != entry['revision']:
            raise ValueError(f'国家文件内容摘要不匹配: {path}')
        countries[country['code']] = country

    if version == 3:
        expected_files, expected_countries, expected_continents = build_data_files(countries.values())
        if index['countries'] != expected_countries or index['continents'] != expected_continents:
            raise ValueError('总索引与国家/大洲关系不一致')
        for entry in index['continents']:
            path = data_path(root, entry['data_file'])
            if path.read_bytes() != expected_files[entry['data_file']]:
                raise ValueError(f'大洲索引与国家数据不一致: {path}')
    return list(countries.values())


def prepare_output(countries, root):
    files, entries, continent_entries = build_data_files(countries)
    for relative in files:
        data_path(root, relative)
    index = {
        'schema_version': 3, 'updated_at': datetime.now(timezone.utc).isoformat(),
        'countries': entries, 'continents': continent_entries,
    }
    index_path = root / 'index.json'
    if index_path.exists():
        old_index = json.loads(index_path.read_text(encoding='utf-8'))
        if (old_index.get('schema_version') == 3 and old_index['countries'] == entries
                and old_index.get('continents') == continent_entries):
            index['updated_at'] = old_index['updated_at']
        # 旧版国家文件或不再使用的大洲索引在同一事务中撤回。
        new_paths = set(files)
        for entry in old_index['countries'] + old_index.get('continents', []):
            if entry['data_file'] not in new_paths:
                files[entry['data_file']] = None
    files['index.json'] = json_bytes(index)
    return files


def atomic_write(path, payload):
    """同目录暂存再替换，避免写出截断 JSON。"""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.city-', suffix='.tmp', delete=False) as f:
            temporary = Path(f.name)
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def restore_transaction(root, backup, manifest):
    for relative in reversed(manifest['changed']):
        target = data_path(root, relative)
        previous = data_path(backup / 'original', relative)
        if relative in manifest['existed']:
            target.parent.mkdir(parents=True, exist_ok=True)
            atomic_write(target, previous.read_bytes())
        elif target.exists():
            target.unlink()
    for relative in reversed(manifest['created_dirs']):
        directory = root.resolve() if relative == '.' else data_path(root, relative)
        if directory.exists():
            try:
                directory.rmdir()  # 仅移除本次创建的空目录
            except OSError:
                pass


def recover_pending(root, backup_root, dry_run=False):
    journal = backup_root / 'pending.json'
    if not journal.exists():
        return
    if dry_run:
        raise ValueError(f'存在未完成写入: {journal}；请先不带 --dry-run 运行以恢复')
    manifest = json.loads(journal.read_text(encoding='utf-8'))
    if manifest['output_root'] != str(root.resolve()):
        raise ValueError('恢复记录的输出目录与本次运行不一致')
    backup = data_path(backup_root, manifest['backup_dir'])
    restore_transaction(root, backup, manifest)
    journal.unlink()
    log(f'已恢复上次中断前的数据，备份: {backup}')


def save_output(root, files, backup_root):
    changed = [relative for relative, payload in files.items()
               if not data_path(root, relative).exists() or data_path(root, relative).read_bytes() != payload]
    if not changed:
        log('数据无变化，无需写入')
        return
    changed.sort(key=lambda relative: (2 if relative == 'index.json' else int(files[relative] is None), relative))
    backup_root.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix=datetime.now().strftime('%Y%m%d-%H%M%S-'), dir=backup_root))
    stage = backup / 'staged'
    original = backup / 'original'
    existed = []
    for relative in changed:
        if files[relative] is None:
            continue
        staged_path = data_path(stage, relative)
        staged_path.parent.mkdir(parents=True, exist_ok=True)
        staged_path.write_bytes(files[relative])
        json.loads(staged_path.read_bytes())
    # 备份旧索引及其全部引用文件。
    snapshot = set(changed)
    index_path = root / 'index.json'
    if index_path.exists():
        index = json.loads(index_path.read_text(encoding='utf-8'))
        snapshot.update(entry['data_file'] for entry in index['countries'] + index.get('continents', []))
    for relative in snapshot:
        target = data_path(root, relative)
        if target.exists():
            previous = data_path(original, relative)
            previous.parent.mkdir(parents=True, exist_ok=True)
            previous.write_bytes(target.read_bytes())
            if relative in changed:
                existed.append(relative)
    created_dirs = set()
    for relative in changed:
        directory = data_path(root, relative).parent
        while directory.is_relative_to(root.resolve()) and not directory.exists():
            created_dirs.add(directory.relative_to(root.resolve()).as_posix())
            directory = directory.parent
    manifest = {
        'output_root': str(root.resolve()), 'backup_dir': backup.name,
        'changed': changed, 'existed': existed,
        'created_dirs': sorted(created_dirs, key=lambda value: (value.count('/'), value)),
    }
    (backup / 'transaction.json').write_bytes(json_bytes(manifest))
    journal = backup_root / 'pending.json'
    atomic_write(journal, json_bytes(manifest))
    try:
        for relative in changed:
            target = data_path(root, relative)
            if files[relative] is None:
                if target.exists():
                    target.unlink()
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                atomic_write(target, data_path(stage, relative).read_bytes())
    except BaseException:
        restore_transaction(root, backup, manifest)
        journal.unlink()
        raise
    journal.unlink()
    for relative in changed:
        if files[relative] is None:
            directory = data_path(root, relative).parent
            if directory != root.resolve():
                try:
                    directory.rmdir()  # 仅清理迁移后已空的大洲目录
                except OSError:
                    pass
    saved = sum(relative.startswith('countries/') and files[relative] is not None for relative in changed)
    log(f'已保存 {saved} 个国家文件并更新关联索引；备份: {backup}')


def collect_md_files(paths):
    files, errors = set(), 0
    for path_str in paths:
        path = Path(path_str)
        try:
            if not path.exists():
                log(f'⚠️  路径不存在: {path}')
                errors += 1
            elif path.is_file() and path.suffix.lower() == '.md':
                files.add(path.resolve())
            elif path.is_dir():
                files.update(p.resolve() for p in path.iterdir() if p.is_file() and p.suffix.lower() == '.md')
            else:
                log(f'⚠️  跳过非 Markdown 文件: {path}')
        except OSError as exc:
            log(f'⚠️  无法读取路径 {path}: {exc}')
            errors += 1
    return sorted(files), errors


def main():
    import argparse
    global _progress

    parser = argparse.ArgumentParser(description='从 Markdown 导入城市，生成国家唯一文件及大洲索引，支持跨洲')
    parser.add_argument('paths', nargs='+', help='大洲目录或单个 Markdown 文件（支持多个路径）')
    parser.add_argument('--dry-run', action='store_true', help='预览进度和新增统计，不创建目录、备份或数据文件')
    args = parser.parse_args()
    root = Path('apps/web/public/data').resolve()
    backup_root = Path('tmp/city-data-backups').resolve()
    md_files, path_errors = collect_md_files(args.paths)
    log(f'发现 {len(md_files)} 个 Markdown 文件')
    if not md_files:
        log('未找到可处理的 Markdown 文件')
        return 1 if path_errors else 0

    recover_pending(root, backup_root, args.dry_run)
    store = CountryStore(load_countries(root))
    before_countries = len(store.by_code)
    before_cities = sum(len(c['cities']) for c in store.by_code.values())
    log(f'读取已有数据: {before_countries} 个国家, {before_cities} 个城市')
    success = empty = failed = 0
    progress = Progress(len(md_files))
    _progress = progress
    progress.draw()
    try:
        for md_file in md_files:
            try:
                log(f'正在处理: {md_file.name} · 解析与补全')
                rows = parse_md_file(md_file)
                if not rows:
                    empty += 1
                    log(f'  空文件或无景点表格: {md_file}')
                    continue
                country_names = {validate_name(row['country']) for row in rows}
                if len(country_names) != 1:
                    raise ValueError('一个 Markdown 文件必须只包含一个国家（允许多个大洲）')
                country_name = next(iter(country_names))
                continents = sorted({continent_directory(row['continent']) for row in rows})
                codes = {row['country_code'].upper() for row in rows if row['country_code']}
                if len(codes) > 1:
                    raise ValueError('同一国家的 Markdown 国家代码不一致')
                log('  涉及大洲: ' + '、'.join(continents) + '（以表格内容为准）')
                cities = extract_cities(rows, country_name)
                if not cities:
                    raise ValueError('未找到有有效坐标的城市')
                data_path(root, f'countries/{country_name}.json')
                country = store.merge(country_name, cities, country_code=next(iter(codes), ''))
                log(f"  输出: {root / country_relative(country)}")
                success += 1
            except (OSError, ValueError, KeyError, TypeError) as exc:
                failed += 1
                log(f'  ❌ 文件处理失败: {md_file} ({exc})')
            finally:
                progress.advance()
    finally:
        progress.finish()
        _progress = None

    countries = store.countries()
    after_cities = sum(len(c['cities']) for c in countries)
    if success:
        log('正在校验数据……' if args.dry_run else '正在校验并保存数据……')
        files = prepare_output(countries, root)
        if not args.dry_run:
            save_output(root, files, backup_root)
    label = 'DRY-RUN 预览结束（未写入）' if args.dry_run else '完成'
    if failed or path_errors:
        label += '，但存在失败项'
    log(f'{label}: 成功 {success} 个，空文件 {empty} 个，失败 {failed} 个，路径错误 {path_errors} 个')
    log(f'  原有: {before_countries} 个国家, {before_cities} 个城市')
    log(f'  {"预计" if args.dry_run else "现有"}: {len(countries)} 个国家, {after_cities} 个城市')
    log(f'  {"预计新增" if args.dry_run else "新增"}: {len(countries) - before_countries} 个国家, {after_cities - before_cities} 个城市')
    return 1 if failed or path_errors else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError) as exc:
        log(f'❌ 处理终止，未成功完成: {exc}')
        sys.exit(1)
