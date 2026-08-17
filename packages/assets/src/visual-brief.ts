import {
  aspectRatioValue,
  type AiAssetType,
  type AspectRatio,
  type AssetRequirementItem,
  type AssetRole,
  type ThemeBucket,
  type VisualBrief,
  type VisualBriefTask,
  type VisualStyle,
} from '@tps/schemas';

import { themeBucket } from './theme-buckets.js';

/**
 * 11.1 视觉 Brief 的构造与提示词渲染（TP-4-01/02，设计稿 11.1、11.3）。
 *
 * ## 零 IO，因此可以被三方共用
 *
 * 解析编排（generation-worker）、14.3 端点（api）与 19.5 的 Hero 预热 CLI
 * 都要构造 Brief。三处各拼一次提示词的失效模式是「负向提示词在某一处漏了
 * 一条」—— 而 11.3 的禁止项漏一条的表现是图上出现了价格或 Logo，
 * 那种图会一路走到用户的 PDF 里。
 *
 * ## 提示词由结构渲染，不是反过来
 *
 * `renderPrompt` 是纯函数：同一个 Brief 永远得到同一段提示词。这让
 * 二十章的 `visual_brief` 具备排查价值 —— 拿库里那份 Brief 重新渲染，
 * 得到的就是当时发给模型的原文。反过来（先拼提示词、再从里面摘字段落库）
 * 无法保证这一点。
 */

/** 提示模板版本。二十章要求落到 `generation_metadata.prompt_template_version` */
export const IMAGE_PROMPT_VERSION = 'image_v1';

/**
 * 11.3 的禁止项，翻译成负向提示词。
 *
 * 11.1 的示例给了五条（`no text` / `no logo` / `no watermark` /
 * `no malformed buildings` / `no excessive people`），11.3 另外点名了
 * 「标题」「门票价格」「地图文字」三类具体内容。两处合并去重后如下。
 *
 * 用英文而不是中文：图片模型的负向提示词在英文语料上训练得最充分，
 * 中文负向词在多数供应商上效果显著更弱。这不是审美选择 ——
 * 「no text」失效的表现是图上出现乱码假文字，而那正是 11.3 要防的东西。
 *
 * 11.3 的第五条（不把 AI 景点图标记成真实照片）**不在这里** ——
 * 它不是对模型的要求，而是对我们自己的要求，由
 * `representation_type = 'ILLUSTRATIVE'` 与迁移 0005 的
 * `assets_ai_must_be_illustrative` 强制。
 */
export const NEGATIVE_REQUIREMENTS: readonly string[] = [
  // 11.3：不让 AI 在图片里绘制标题
  'no text',
  'no title',
  'no captions',
  'no lettering',
  // 11.3：不让 AI 绘制门票价格
  'no price tags',
  'no numbers',
  // 11.3：不让 AI 绘制地图文字
  'no map labels',
  'no street signs',
  // 11.3：不让 AI 生成带品牌 Logo 的图片
  'no logo',
  'no brand marks',
  // 11.1 的其余三条
  'no watermark',
  'no malformed buildings',
  'no excessive people',
];

/** 角色 → 14.3 的受控素材类型。`ROUTE_MAP` 不可生成（11.3、9.2） */
export const AI_ASSET_TYPE_BY_ROLE: Readonly<Record<Exclude<AssetRole, 'ROUTE_MAP'>, AiAssetType>> =
  {
    HERO_BACKGROUND: 'HERO_ILLUSTRATION',
    DESTINATION_PHOTO: 'DESTINATION_ILLUSTRATION_FALLBACK',
    FOOD_IMAGE: 'FOOD_FALLBACK',
  };

const TASK_BY_ASSET_TYPE: Readonly<Record<AiAssetType, VisualBriefTask>> = {
  HERO_ILLUSTRATION: 'GENERATE_TRAVEL_HERO',
  DESTINATION_ILLUSTRATION_FALLBACK: 'GENERATE_DESTINATION_ILLUSTRATION',
  FOOD_FALLBACK: 'GENERATE_FOOD_ILLUSTRATION',
  DECORATIVE_ILLUSTRATION: 'GENERATE_DECORATIVE_ILLUSTRATION',
};

