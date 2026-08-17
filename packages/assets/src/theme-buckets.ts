import { THEME_BUCKET_VALUES, type ThemeBucket } from '@tps/schemas';
import { normalizeName } from './normalize.js';

/**
 * 主题语义桶（TP-3-12，设计稿 19.1）。
 *
 * ## 为什么必须归桶
 *
 * Hero 缓存键含 `theme`，而 `theme` 是 LLM 自由生成的中文短语
 * （「运河人文·古今交融」）。直接归一化会得到几乎唯一的键 ——
 * 缓存命中率趋近 0，每天每个用户都要重新生成一张 Hero（10～40 秒 + 成本）。
 * 归桶把它压到 13 个取值，19.5 的「同一计划内跨天复用」与「跨用户复用」
 * 才成立。
 *
 * ## R-27：只做关键词匹配，嵌入归桶延后
 *
 * 19.1 写的是「关键词匹配 + 嵌入相似度归桶」。嵌入那一半需要**语义**向量
 * 模型，而 V1 本地用的是词汇哈希向量器（见 `@tps/llm` 的 embedding.ts）——
 * 用它做归桶，「运河人文」与「湖光山色」的相似度取决于共同汉字数，
 * 结果不是「语义归桶」而是「随机归桶」，比落 `general` 更糟：
 * 错桶意味着**两个不相关主题共用一张 Hero**，而 `general` 只是复用面更宽。
 *
 * 因此这里只实现关键词匹配，未命中落 `general`。接入语义模型后再补第二级，
 * 那时键版本要从 `v1` 递增（19.2 已为此准备）。
 */

/**
 * 各桶的关键词。
 *
 * 只收**主题短语里真的会出现**的词。收得太宽（比如往 `modern_city` 里放
 * 「城」）会让「古城漫步」被判成现代都市 —— 而错桶的后果是两个不相关的
 * 主题共用一张 Hero。
 */
export const THEME_KEYWORDS: Readonly<Record<Exclude<ThemeBucket, 'general'>, readonly string[]>> =
  {
    canal_culture: ['运河', '水乡', '河埠', '漕运', '水巷', '拱宸', '桥西', '临水'],
    lake_scenery: ['西湖', '湖光', '湖畔', '湖山', '湖景', '湖滨', '太湖', '洱海', '断桥'],
    old_town: ['古城', '古镇', '老街', '街区', '巷弄', '老城', '直街', '骑楼'],
    museum_art: ['博物', '美术', '展览', '艺术', '文博', '展馆', '画院'],
    food_street: ['美食', '小吃', '夜市', '市集', '菜场', '食街', '味道', '茶楼'],
    mountain_nature: ['山', '峰', '森林', '峡谷', '溪', '徒步', '茶山', '竹海', '登高'],
    /*
     * 「问禅」「礼佛」这类双字词与单字「寺」「禅」并存是有意的：
     * 打分按命中字数累加，双字词让「灵隐问禅·山径听泉」这种同时含
     * 单字「山」的主题稳定落到 temple_heritage —— 只有单字时两边同分，
     * 结果取决于枚举顺序，那不是判断，是巧合。
     */
    temple_heritage: [
      '寺',
      '禅',
      '庙',
      '塔',
      '问禅',
      '礼佛',
      '遗址',
      '石窟',
      '古刹',
      '遗产',
      '宋韵',
      '南宋',
    ],
    modern_city: ['天际', '摩天', '都市', '现代', '地标', '新城', '钱塘江畔'],
    night_view: ['夜景', '夜色', '灯光', '夜游', '星空', '夜'],
    garden_classic: ['园林', '庭院', '名园', '拙政', '留园', '苏式'],
    coastal: ['海滨', '沙滩', '渔村', '海岛', '海岸', '海湾', '看海'],
    family_park: ['亲子', '乐园', '儿童', '动物园', '游乐', '遛娃'],
  };

/**
 * 主题文本 → 语义桶。
 *
 * 打分而不是「首个命中」：主题短语常常同时含多个桶的词
 * （「运河人文·古今交融」既有「运河」也有「古」）。
 * 按**命中关键词的总字数**取最高分 —— 长词比短词更具指示性
 * （「钱塘江畔」比「山」更能确定主题）。
 *
 * 同分时按 `THEME_BUCKET_VALUES` 的顺序取第一个。这一条不能省：
 * 缓存键必须对同一输入恒定，而 `Object.keys` 的顺序虽然在 V8 上稳定，
 * 却不是可以依赖的语义。
 */
export function themeBucket(theme: string | null | undefined): ThemeBucket {
  if (theme === null || theme === undefined) return 'general';

  const normalized = normalizeName(theme);
  if (normalized.length === 0) return 'general';

  let bestBucket: ThemeBucket = 'general';
  let bestScore = 0;

  for (const bucket of THEME_BUCKET_VALUES) {
    if (bucket === 'general') continue;

    let score = 0;
    for (const keyword of THEME_KEYWORDS[bucket]) {
      if (normalized.includes(normalizeName(keyword))) score += keyword.length;
    }

    if (score > bestScore) {
      bestScore = score;
      bestBucket = bucket;
    }
  }

  return bestBucket;
}
