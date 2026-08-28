import { buildVisualBrief, heroCacheKey } from '@tps/assets';
import {
  THEME_BUCKET_VALUES,
  type AiAssetGenerateRequest,
  type AspectRatio,
  type ThemeBucket,
} from '@tps/schemas';
import { z } from 'zod';

/**
 * 19.5 Hero 预热的目标枚举（TP-4-05）。
 *
 * ```text
 * Top N 热门目的地 × 12 个主题桶 → N × 12 个 Hero 缓存键
 * ```
 * 19.5 给的规模是 50 × 12 = 600 张，「上线前灌入素材库」，
 * 目的是让「绝大多数请求的 Hero 走缓存命中（毫秒级）而非实时生成
 * （10～40 秒）」—— 这是二十一章 SLA 能够成立的前提。
 *
 * ## 为什么用 `general` 桶也要预热
 *
 * `THEME_BUCKET_VALUES` 有 13 个值，12 个具体桶 + `general`。19.5 说的是
 * 12 个，但 `general` 恰恰是**未命中关键词时的落点**（见 theme-buckets.ts
 * 的 R-27），也就是最容易被真实请求击中的那一个。漏掉它等于漏掉
 * 「主题短语没有出现任何已知关键词」的全部情况。
 *
 * ## 目的地列表必须来自与客户端同一个 place_id 命名空间
 *
 * 19.1 要求缓存键的目的地维度**优先用 `place_id`**，而 `place_id` 由客户端
 * 的地理编码服务给出（见 @tps/planning 的 normalize.ts —— V1 原样透传）。
 * 预热时用一套自己编的 ID，产出的键与真实请求的键**永远不会相同**：
 * 600 张图全部躺在库里没人命中，而缓存命中率指标会如实地显示 0，
 * 却看不出原因。因此列表由外部清单给入，不在代码里硬编码一份。
 */

/** 预热清单的一行：一个目的地 */
export const PreheatDestinationSchema = z.object({
  /** 必须与客户端地理编码给出的 ID 完全一致，见文件头 */
  place_id: z.string().min(1),
  name: z.string().min(1),
});
export type PreheatDestination = z.infer<typeof PreheatDestinationSchema>;

/** Hero 的画幅与最小宽度，与 `@tps/presentation` 的槽位约束一致 */
export const HERO_ASPECT_RATIO: AspectRatio = '16:6';
export const HERO_MIN_WIDTH = 1600;

export interface PreheatTarget {
  readonly destination: PreheatDestination;
  readonly bucket: ThemeBucket;
  readonly cacheKey: string;
  readonly request: AiAssetGenerateRequest;
}

/**
 * 主题桶 → 送给模型的中文主题短语。
 *
 * 预热时没有 LLM 生成的主题短语（那是生成计划时才有的），因此按桶给一个
 * 代表性短语。它只影响画面内容，**不影响缓存键** —— 键里是桶名（19.2），
 * 所以真实请求里任何归到该桶的短语都能命中这张图。
 *
 * **导出是为了一致性断言**（`preheat-parity.test.ts`）：每个短语必须归到它
 * 自己的桶。不成立的后果不是键错配而是内容错配：为某个桶预热的那张图，
 * 是用一句实际归到别的桶的短语生成的 —— 键命中，画面不对题。
 */
export const BUCKET_THEME_PHRASE: Readonly<Record<ThemeBucket, string>> = {
  canal_culture: '运河人文',
  lake_scenery: '湖光山色',
  old_town: '古城老街',
  museum_art: '博物与艺术',
  food_street: '市井美食',
  mountain_nature: '山野自然',
  temple_heritage: '古寺遗迹',
  modern_city: '现代都市',
  night_view: '夜色灯火',
  garden_classic: '古典园林',
  coastal: '海岸线',
  family_park: '亲子乐园',
  general: '城市印象',
};

/** 枚举全部预热目标。纯函数，因此「要生成哪些」可以先看再决定跑不跑 */
export function preheatTargets(
  destinations: readonly PreheatDestination[],
  buckets: readonly ThemeBucket[] = THEME_BUCKET_VALUES,
): readonly PreheatTarget[] {
  const targets: PreheatTarget[] = [];

  for (const destination of destinations) {
    for (const bucket of buckets) {
      const cacheKey = heroCacheKey({
        destinationPlaceId: destination.place_id,
        destinationName: destination.name,
        bucket,
        visualStyle: 'CHINESE_TRAVEL_EDITORIAL',
        aspectRatio: HERO_ASPECT_RATIO,
      });

      targets.push({
        destination,
        bucket,
        cacheKey,
        request: {
          asset_type: 'HERO_ILLUSTRATION',
          brief: buildVisualBrief({
            role: 'HERO_BACKGROUND',
            destination: destination.name,
            theme: BUCKET_THEME_PHRASE[bucket],
            /*
             * 不给具体元素：预热的图要服务于该桶下的**任意**行程，
             * 写死「拱宸桥」会让它只适合去过拱宸桥的那些计划。
             */
            elements: [],
            style: 'CHINESE_TRAVEL_EDITORIAL',
            aspectRatio: HERO_ASPECT_RATIO,
          }),
          cache_key: cacheKey,
          min_width: HERO_MIN_WIDTH,
        },
      });
    }
  }

  return targets;
}

export interface PreheatManifestResult {
  readonly destinations: readonly PreheatDestination[];
  readonly errors: readonly { readonly line: number; readonly message: string }[];
}

/**
 * 解析 JSONL 清单。与 `parseSeedManifest` 同一处理：**收集全部错行**，
 * 由调用方决定整体不跑 —— 跳过错行等于「预热了 588 个，12 个静默缺失」，
 * 而缺失的那些会在线上以实时生成（10～40 秒）的形式暴露。
 */
export function parsePreheatManifest(text: string): PreheatManifestResult {
  const destinations: PreheatDestination[] = [];
  const errors: { line: number; message: string }[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? '').trim();
    if (raw === '' || raw.startsWith('#')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      errors.push({ line: i + 1, message: '不是合法 JSON' });
      continue;
    }

    const result = PreheatDestinationSchema.safeParse(parsed);
    if (!result.success) {
      errors.push({
        line: i + 1,
        message: result.error.issues.map((issue) => issue.message).join('；'),
      });
      continue;
    }

    if (seen.has(result.data.place_id)) {
      // 重复的 place_id 会让同一批键被枚举两次，第二次全部命中缓存 ——
      // 不会出错，但会让「预热了多少」这个数字失真
      errors.push({ line: i + 1, message: `place_id 重复：${result.data.place_id}` });
      continue;
    }
    seen.add(result.data.place_id);
    destinations.push(result.data);
  }

  return { destinations, errors };
}
