import sharp from 'sharp';

import type { ImageRequest } from '@tps/llm';

/**
 * `IMAGE_MODE=fake` 的渲染函数（TP-4-02，与 `LLM_MODE=fake` 同一处理）。
 *
 * ## 为什么产出的是渐变图而不是「像插画的东西」
 *
 * 假实现的用途是**打通链路**：11.2 的后处理要真的解码一张图、校验分辨率与
 * 比例、转 WebP、生成缩略图；`assets` 与 `asset_variants` 要真的落行；
 * 19.5 的跨天复用要真的命中缓存键。这些全部与画面内容无关。
 *
 * 画一张假的「插画」反而有害：它会让本地开发看起来像是接通了图片模型，
 * 而实际上没有 —— 与 `createLlmClient` 不回退到 fake 的理由相同
 * （见 @tps/llm 的 config.ts）。渐变图一眼就能看出是占位。
 *
 * ## 它落库为 AI_GENERATED 是正确的
 *
 * `source_type` 记 `AI_GENERATED`、`representation_type` 记 `ILLUSTRATIVE`、
 * `generation_metadata.generated_model` 记 `fake-image`、`cost_units` 记 0。
 * 每一项都如实描述了这张图的来源，因此二十章的可追溯性成立 ——
 * 排查时能看出「这张图是假实现产的」，而不是误以为它来自真模型。
 */

/** 与真实生成物区分的配色：冷灰蓝，且中央写明来源 */
const FROM = '#3a3f4b';
const TO = '#6b7280';

export async function renderFakeGeneratedImage(request: ImageRequest): Promise<Uint8Array> {
  const fontSize = Math.max(12, Math.round(Math.min(request.width, request.height) / 12));
  /*
   * 文字用 SVG 叠加而不是 sharp 的文字 API：后者依赖 pango/fontconfig，
   * 在部分 Linux 镜像上缺失（22.3.2 的同类问题）。与 placeholders.ts 同一处理。
   */
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${request.width}" height="${request.height}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0%" stop-color="${FROM}" />`,
    `<stop offset="100%" stop-color="${TO}" />`,
    `</linearGradient></defs>`,
    `<rect width="${request.width}" height="${request.height}" fill="url(#g)" />`,
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" `,
    `font-family="Noto Sans SC, Noto Sans CJK SC, sans-serif" font-size="${fontSize}" `,
    // 种子写进画面：同一缓存键永远得到同一张图，肉眼就能确认复用生效了
    `fill="#ffffff" fill-opacity="0.7">IMAGE_MODE=fake · seed ${request.seed}</text>`,
    `</svg>`,
  ].join('');

  const png = await sharp(Buffer.from(svg, 'utf8')).png().toBuffer();
  return new Uint8Array(png);
}
