/**
 * 极简 TrueType cmap 解析器（TP-1-04 构建期校验用）。
 *
 * ## 为什么需要它
 *
 * `subsetCodepoints()` 是**请求**的码点集合，不是产物**实际含有**的字形集合 ——
 * harfbuzz 对源字体没有的码点静默跳过，不报错。两者不等时：
 *   - `findUncoveredCharacters()` 会说「这个字覆盖了」，
 *   - 而 PNG 上是豆腐块。
 *
 * 这是比「忘了跑 fonts:build」更隐蔽的一类失效，因为一切看起来都成功了。
 * 所以构建期必须用源字体的真实 cmap 验证请求集合，缺字直接让构建失败。
 *
 * 解析源可变 TTF（未压缩）而不是产物 woff2：woff2 是整体 brotli 流且
 * glyf 表经过变换，为读一张 cmap 引入完整 woff2 解码器不成比例。
 * harfbuzz 的子集结果是「请求 ∩ 源字体」，所以校验源字体等价于校验产物。
 */

/** 只实现实际会遇到的两种格式：4（BMP）与 12（含辅助平面） */
const SUPPORTED_FORMATS = new Set([4, 12]);

function tag(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** 找到 cmap 表的偏移。支持 sfnt 与 ttcf（Noto CJK 的可变字体是单体 sfnt） */
function findCmapTable(view) {
  const sfntVersion = view.getUint32(0);
  if (sfntVersion === 0x74746366) {
    throw new Error('不支持 TrueType Collection（ttcf）源字体');
  }

  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (tag(view, record) === 'cmap') {
      return view.getUint32(record + 8);
    }
  }
  throw new Error('源字体缺少 cmap 表');
}

function parseFormat4(view, base, out) {
  const segCountX2 = view.getUint16(base + 6);
  const segCount = segCountX2 / 2;

  const endCodes = base + 14;
  const startCodes = endCodes + segCountX2 + 2; // +2 跳过 reservedPad

  for (let seg = 0; seg < segCount; seg += 1) {
    const end = view.getUint16(endCodes + seg * 2);
    const start = view.getUint16(startCodes + seg * 2);
    if (start > end || start === 0xffff) continue;

    /*
     * 只收码点，不解析 glyph id。
     * 校验只关心「这个码点在 cmap 里有映射」，而 cmap 里的段本身
     * 就代表有映射 —— idRangeOffset 为 0 的段也是有效映射（delta 形式）。
     */
    for (let code = start; code <= end; code += 1) out.add(code);
  }
}

function parseFormat12(view, base, out) {
  const numGroups = view.getUint32(base + 12);
  for (let g = 0; g < numGroups; g += 1) {
    const group = base + 16 + g * 12;
    const start = view.getUint32(group);
    const end = view.getUint32(group + 4);
    for (let code = start; code <= end; code += 1) out.add(code);
  }
}

/**
 * 读出字体支持的全部 Unicode 码点。
 *
 * 合并所有 Unicode 编码子表（platform 0 与 platform 3/encoding 1|10），
 * 而不是只取第一张：不同子表覆盖范围不同，只看一张会低估覆盖，
 * 从而让构建对本来没问题的字符报错。
 */
export function readCodepoints(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const cmap = findCmapTable(view);

  const numSubtables = view.getUint16(cmap + 2);
  const out = new Set();
  let parsed = 0;

  for (let i = 0; i < numSubtables; i += 1) {
    const record = cmap + 4 + i * 8;
    const platformId = view.getUint16(record);
    const encodingId = view.getUint16(record + 2);
    const subtable = cmap + view.getUint32(record + 4);

    const isUnicode =
      platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
    if (!isUnicode) continue;

    const format = view.getUint16(subtable);
    if (!SUPPORTED_FORMATS.has(format)) continue;

    if (format === 4) parseFormat4(view, subtable, out);
    else parseFormat12(view, subtable, out);
    parsed += 1;
  }

  if (parsed === 0) {
    throw new Error('源字体没有可解析的 Unicode cmap 子表（格式 4 / 12）');
  }

  return out;
}
