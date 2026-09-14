"""运行: python -m unittest discover -s tools -p test_extract_cities_from_md.py"""

import importlib.util
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError
from urllib.parse import parse_qs, urlparse


SCRIPT = Path(__file__).with_name('extract-cities-from-md.py').resolve()


class ExtractCitiesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / 'apps/web/src/data/cities.json'
        self.target.parent.mkdir(parents=True)
        self.original = {
            'updated_at': '2026-01-01',
            'countries': [{'code': 'CN', 'name': '中国', 'cities': [
                {'id': 'cn-beijing', 'name': '北京', 'lat': 39.9, 'lng': 116.4},
            ]}],
        }
        self.target.write_text(json.dumps(self.original), encoding='utf-8')
        self.output = self.root / 'apps/web/public/data'
        self.source = self.root / 'input'
        self.source.mkdir()

    def write_row(self, filename, country, city, continent='亚洲', country_code='', city_en=''):
        path = self.source / filename
        header = '| 景点ID | 景点中文名 | 景点英文名 | 所在大洲 | 所在国家 | 所在城市 | 所属区域 | 经度 | 纬度 | 国家代码 | 城市英文名 |\n'
        path.write_text(
            (header if country_code or city_en else '')
            + f'| 1 | 景点 | Attraction | {continent} | {country} | {city} | 区域 | 116.4 | 39.9 | {country_code} | {city_en} |\n',
            encoding='utf-8',
        )
        return path

    def run_script(self, *args, expected_code=0):
        # CLI 回归固定模拟断网，确保测试不依赖外部服务。
        runner = '''
import runpy, sys
from unittest.mock import patch
from urllib.error import URLError
with patch('urllib.request.urlopen', side_effect=URLError('offline test')):
    sys.argv = sys.argv[1:]
    runpy.run_path(sys.argv[0], run_name='__main__')
'''
        result = subprocess.run(
            [sys.executable, '-c', runner, str(SCRIPT), *map(str, args)],
            cwd=self.root, capture_output=True, encoding='utf-8',
        )
        self.assertEqual(result.returncode, expected_code, result.stdout + result.stderr)
        return result.stdout

    def read_country(self, continent, country):
        data = json.loads((self.output / 'countries' / f'{country}.json').read_text(encoding='utf-8'))
        self.assertIn(continent, data['continents'])
        return data

    def test_filter_fallback_counts_backup_and_repeat(self):
        self.write_row('a.md', '中国', '上海')
        upper_md = self.write_row('b.MD', '中国', '杭州')
        self.write_row('c.md', '法国', '巴黎', '欧洲')
        ignored = self.write_row('ignored.txt', '德国', '柏林')
        self.write_row('ignored.json', '德国', '柏林')
        (self.source / 'directory.md').mkdir()

        output = self.run_script(self.source, upper_md, ignored)
        self.assertIn('发现 3 个 Markdown 文件', output)
        self.assertIn('0%  0/3', output)
        self.assertIn('100%  3/3', output)
        self.assertLess(output.index('100%  3/3'), output.index('正在校验并保存'))
        self.assertIn('新增: 2 个国家, 3 个城市', output)
        china = self.read_country('Asia', '中国')
        france = self.read_country('Europe', '法国')
        countries = {c['code']: c for c in (china, france)}
        self.assertEqual(set(countries), {'ZHONG-GUO', 'FA-GUO'})
        self.assertEqual({c['name'] for c in countries['ZHONG-GUO']['cities']}, {'上海', '杭州'})
        self.assertEqual(countries['FA-GUO']['cities'][0]['id'], 'fa-guo-ba-li')
        self.assertEqual(json.loads(self.target.read_text(encoding='utf-8')), self.original)
        index = json.loads((self.output / 'index.json').read_text(encoding='utf-8'))
        self.assertTrue(all('cities' not in c for c in index['countries']))
        snapshot = {p: p.read_bytes() for p in self.output.rglob('*.json')}

        self.assertIn('新增: 0 个国家, 0 个城市', self.run_script(self.source))
        self.assertEqual({p: p.read_bytes() for p in self.output.rglob('*.json')}, snapshot)

    def test_dry_run_counts_without_writing(self):
        self.write_row('a.md', '中国', '上海')
        self.write_row('b.md', '法国', '巴黎')
        before = self.target.read_bytes()
        output = self.run_script(self.source, '--dry-run')
        self.assertIn('新增: 2 个国家, 2 个城市', output)
        self.assertEqual(self.target.read_bytes(), before)
        self.assertFalse(self.target.with_suffix('.json.bak').exists())
        self.assertFalse(self.output.exists())
        self.assertFalse((self.root / 'tmp').exists())

    def test_reuse_existing_country_code(self):
        self.write_row('a.md', '法国', '巴黎', '欧洲', country_code='FR')
        self.assertIn('新增: 1 个国家, 1 个城市', self.run_script(self.source))
        france = self.read_country('Europe', '法国')
        self.assertEqual(france['cities'][0]['id'], 'fr-ba-li')
        self.write_row('b.md', '法国', '里昂', '欧洲', city_en='Lyon')
        self.assertIn('新增: 0 个国家, 1 个城市', self.run_script(self.source))
        self.assertEqual(self.read_country('Europe', '法国')['cities'][1]['id'], 'fr-lyon')

    def test_legacy_is_ignored_and_existing_outputs_preserved(self):
        self.original['countries'].append({'code': 'JP', 'name': '日本', 'cities': [
            {'id': 'historic-tokyo', 'name': '东京', 'lat': 35.6, 'lng': 139.7},
        ]})
        self.target.write_text(json.dumps(self.original), encoding='utf-8')
        china_md = self.write_row('renamed.md', '中国', '上海')
        self.run_script(china_md)
        index = json.loads((self.output / 'index.json').read_text(encoding='utf-8'))
        self.assertNotIn('pending_legacy_countries', index)
        self.assertEqual(len(index['countries']), 1)
        china_before = (self.output / 'countries/中国.json').read_bytes()
        japan_md = self.write_row('japan.md', '日本', '大阪')
        self.run_script(japan_md)
        self.assertEqual((self.output / 'countries/中国.json').read_bytes(), china_before)
        japan = self.read_country('Asia', '日本')
        self.assertEqual(japan['cities'][0]['id'], 'ri-ben-da-ban')
        self.assertEqual(len(japan['cities']), 1)
        index = json.loads((self.output / 'index.json').read_text(encoding='utf-8'))
        self.assertEqual(len(index['countries']), 2)

    def test_failures_and_empty_files_still_finish_progress(self):
        self.write_row('good.md', '中国', '上海')
        mixed = self.write_row('mixed.md', '法国', '巴黎', '欧洲')
        mixed.write_text(mixed.read_text(encoding='utf-8') + '| 2 | A | A | 亚洲 | 日本 | 东京 | A | 139 | 35 |\n', encoding='utf-8')
        (self.source / 'empty.md').write_text('# 空文件', encoding='utf-8')
        (self.source / 'broken.md').write_bytes(b'\xff\xff')
        output = self.run_script(self.source, expected_code=1)
        self.assertIn('100%  4/4', output)
        self.assertIn('成功 1 个，空文件 1 个，失败 2 个', output)
        self.assertFalse((self.output / 'Europe').exists())

    def test_country_can_gain_another_continent_without_copying_data(self):
        path = self.write_row('a.md', '中国', '上海')
        self.run_script(path)
        original = self.read_country('Asia', '中国')['cities'][0]
        path = self.write_row('a.md', '中国', '杭州', '欧洲')
        self.assertIn('新增: 0 个国家, 1 个城市', self.run_script(path))
        country = self.read_country('Europe', '中国')
        self.assertEqual(country['continents'], ['Asia', 'Europe'])
        self.assertEqual(country['cities'][0], original)
        self.assertEqual(len(list((self.output / 'countries').glob('*.json'))), 1)
        self.assertTrue((self.output / 'Europe/index.json').exists())

    def test_aliases_use_one_country_file(self):
        self.write_row('a.md', '测试国', '香港', country_code='ZZ')
        self.write_row('b.md', '测试别名', '澳门', country_code='ZZ')
        self.run_script(self.source)
        self.assertEqual([p.name for p in (self.output / 'countries').glob('*.json')], ['测试国.json'])
        self.assertEqual(len(self.read_country('Asia', '测试国')['cities']), 2)

    def test_reject_unsafe_paths_without_creating_directories(self):
        for continent, country in (('../escape', '中国'), ('亚洲', '../escape'), ('CON', '中国')):
            path = self.write_row('bad.md', country, '北京', continent)
            self.run_script(path, expected_code=1)
            self.assertFalse(self.output.exists())

    def test_no_markdown_does_not_create_output(self):
        self.write_row('ignored.txt', '中国', '上海')
        self.assertIn('发现 0 个 Markdown 文件', self.run_script(self.source))
        self.assertFalse(self.output.exists())

    def test_changed_file_has_full_snapshot_backup(self):
        path = self.write_row('a.md', '中国', '上海')
        self.run_script(path)
        country_before = (self.output / 'countries/中国.json').read_bytes()
        index_before = (self.output / 'index.json').read_bytes()
        self.write_row('a.md', '中国', '杭州')
        self.run_script(path)
        originals = list((self.root / 'tmp/city-data-backups').glob('*/original'))
        self.assertEqual(len(originals), 1)
        self.assertEqual((originals[0] / 'countries/中国.json').read_bytes(), country_before)
        self.assertEqual((originals[0] / 'index.json').read_bytes(), index_before)
        self.assertEqual(len(self.read_country('Asia', '中国')['cities']), 2)

    def test_markdown_code_and_city_english_need_no_network(self):
        self.write_row('a.md', '中国', '北京', country_code='cn', city_en='Beijing')
        output = self.run_script(self.source)
        self.assertNotIn('联网', output)
        country = self.read_country('Asia', '中国')
        self.assertEqual(country['code'], 'CN')
        self.assertEqual(country['cities'][0]['id'], 'cn-beijing')
        self.assertEqual(len(country['cities']), 1)

    def test_inline_names_need_no_network(self):
        self.write_row('a.md', '中国（CN）', '北京（Beijing）', 'Asia')
        self.assertNotIn('联网', self.run_script(self.source))
        self.assertEqual(self.read_country('Asia', '中国')['cities'][0]['id'], 'cn-beijing')

    def test_reordered_columns_and_later_city_english(self):
        path = self.source / 'reordered.md'
        path.write_text(
            '| 城市 | 纬度 | 国家代码 | 国家 | 城市英文名 | 经度 | 大洲 |\n'
            '| --- | --- | --- | --- | --- | --- | --- |\n'
            '| 蒙特利尔 | 45.5 | CA | 加拿大 | — | -73.5 | North America |\n'
            '| 蒙特利尔 | 46 | CA | 加拿大 | Montréal | -74 | North America |\n',
            encoding='utf-8',
        )
        self.assertNotIn('联网', self.run_script(path))
        city = self.read_country('NorthAmerica', '加拿大')['cities'][0]
        self.assertEqual(city['id'], 'ca-montreal')
        self.assertEqual(city['lat'], 45.5)

    def test_conflicting_markdown_codes_fail_without_output(self):
        path = self.write_row('a.md', '中国', '北京', country_code='CN')
        with path.open('a', encoding='utf-8') as stream:
            stream.write('| 2 | 景点 | Attraction | 亚洲 | 中国 | 上海 | 区域 | 121 | 31 | JP | Shanghai |\n')
        self.assertIn('国家代码不一致', self.run_script(path, expected_code=1))
        self.assertFalse(self.output.exists())

    def test_one_markdown_can_contain_cross_continent_cities(self):
        path = self.write_row('cross.md', '示例国', '城市甲', '亚洲', country_code='XX', city_en='Alpha')
        with path.open('a', encoding='utf-8') as stream:
            stream.write('| 2 | 景点 | Attraction | Europe | 示例国 | 城市乙 | 区域 | 30 | 40 | XX | Beta |\n')
            stream.write('| 3 | 景点 | Attraction | 亚洲 | 示例国 | 城市乙 | 区域 | 31 | 41 | XX | Beta |\n')
        output = self.run_script(path)
        self.assertIn('新增: 1 个国家, 2 个城市', output)
        country = self.read_country('Asia', '示例国')
        self.assertEqual(country['continents'], ['Asia', 'Europe'])
        self.assertEqual(country['cities'][0]['continents'], ['Asia'])
        self.assertEqual(country['cities'][1]['continents'], ['Asia', 'Europe'])
        self.assertEqual(country['cities'][1]['lat'], 40)
        references = []
        for continent, count in [('Asia', 2), ('Europe', 1)]:
            index = json.loads((self.output / continent / 'index.json').read_text(encoding='utf-8'))
            self.assertEqual(index['countries'][0]['city_count'], count)
            self.assertEqual(index['countries'][0]['total_city_count'], 2)
            self.assertNotIn('cities', index['countries'][0])
            references.append(index['countries'][0]['data_file'])
        self.assertEqual(references, ['countries/示例国.json', 'countries/示例国.json'])
        self.assertEqual(len(list((self.output / 'countries').glob('*.json'))), 1)
        before = {p: p.read_bytes() for p in self.output.rglob('*.json')}
        self.assertIn('新增: 0 个国家, 0 个城市', self.run_script(path))
        self.assertEqual(before, {p: p.read_bytes() for p in self.output.rglob('*.json')})

    def test_new_continent_association_keeps_city_id_and_counts(self):
        path = self.write_row('cross.md', '示例国', '城市甲', '亚洲', country_code='XX', city_en='Alpha')
        self.run_script(path)
        original = self.read_country('Asia', '示例国')['cities'][0]
        self.write_row('cross.md', '示例国', '城市甲', '欧洲', country_code='XX', city_en='Different English')
        self.assertIn('新增: 0 个国家, 0 个城市', self.run_script(path))
        city = self.read_country('Europe', '示例国')['cities'][0]
        self.assertEqual(city['id'], original['id'])
        self.assertEqual(city['lat'], original['lat'])
        self.assertEqual(city['continents'], ['Asia', 'Europe'])

    def test_cross_continent_dry_run_does_not_change_existing_files(self):
        path = self.write_row('cross.md', '示例国', '城市甲', '亚洲', country_code='XX', city_en='Alpha')
        self.run_script(path)
        before = {p: p.read_bytes() for p in self.output.rglob('*.json')}
        self.write_row('cross.md', '示例国', '城市乙', '欧洲', country_code='XX', city_en='Beta')
        self.assertIn('预计新增: 0 个国家, 1 个城市', self.run_script(path, '--dry-run'))
        self.assertEqual(before, {p: p.read_bytes() for p in self.output.rglob('*.json')})
        self.assertFalse((self.output / 'Europe').exists())


class StorageAndProgressTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('extract_cities', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'data'
        self.backups = Path(self.temp.name) / 'backups'
        self.china = {'code': 'CN', 'name': '中国', 'continent': '亚洲', 'cities': [
            {'id': 'cn-beijing', 'name': '北京', 'lat': 39.9, 'lng': 116.4},
        ]}

    def prepare(self, countries):
        return self.module.prepare_output(countries, self.root)

    def test_write_failure_rolls_back_all_changed_files(self):
        files = self.prepare([self.china])
        self.module.save_output(self.root, files, self.backups)
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*.json')}
        self.china['cities'].append({'id': 'cn-shanghai', 'name': '上海', 'lat': 31.2, 'lng': 121.5})
        france = {'code': 'FR', 'name': '法国', 'continent': '欧洲', 'cities': []}
        updated = self.prepare([self.china, france])
        real_write = self.module.atomic_write
        failed = False

        def fail_index_once(path, payload):
            nonlocal failed
            if path == self.root / 'index.json' and not failed:
                failed = True
                raise OSError('simulated disk error')
            real_write(path, payload)

        with patch.object(self.module, 'atomic_write', side_effect=fail_index_once):
            with self.assertRaises(OSError):
                self.module.save_output(self.root, updated, self.backups)
        self.assertEqual({p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*.json')}, before)
        self.assertFalse((self.root / 'Europe').exists())
        self.assertFalse((self.backups / 'pending.json').exists())

    def test_interrupted_write_can_be_recovered_and_dry_run_does_not_recover(self):
        files = self.prepare([self.china])
        real_write = self.module.atomic_write

        def fail_index(path, payload):
            if path == self.root / 'index.json':
                raise OSError('interrupted')
            real_write(path, payload)

        with patch.object(self.module, 'atomic_write', side_effect=fail_index), patch.object(
            self.module, 'restore_transaction', side_effect=RuntimeError('process stopped before rollback'),
        ):
            with self.assertRaises(RuntimeError):
                self.module.save_output(self.root, files, self.backups)
        country_path = self.root / 'countries/中国.json'
        self.assertTrue(country_path.exists())
        with self.assertRaisesRegex(ValueError, '未完成写入'):
            self.module.recover_pending(self.root, self.backups, dry_run=True)
        self.assertTrue(country_path.exists())
        self.module.recover_pending(self.root, self.backups)
        self.assertFalse(self.root.exists())
        self.assertFalse((self.backups / 'pending.json').exists())

    def test_directory_creation_failure_does_not_report_success(self):
        files = self.prepare([self.china])
        self.root.mkdir()
        (self.root / 'Asia').write_text('not a directory', encoding='utf-8')
        with self.assertRaises(OSError):
            self.module.save_output(self.root, files, self.backups)
        self.assertFalse((self.root / 'index.json').exists())
        self.assertEqual((self.root / 'Asia').read_text(encoding='utf-8'), 'not a directory')

    def test_tty_logs_redraw_progress_and_finish_with_newline(self):
        class Terminal(io.StringIO):
            def isatty(self):
                return True
        stream = Terminal()
        progress = self.module.Progress(2, stream)
        progress.draw()
        progress.log('正在联网查询')
        progress.advance()
        progress.advance()
        progress.finish()
        output = stream.getvalue()
        self.assertIn('\r', output)
        self.assertIn('正在联网查询\n', output)
        self.assertIn('50%  1/2', output)
        self.assertTrue(output.endswith('100%  2/2\n'))

    def test_non_tty_progress_has_no_control_characters_or_early_100_percent(self):
        stream = io.StringIO()
        progress = self.module.Progress(200, stream)
        progress.done = 199
        progress.draw()
        self.assertIn('99%  199/200', stream.getvalue())
        self.assertNotIn('\r', stream.getvalue())
        self.assertNotIn('\x1b', stream.getvalue())

    def make_old_chinese_directory(self):
        payload = self.module.json_bytes(self.china)
        index = {'schema_version': 2, 'updated_at': '2026-01-01', 'countries': [{
            'code': 'CN', 'name': '中国', 'continent': '亚洲', 'city_count': 1,
            'data_file': '亚洲/中国.json', 'revision': hashlib.sha256(payload).hexdigest(),
        }]}
        files = {'亚洲/中国.json': payload, 'index.json': self.module.json_bytes(index)}
        self.module.save_output(self.root, files, self.backups)

    def test_chinese_continent_directory_is_migrated_once(self):
        self.make_old_chinese_directory()
        countries = self.module.load_countries(self.root)
        files = self.prepare(countries)
        self.module.save_output(self.root, files, self.backups)
        self.assertFalse((self.root / '亚洲').exists())
        self.assertTrue((self.root / 'countries/中国.json').exists())
        self.assertEqual(self.module.load_countries(self.root), countries)
        self.assertNotIn('亚洲/中国.json', self.prepare(countries))

    def test_directory_migration_failure_restores_old_file(self):
        self.make_old_chinese_directory()
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*.json')}
        files = self.prepare(self.module.load_countries(self.root))
        real_write = self.module.atomic_write
        failed = False

        def fail_index_once(path, payload):
            nonlocal failed
            if path == self.root / 'index.json' and not failed:
                failed = True
                raise OSError('migration failed')
            real_write(path, payload)

        with patch.object(self.module, 'atomic_write', side_effect=fail_index_once):
            with self.assertRaises(OSError):
                self.module.save_output(self.root, files, self.backups)
        self.assertEqual({p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*.json')}, before)
        self.assertFalse((self.root / 'Asia').exists())

    def test_all_continent_directories_are_english(self):
        expected = ('Asia', 'Europe', 'Africa', 'NorthAmerica', 'SouthAmerica', 'Oceania', 'Antarctica')
        for chinese, english in zip(('亚洲', '欧洲', '非洲', '北美洲', '南美洲', '大洋洲', '南极洲'), expected):
            self.assertEqual(self.module.continent_directory(chinese), english)
            self.assertEqual(self.module.continent_directory(english.lower()), english)

    def test_invalid_continent_index_is_detected(self):
        self.module.save_output(self.root, self.prepare([self.china]), self.backups)
        index_path = self.root / 'Asia/index.json'
        index = json.loads(index_path.read_text(encoding='utf-8'))
        index['countries'][0]['city_count'] = 100
        index_path.write_bytes(self.module.json_bytes(index))
        with self.assertRaisesRegex(ValueError, '大洲索引'):
            self.module.load_countries(self.root)

    def test_cross_continent_write_failure_restores_country_and_both_indexes(self):
        self.module.save_output(self.root, self.prepare([self.china]), self.backups)
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*.json')}
        country = self.module.load_countries(self.root)[0]
        country['continents'] = ['Asia', 'Europe']
        country['cities'][0]['continents'] = ['Asia', 'Europe']
        files = self.prepare([country])
        real_write = self.module.atomic_write
        failed = False

        def fail_index_once(path, payload):
            nonlocal failed
            if path == self.root / 'index.json' and not failed:
                failed = True
                raise OSError('cross continent commit failed')
            real_write(path, payload)

        with patch.object(self.module, 'atomic_write', side_effect=fail_index_once):
            with self.assertRaises(OSError):
                self.module.save_output(self.root, files, self.backups)
        self.assertEqual(before, {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*.json')})
        self.assertFalse((self.root / 'Europe').exists())
        self.module.load_countries(self.root)


class OnlineLookupTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('extract_cities', SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def response(self, *values):
        return io.BytesIO(json.dumps({'results': {'bindings': [
            {'value': {'value': value}} for value in values
        ]}}).encode())

    def test_online_country_and_city_before_pinyin(self):
        with patch.object(self.module, 'urlopen', side_effect=[
            self.response('FR'), self.response('Paris'),
        ]) as request, patch.object(self.module, 'generate_pinyin_slug') as pinyin:
            countries = self.module.merge_cities([], {'法国': {'巴黎': {'lat': 48.85, 'lng': 2.35}}})
        self.assertEqual(countries[0]['code'], 'FR')
        self.assertEqual(countries[0]['cities'][0]['id'], 'fr-paris')
        pinyin.assert_not_called()
        query = parse_qs(urlparse(request.call_args.args[0].full_url).query)['query'][0]
        self.assertIn('?country wdt:P297 "FR"', query)
        self.assertEqual(request.call_args.kwargs['timeout'], 10)

    def test_markdown_english_name_avoids_network(self):
        with patch.object(self.module, 'urlopen') as request:
            self.assertEqual(self.module.generate_city_id('CN', '北京', '中国', 'Beijing'), 'cn-beijing')
        request.assert_not_called()

    def test_even_common_names_are_searched_without_predefined_mapping(self):
        with patch.object(self.module, 'lookup_online', side_effect=['CN', 'Beijing']) as lookup:
            countries = self.module.merge_cities([], {'中国': {'北京': {'lat': 39.9, 'lng': 116.4}}})
        self.assertEqual(lookup.call_args_list[0].args, ('中国',))
        self.assertEqual(lookup.call_args_list[1].args, ('北京', '中国', 'CN'))
        self.assertEqual(countries[0]['cities'][0]['id'], 'cn-beijing')
        self.assertFalse(hasattr(self.module, 'COUNTRY_NAME_TO_CODE'))
        self.assertFalse(hasattr(self.module, 'CITY_NAME_TO_SLUG'))

    def test_no_results_uses_pinyin(self):
        with patch.object(self.module, 'urlopen', side_effect=[self.response(), self.response()]):
            countries = self.module.merge_cities([], {'法国': {'巴黎': {'lat': 48.85, 'lng': 2.35}}})
        self.assertEqual(countries[0]['code'], 'FA-GUO')
        self.assertEqual(countries[0]['cities'][0]['id'], 'fa-guo-ba-li')

    def test_ambiguous_results_use_pinyin(self):
        with patch.object(self.module, 'urlopen', return_value=self.response('Paris', 'Other Paris')):
            self.assertEqual(self.module.generate_city_id('FR', '巴黎', '法国'), 'fr-ba-li')

    def test_network_and_invalid_response_use_pinyin(self):
        for error in (URLError('offline'), TimeoutError('timeout'), ValueError('invalid JSON')):
            with self.subTest(error=error), patch.object(self.module, 'urlopen', side_effect=error):
                self.module.lookup_online.cache_clear()
                self.assertEqual(self.module.generate_city_id('FR', '巴黎', '法国'), 'fr-ba-li')

    def test_cache_and_country_scoping(self):
        with patch.object(self.module, 'urlopen', side_effect=[self.response('Paris'), self.response('Paris')]) as request:
            self.module.generate_city_id('FR', '巴黎', '法国')
            self.module.generate_city_id('FR', '巴黎', '法国')
            self.module.generate_city_id('US', '巴黎', '美国')
        self.assertEqual(request.call_count, 2)


if __name__ == '__main__':
    unittest.main()