/** 七章的中文风格枚举 → 11.1 的英文风格短语 */
const STYLE_PHRASE: Readonly<Record<VisualStyle, string>> = {
  CHINESE_TRAVEL_EDITORIAL: 'Chinese travel editorial illustration',
  REALISTIC_FOOD_PHOTOGRAPHY: 'realistic food photography style illustration',
};

/**
 * 各主题桶的配色。
 *
 * 按桶而不是按目的地：配色要与缓存键的粒度一致（19.2 的 Hero 键含桶，
 * 不含具体主题短语）。按短语给配色会让同一个键对应多种配色 ——
 * 而缓存命中时返回的是先到者那张，配色由「谁先生成」决定，不可复现。
 */
const PALETTE_BY_BUCKET: Readonly<Record<ThemeBucket, readonly string[]>> = {
  canal_culture: ['fresh green', 'warm gold', 'soft blue'],
  lake_scenery: ['misty blue', 'willow green', 'pale rose'],
  old_town: ['warm grey', 'brick red', 'ink black'],
  museum_art: ['off white', 'deep indigo', 'brass'],
  food_street: ['warm amber', 'chili red', 'cream'],
  mountain_nature: ['pine green', 'stone grey', 'sky blue'],
  temple_heritage: ['ochre', 'vermilion', 'moss green'],
  modern_city: ['steel blue', 'glass cyan', 'silver'],
  night_view: ['deep navy', 'lantern gold', 'violet'],
  garden_classic: ['jade green', 'white wall grey', 'dark tile blue'],
  coastal: ['turquoise', 'sand beige', 'coral'],
  family_park: ['grass green', 'sunny yellow', 'sky blue'],
  general: ['soft neutral', 'warm gold', 'soft blue'],
};

export interface BuildBriefInput {
  readonly role: Exclude<AssetRole, 'ROUTE_MAP'>;
  readonly destination: string;
  /** Hero 用主题短语；景点/美食用实体名。两者都不是用户输入的自由文本 */
  readonly theme: string;
  readonly elements: readonly string[];
  readonly style: VisualStyle;
  readonly aspectRatio: AspectRatio;
}

/**
 * 构造 Brief。
 *
 * `theme` 的两种含义（Hero 的主题短语 / 景点与美食的实体名）合用一个字段是
 * 11.1 的写法（示例里 Hero 的 `theme` 是「运河人文·古今交融」）。
 * 保留它而不是拆成两个字段：Brief 会原样落进 `generation_metadata`，
 * 改结构等于让 P4 之前生成的素材在排查时读不回来。
 */
export function buildVisualBrief(input: BuildBriefInput): VisualBrief {
  const assetType = AI_ASSET_TYPE_BY_ROLE[input.role];
  const hero = input.role === 'HERO_BACKGROUND';

  return {
    task: TASK_BY_ASSET_TYPE[assetType],
    destination: input.destination,
    theme: input.theme,
    /*
     * 去重并剔除空串。元素多数来自 LLM 输出的景点名（七章 `subject.entities`），
     * 而同一天里重复出现同一个地点是常见的（上午参观、下午再路过）。
     * 重复词在提示词里会被模型理解为强调，画面因此偏向那个元素。
     */
    elements: [...new Set(input.elements.map((element) => element.trim()))].filter(
      (element) => element.length > 0,
    ),
    style: STYLE_PHRASE[input.style],
    /*
     * Hero 的配色按主题桶取，景点与美食图按 `general`：
     * 它们的键里没有主题桶（19.2 的景点键是 `place:v1:{place_id}:...`），
     * 按桶取色会让同一个景点在不同主题的计划里得到不同配色的图，
     * 而缓存键相同 —— 于是「哪一版留下来」取决于谁先生成。
     */
    palette: [...(hero ? PALETTE_BY_BUCKET[themeBucket(input.theme)] : PALETTE_BY_BUCKET.general)],
    layout: {
      // 模板在 Hero 左上角压标题与日期（12.1）。那块区域必须留白
      reserved_text_area: hero ? 'LEFT_TOP' : 'NONE',
      subject_area: hero ? 'RIGHT_AND_BOTTOM' : 'CENTER',
      aspect_ratio: input.aspectRatio,
    },
    negative_requirements: [...NEGATIVE_REQUIREMENTS],
  };
}

