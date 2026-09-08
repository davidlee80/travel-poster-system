# 城市数据 JSON 格式规范

> **版本**：1.0.0
> **更新日期**：2026-09-08
> **用途**：为旅行应用的目的地选择器提供预置的城市数据，供 AI 自动生成新数据时遵循

---

## 一、文件结构（完整 Schema）

```json
{
  "version": "1.0.0",
  "updated_at": "2026-09-08",
  "countries": [
    {
      "code": "CN",
      "name": "中国",
      "cities": [
        {
          "id": "cn-beijing",
          "name": "北京",
          "lat": 39.9042,
          "lng": 116.4074
        }
      ]
    }
  ]
}
```

---

## 二、字段规范（详细说明）

### 2.1 顶层字段

| 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `version` | string | ✅ | 数据版本号，语义化版本（用于数据迁移） | `"1.0.0"` |
| `updated_at` | string | ✅ | 数据更新日期，ISO 8601 日期格式（YYYY-MM-DD） | `"2026-09-08"` |
| `countries` | array | ✅ | 国家列表，按大洲/区域分组排序 | 见下 |

---

### 2.2 国家对象（Country）

| 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `code` | string | ✅ | **ISO 3166-1 alpha-2 国家代码**（2 个大写字母），跨境判定读它 | `"CN"` / `"JP"` / `"US"` |
| `name` | string | ✅ | 国家中文名称（用于界面显示） | `"中国"` / `"日本"` / `"美国"` |
| `cities` | array | ✅ | 城市列表，按城市重要性/知名度排序 | 见下 |

**排序规则**：
- 国家按**大洲 → 区域 → 国家重要性**排序（亚洲 → 欧洲 → 北美 → 大洋洲 → 中东 → 非洲 → 南美 → 中美）
- 同一大洲内，按**国家代码字母序**排列（便于查找）

---

### 2.3 城市对象（City）

| 字段 | 类型 | 必填 | 说明 | 示例 |
|------|------|------|------|------|
| `id` | string | ✅ | **城市唯一标识符**，格式：`{country_code}-{city_slug}`，全小写，用连字符分隔 | `"cn-beijing"` / `"jp-tokyo"` / `"us-newyork"` |
| `name` | string | ✅ | 城市中文名称（用于界面显示） | `"北京"` / `"东京"` / `"纽约"` |
| `lat` | number | ✅ | 纬度，WGS84 坐标系，保留 4 位小数 | `39.9042` |
| `lng` | number | ✅ | 经度，WGS84 坐标系，保留 4 位小数 | `116.4074` |

**ID 命名规则**：
- 格式：`{country_code}-{city_english_name}`
- 全小写
- 空格用连字符 `-` 替代（如 `new-york`）
- 特殊字符去掉（如 `são-paulo` → `sao-paulo`）
- 示例：
  - `cn-hongkong`（香港）
  - `us-san-francisco`（旧金山）
  - `br-rio-de-janeiro`（里约热内卢，可简化为 `br-rio`）

**城市选择标准**（AI 生成时遵循）：
- **优先收录**：首都、直辖市、省会、热门旅游城市、知名景点城市
- **每个国家 5-20 个城市**（小国 1-5 个，大国 10-20 个）
- **中国**：40 个城市（直辖市 + 省会 + 热门旅游城市）
- **其他国家**：5-15 个城市（首都 + 主要旅游城市）

---

## 三、完整示例（可直接用于 AI 生成）

```json
{
  "version": "1.0.0",
  "updated_at": "2026-09-08",
  "countries": [
    {
      "code": "CN",
      "name": "中国",
      "cities": [
        { "id": "cn-beijing", "name": "北京", "lat": 39.9042, "lng": 116.4074 },
        { "id": "cn-shanghai", "name": "上海", "lat": 31.2304, "lng": 121.4737 },
        { "id": "cn-guangzhou", "name": "广州", "lat": 23.1291, "lng": 113.2644 },
        { "id": "cn-shenzhen", "name": "深圳", "lat": 22.5431, "lng": 114.0579 },
        { "id": "cn-hangzhou", "name": "杭州", "lat": 30.2741, "lng": 120.1551 }
      ]
    },
    {
      "code": "JP",
      "name": "日本",
      "cities": [
        { "id": "jp-tokyo", "name": "东京", "lat": 35.6762, "lng": 139.6503 },
        { "id": "jp-osaka", "name": "大阪", "lat": 34.6937, "lng": 135.5023 },
        { "id": "jp-kyoto", "name": "京都", "lat": 35.0116, "lng": 135.7681 },
        { "id": "jp-sapporo", "name": "札幌", "lat": 43.0618, "lng": 141.3545 },
        { "id": "jp-fukuoka", "name": "福冈", "lat": 33.5904, "lng": 130.4017 }
      ]
    },
    {
      "code": "US",
      "name": "美国",
      "cities": [
        { "id": "us-newyork", "name": "纽约", "lat": 40.7128, "lng": -74.0060 },
        { "id": "us-losangeles", "name": "洛杉矶", "lat": 34.0522, "lng": -118.2437 },
        { "id": "us-sanfrancisco", "name": "旧金山", "lat": 37.7749, "lng": -122.4194 },
        { "id": "us-lasvegas", "name": "拉斯维加斯", "lat": 36.1699, "lng": -115.1398 },
        { "id": "us-chicago", "name": "芝加哥", "lat": 41.8781, "lng": -87.6298 }
      ]
    }
  ]
}
```

---

## 四、AI 生成提示词（可直接复制给 AI）

