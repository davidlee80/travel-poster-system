/**
 * 子集字符集定义（TP-1-04，设计稿 17.5）。
 *
 * ## 为什么字符集必须是代码而不是一份字符清单文件
 *
 * 子集范围是**运行期契约**，不只是构建期参数：
 *   - 构建期决定 woff2 里有哪些字形；
 *   - 运行期 `findUncoveredCharacters()` 用同一个集合判断某段文案会不会掉进
 *     系统回退字体，从而把「豆腐块」从静默故障变成可观测事件。
 *
 * 两处若各写一份，必然漂移，且漂移的表现是「线上偶发豆腐块」——
 * 这是最难定位的一类缺陷。因此集合只有这一个定义处，构建脚本从
 * `dist/charset.js` 引入同一份实现。
 */

// 从 node:util 显式引入：全局的 TextDecoder 在 @types/node 下只是值，不能作类型用
import { TextDecoder } from 'node:util';

/**
 * GB 2312 汉字数（一级 3755 + 二级 3008）。
 *
 * 这不是估计值，是标准规定的确切数量，用作构建与测试的断言基准 ——
 * 枚举逻辑写错时数量必然偏移，比肉眼检查可靠。
 */
export const GB2312_HANZI_COUNT = 6763;

/**
 * 用 GB 18030 解码器把 GB 2312 的区位码还原为 Unicode。
 *
 * Node 24 官方构建自带 full-icu，因此 `gb18030` 解码器一定可用。
 * GB 18030 ⊃ GBK ⊃ GB 2312，所以 GB 2312 的双字节序列在此解码器下
 * 结果与 GB 2312 标准一致。
 */
function decodeCell(decoder: TextDecoder, qu: number, wei: number): string | null {
  const decoded = decoder.decode(new Uint8Array([0xa0 + qu, 0xa0 + wei]));

  // 未分配单元格在 GBK 里可能落到私用区，那些字形不应进入子集
  if (decoded.length !== 1) return null;
  const code = decoded.codePointAt(0);
  if (code === undefined || code === 0xfffd) return null;
  if (code >= 0xe000 && code <= 0xf8ff) return null;

  return decoded;
}

/**
 * GB 2312 汉字区。
 *
 * 只取**标准实际分配**的单元格，而不是整个 16–87 区：
 *   一级字：第 16–54 区全 94 位，第 55 区第 1–89 位   → 3666 + 89 = 3755
 *   二级字：第 56–87 区全 94 位                       → 3008
 *
 * 直接取 16–87 全区会多出 5 个 GB 2312 未分配、GBK 才填充的字 ——
 * 数量就不再是 6763，`GB2312_HANZI_COUNT` 断言随之失去意义。
 */
export function gb2312Hanzi(): string[] {
  const decoder = new TextDecoder('gb18030');
  const out: string[] = [];

  for (let qu = 16; qu <= 87; qu += 1) {
    const lastWei = qu === 55 ? 89 : 94;
    for (let wei = 1; wei <= lastWei; wei += 1) {
      const ch = decodeCell(decoder, qu, wei);
      if (ch !== null) out.push(ch);
    }
  }

  return out;
}

/**
 * GB 2312 符号区（第 1–9 区）：标点、全角数字与拉丁、希腊、西里尔、
 * 拼音声调符号、制表符。
 *
 * 全取而不是只挑标点：整个符号区不到 850 个字形，占子集体积不足 1%，
 * 但少一个「℃」或「Ⅲ」就是一处可见缺陷。挑选的收益远小于漏选的代价。
 */
export function gb2312Symbols(): string[] {
  const decoder = new TextDecoder('gb18030');
  const out: string[] = [];

  for (let qu = 1; qu <= 9; qu += 1) {
    for (let wei = 1; wei <= 94; wei += 1) {
      const ch = decodeCell(decoder, qu, wei);
      if (ch !== null) out.push(ch);
    }
  }

  return out;
}

/**
 * GB 2312 之外必须补入的字符。
 *
 * 由 `pnpm --filter @tps/fonts test` 的覆盖测试守护：模板与派生文案
 * （`@tps/presentation` 的标签表、fixtures）里出现任何本集合与 GB 2312
 * 都不含的字符，测试失败。**新增文案时不要手工往这里加字符** ——
 * 先让测试报出缺哪个字，再补。
 */
export const EXTRA_CHARACTERS = [
  // GB 2312 只有全角「￥」。LLM 产出的预算文案里半角 ¥ 很常见（8.1 的 currency
  // 枚举 V1 只有 CNY，所以不收其它币种符号 —— 收了也没有用它的路径）
  '¥',
  // 短破折号：日期区间「3–5 天」在 LLM 输出里比全角「—」更常见
  '–',
  // 要点与状态符号，来自 LLM 文案而非我们的模板。
  // 箭头（←↑→↓）与星号（★☆）不在此列 —— GB 2312 符号区已含，重复列出会
  // 让这份清单失去「筛选」的意义（由 charset.test.ts 守护）
  '•',
  '✓',
  '⚠',
] as const;

/** 半角 ASCII 可打印区 + 不换行空格。数字与拉丁字母由此覆盖。 */
function asciiPrintable(): string[] {
  const out: string[] = [];
  for (let code = 0x20; code <= 0x7e; code += 1) out.push(String.fromCodePoint(code));
  out.push(' ');
  return out;
}

let cached: ReadonlySet<number> | null = null;

/**
 * 子集码点集合。构建脚本与运行期覆盖检查共用。
 *
 * 结果缓存：运行期每渲染一页都要查一次，重复枚举 7000+ 单元格没有意义。
 */
export function subsetCodepoints(): ReadonlySet<number> {
  if (cached !== null) return cached;

  const set = new Set<number>();
  const add = (chars: readonly string[]): void => {
    for (const ch of chars) {
      const code = ch.codePointAt(0);
      if (code !== undefined) set.add(code);
    }
  };

  add(asciiPrintable());
  add(gb2312Symbols());
  add(gb2312Hanzi());
  add(EXTRA_CHARACTERS);

  cached = set;
  return set;
}

/**
 * 找出 `text` 中不在子集里的字符（去重，保持首次出现顺序）。
 *
 * 用途是**观测**，不是阻断：这些字符会由镜像内系统级安装的完整
 * Noto CJK 兜底渲染（见 README「系统字体」一节），视觉上略有差异但不是豆腐块。
 * 渲染 Worker 把结果记为指标，让「子集需要扩充」这件事可以被发现，
 * 而不是等用户截图来投诉。
 *
 * 忽略控制字符与代理项以外的换行/制表：它们不需要字形。
 */
export function findUncoveredCharacters(text: string): string[] {
  const covered = subsetCodepoints();
  const seen = new Set<number>();
  const out: string[] = [];

  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    // 控制字符与空白不需要字形
    if (code < 0x20 || code === 0x7f) continue;
    if (covered.has(code) || seen.has(code)) continue;

    seen.add(code);
    out.push(ch);
  }

  return out;
}

/**
 * 字符集指纹。写入 `manifest.json`，让「assets 是用当前 charset 生成的」
 * 可被机械验证 —— 改了字符集却忘了重新生成字体，是这套流程最可能的失误，
 * 而它的表现同样是静默的豆腐块。
 */
export function charsetFingerprint(): string {
  const codes = [...subsetCodepoints()].sort((a, b) => a - b);

  // FNV-1a：不需要密码学强度，只需要稳定且与平台无关
  let hash = 0x811c9dc5;
  for (const code of codes) {
    for (let shift = 0; shift < 32; shift += 8) {
      hash ^= (code >>> shift) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
  }

  return `${codes.length}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