/**
 * 从 14.1 的槽位需求构造 Brief。
 *
 * 返回 null 表示**该槽位不可用 AI 兜底**：
 *   - `ROUTE_MAP`（11.3 禁止 AI 绘制地图文字，9.2 用程序生成的 SVG）；
 *   - 缺 `subject`（schema 已保证非 ROUTE_MAP 必有，这里是防御性分支）；
 *   - 景点/美食槽位缺实体名 —— 没有实体名的「景点图」画出来的是泛化风景，
 *     而它会以「杭州的第 3 天景点」的身份出现在页面上。占位图更诚实。
 */
export function briefForRequirement(item: AssetRequirementItem): VisualBrief | null {
  if (item.role === 'ROUTE_MAP') return null;
  const subject = item.subject;
  if (subject === null || subject === undefined) return null;

  const hero = item.role === 'HERO_BACKGROUND';
  const theme = hero ? subject.theme : subject.entity_name;
  if (theme === null || theme === undefined || theme.trim().length === 0) return null;

  const style =
    item.visual_constraints.style ??
    (item.role === 'FOOD_IMAGE' ? 'REALISTIC_FOOD_PHOTOGRAPHY' : 'CHINESE_TRAVEL_EDITORIAL');

  return buildVisualBrief({
    role: item.role,
    destination: subject.destination,
    theme,
    /*
     * Hero 用整天的元素（它表达氛围），景点与美食只用自己
     * —— 把同一天的其他景点塞进某个景点的图里，画出来的是拼贴。
     */
    elements: hero ? (subject.entities ?? []) : [theme],
    style,
    aspectRatio: item.visual_constraints.aspect_ratio,
  });
}

/** Brief → 正向提示词。纯函数：同一个 Brief 永远渲染出同一段文本 */
export function renderPrompt(brief: VisualBrief): string {
  const lines = [`${brief.style} of ${brief.destination}.`, `Theme: ${brief.theme}.`];

  if (brief.elements.length > 0) {
    lines.push(`Include: ${brief.elements.join(', ')}.`);
  }
  lines.push(`Palette: ${brief.palette.join(', ')}.`);
  lines.push(`Composition aspect ratio ${brief.layout.aspect_ratio}.`);

  if (brief.layout.reserved_text_area === 'LEFT_TOP') {
    /*
     * 「留白」必须说成正向要求。把它写进负向提示词（`no subject in top left`）
     * 在多数供应商上会被理解为「不要左上角」而整体重构图 ——
     * 而我们要的只是那块区域不要有需要看清的细节。
     */
    lines.push(
      'Leave the top-left area visually calm and uncluttered for overlaid text; ' +
        'place the main subject toward the right and bottom.',
    );
  }

  lines.push(`Must not contain: ${brief.negative_requirements.join(', ')}.`);
  return lines.join('\n');
}

/** Brief → 负向提示词。供应商支持独立负向字段时用它 */
export function renderNegativePrompt(brief: VisualBrief): string {
  return brief.negative_requirements.join(', ');
}

/**
 * 按比例与最小宽度算出请求给模型的像素尺寸。
 *
 * 高度由比例反算而不是让调用方传：11.2 第 3 步会校验产物比例
 * （偏差超过半个八度即拒绝），而请求尺寸与校验口径不一致时，
 * 我们会稳定地拒绝掉自己刚花钱生成的图。
 *
 * 宽度向上取到 8 的倍数：多数扩散模型要求边长是 8 或 64 的倍数，
 * 不对齐时供应商会静默取整 —— 而那会让产物比例偏离请求值。
 */
export function imageSizeFor(
  aspectRatio: AspectRatio,
  minWidth: number,
): { readonly width: number; readonly height: number } {
  const width = Math.ceil(minWidth / 8) * 8;
  const height = Math.max(8, Math.round(width / aspectRatioValue(aspectRatio) / 8) * 8);
  return { width, height };
}