```
请为旅行应用生成城市数据 JSON 文件，遵循以下规范：

## 顶层结构
- version: "1.0.0"
- updated_at: "2026-09-08"（当前日期）
- countries: 数组，按大洲/区域排序（亚洲 → 欧洲 → 北美 → 大洋洲 → 中东 → 非洲 → 南美 → 中美）

## 国家对象
- code: ISO 3166-1 alpha-2 国家代码（2 个大写字母），如 "CN"、"JP"、"US"
- name: 国家中文名称，如 "中国"、"日本"、"美国"
- cities: 城市数组，按城市重要性排序

## 城市对象
- id: 格式为 "{country_code}-{city_english_name}"，全小写，空格用连字符，如 "cn-beijing"、"us-newyork"
- name: 城市中文名称，如 "北京"、"东京"、"纽约"
- lat: 纬度，WGS84 坐标系，保留 4 位小数
- lng: 经度，WGS84 坐标系，保留 4 位小数

## 城市选择标准
- 优先收录：首都、直辖市、省会、热门旅游城市、知名景点城市
- 每个国家 5-20 个城市（小国 1-5 个，大国 10-20 个）
- 中国：40 个城市（直辖市 + 省会 + 热门旅游城市）
- 其他国家：5-15 个城市（首都 + 主要旅游城市）

## 目标国家列表（51 个）
- 亚洲：CN（中国）、JP（日本）、KR（韩国）、TH（泰国）、SG（新加坡）、MY（马来西亚）、VN（越南）、ID（印度尼西亚）、PH（菲律宾）、IN（印度）、NP（尼泊尔）、LK（斯里兰卡）、MV（马尔代夫）、KH（柬埔寨）、LA（老挝）、MM（缅甸）
- 欧洲：GB（英国）、FR（法国）、IT（意大利）、ES（西班牙）、DE（德国）、CH（瑞士）、AT（奥地利）、NL（荷兰）、BE（比利时）、CZ（捷克）、HU（匈牙利）、PL（波兰）、GR（希腊）、PT（葡萄牙）、IS（冰岛）、NO（挪威）、FI（芬兰）、SE（瑞典）、DK（丹麦）、RU（俄罗斯）
- 北美：US（美国）、CA（加拿大）
- 大洋洲：AU（澳大利亚）、NZ（新西兰）
- 中东：AE（阿联酋）、TR（土耳其）
- 非洲：EG（埃及）、MA（摩洛哥）、ZA（南非）
- 南美：PE（秘鲁）、AR（阿根廷）、CL（智利）、BR（巴西）
- 中美：MX（墨西哥）、CU（古巴）

请生成完整的 JSON 文件，包含以上所有国家的城市数据。
```

---

## 五、数据校验规则（AI 生成后验证）

```javascript
// 校验脚本（可保存为 tools/validate-cities.mjs）
const data = require('./apps/web/src/data/cities.json');

// 1. 顶层结构校验
if (!data.version || !data.updated_at || !Array.isArray(data.countries)) {
  throw new Error('顶层结构错误');
}

// 2. 国家校验
for (const country of data.countries) {
  if (!/^[A-Z]{2}$/.test(country.code)) {
    throw new Error(`国家代码格式错误: ${country.code}`);
  }
  if (!country.name || !Array.isArray(country.cities)) {
    throw new Error(`国家结构错误: ${country.code}`);
  }

  // 3. 城市校验
  for (const city of country.cities) {
    if (!city.id.startsWith(country.code.toLowerCase() + '-')) {
      throw new Error(`城市 ID 前缀错误: ${city.id}`);
    }
    if (!city.name || typeof city.lat !== 'number' || typeof city.lng !== 'number') {
      throw new Error(`城市结构错误: ${city.id}`);
    }
    if (city.lat < -90 || city.lat > 90) {
      throw new Error(`纬度越界: ${city.id}`);
    }
    if (city.lng < -180 || city.lng > 180) {
      throw new Error(`经度越界: ${city.id}`);
    }
  }
}

console.log('✓ 数据校验通过');
console.log(`✓ 国家数: ${data.countries.length}`);
console.log(`✓ 城市数: ${data.countries.reduce((sum, c) => sum + c.cities.length, 0)}`);
```

---

## 六、扩展字段（可选，将来可用）

如果需要更丰富的城市信息，可以添加以下可选字段：

```json
{
  "id": "cn-beijing",
  "name": "北京",
  "lat": 39.9042,
  "lng": 116.4074,
  "population": 21540000,        // 人口（可选）
  "timezone": "Asia/Shanghai",   // 时区（可选，IANA 时区名）
  "aliases": ["Beijing", "北京"], // 别名（可选，用于搜索）
  "popular": true                 // 是否热门城市（可选，用于排序）
}
```

---

## 七、数据更新流程

1. **AI 生成**：用上面的提示词生成新的城市数据
2. **校验**：运行 `node tools/validate-cities.mjs` 校验数据格式
3. **替换**：替换 `apps/web/src/data/cities.json`
4. **更新版本号**：修改 `version` 和 `updated_at`
5. **重建**：`pnpm mvp:build && pnpm mvp:up`
6. **验证**：打开 `http://localhost:8080` 检查城市列表

---

## 八、当前数据统计

- **文件大小**：34.11 KB
- **国家数**：51
- **城市数**：354
- **平均每国城市数**：6.9
- **中国城市数**：40
- **国际城市数**：314

---

## 九、参考资源

- **ISO 3166-1 alpha-2 国家代码**：https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2
- **WGS84 坐标系**：https://en.wikipedia.org/wiki/World_Geodetic_System
- **城市坐标查询**：https://www.latlong.net/

---

*本规范用于指导 AI 自动生成城市数据，确保数据格式一致、可校验、可维护。*
