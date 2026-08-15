/**
 * 字体清单（TP-1-04，设计稿 17.5）。
 *
 * 这份清单是**构建脚本、CSS 生成、资产校验测试**三方的唯一来源。
 * 构建脚本按它下载与子集化，`fontFaceCss()` 按它生成 `@font-face`，
 * 测试按它逐个断言文件存在与体积达标 —— 少写一处就是漏一个字重，
 * 而漏一个字重的表现是「加粗的标题变回退字体」，很容易被当成设计问题。
 */

/** 17.5 要求的三档字重 */
export const FONT_WEIGHTS = [400, 500, 700] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

export interface FontFamilySpec {
  /** 文件名前缀，也是 manifest 的键前缀 */
  readonly id: string;
  /** CSS `font-family` 名。与上游同名 —— 见 README「为什么可以沿用原名」 */
  readonly cssFamily: string;
  /** google/fonts 仓库内的可变字体路径 */
  readonly sourcePath: string;
  /** 可变轴上要实例化出的字重 */
  readonly weights: readonly FontWeight[];
  /**
   * 除 `wght` 之外还需要钉住的可变轴。
   *
   * 必须逐字体声明而不是统一传一组轴：harfbuzz 在字体不含该轴时直接报错，
   * 给 Noto 传 `opsz` 会让构建失败。
   */
  readonly extraAxes?: Readonly<Record<string, number>>;
  /**
   * 单文件 woff2 体积上限（字节）。TP-1-04 验收标准为「单字重 woff2 < 2MB」；
   * 拉丁字体给更严的上限，否则它超标时这条断言等于没有。
   */
  readonly maxBytes: number;
  /**
   * 单文件 woff2 体积下限（字节）。
   *
   * 这条比上限更有用：woff2 的字节签名与文件存在性都无法证明 CJK 字形在里面，
   * 而「子集意外只剩拉丁」的产物只有几十 KB。体积下限是单元测试层面
   * 唯一能廉价识别这种失效的手段 —— 真正的字形验证要到容器里渲染（TP-1-16）。
   */
  readonly minBytes: number;
  /**
   * 构建期要求源字体覆盖到什么程度。
   *
   * `full`  —— 必须含 charset 的**每一个**码点，缺一个就让构建失败。
   *            正文与标题字体都是 `full`：它们直接承担 CJK 显示，
   *            缺字形的后果就是页面上的豆腐块。
   * `ascii` —— 只要求 ASCII 可打印区。Inter 不含 CJK 是设计意图，
   *            它只用于数字与金额，其余字符由 CSS 栈逐字回退到 Noto。
   */
  readonly coverage: 'full' | 'ascii';
}

/**
 * 用 google/fonts 的**可变字体**做源，而不是各字重的静态 OTF。
 *
 * 三个理由：
 *   1. 一个源文件实例化出三档字重，下载量从 ~50MB 降到 ~42MB 且只有 3 个 URL；
 *   2. 静态 OTF 的发布位置随 noto-cjk 的 release tag 变动，可变字体在
 *      `google/fonts` 的路径长期稳定；
 *   3. 实例化（pin 可变轴）后的字形与上游静态字重一致，不是插值近似 ——
 *      Noto 的 400/500/700 都是可变轴上的命名实例。
 */
export const FONT_FAMILIES: readonly FontFamilySpec[] = [
  {
    id: 'noto-sans-sc',
    cssFamily: 'Noto Sans SC',
    sourcePath: 'ofl/notosanssc/NotoSansSC[wght].ttf',
    weights: FONT_WEIGHTS,
    maxBytes: 2 * 1024 * 1024,
    minBytes: 512 * 1024,
    coverage: 'full',
  },
  {
    id: 'noto-serif-sc',
    cssFamily: 'Noto Serif SC',
    sourcePath: 'ofl/notoserifsc/NotoSerifSC[wght].ttf',
    weights: FONT_WEIGHTS,
    maxBytes: 2 * 1024 * 1024,
    minBytes: 512 * 1024,
    coverage: 'full',
  },
  {
    id: 'inter',
    cssFamily: 'Inter',
    // Inter 只用于数字与金额（`tabular-nums`），不含 CJK，因此子集只留拉丁与标点
    sourcePath: 'ofl/inter/Inter[opsz,wght].ttf',
    weights: FONT_WEIGHTS,
    /*
     * opsz（光学尺寸）轴必须钉死。留着它浏览器会按字号自动改变字形，
     * 同一段金额在标题与正文里的字形就不一致，视觉基线也不再稳定。
     * 14 对应正文字号档。
     */
    extraAxes: { opsz: 14 },
    maxBytes: 64 * 1024,
    minBytes: 8 * 1024,
    coverage: 'ascii',
  },
];

export interface FontAsset {
  readonly family: FontFamilySpec;
  readonly weight: FontWeight;
  /** `assets/` 下的文件名 */
  readonly file: string;
}

export function fontAssets(): readonly FontAsset[] {
  return FONT_FAMILIES.flatMap((family) =>
    family.weights.map((weight) => ({
      family,
      weight,
      file: `${family.id}-${weight}.woff2`,
    })),
  );
}

/**
 * CSS 字体栈。
 *
 * 第二位是**系统级安装的完整 Noto CJK**（渲染镜像里由 `fonts-noto-cjk`
 * 提供）：子集只含 GB 2312，用户内容里的生僻字（地名、菜名）会逐字回退到
 * 这里，得到字形略有差异但可读的结果，而不是豆腐块。
 *
 * 顺序不能颠倒 —— 完整字体放前面会让全部文字走系统字体，
 * 视觉基线立刻与 CI 不一致，且 `@font-face` 的子集形同虚设。
 */
export const FONT_STACK_SANS =
  "'Noto Sans SC', 'Noto Sans CJK SC', 'Noto Sans CJK', system-ui, sans-serif";
export const FONT_STACK_SERIF =
  "'Noto Serif SC', 'Noto Serif CJK SC', 'Noto Serif CJK', Georgia, serif";
export const FONT_STACK_NUMERIC = "Inter, 'Noto Sans SC', system-ui, sans-serif";

/**
 * 生成 `@font-face` 规则。
 *
 * `font-display: block` 而不是 `swap`：17.5 明确要求「导出场景宁可等待
 * 也不能截到回退字体」。`swap` 会先用回退字体绘制一帧，
 * 而 Playwright 完全可能就截在那一帧上。
 *
 * @param baseUrl 资产的 URL 前缀，必须以 `/` 结尾或为空
 */
export function fontFaceCss(baseUrl: string): string {
  if (baseUrl.length > 0 && !baseUrl.endsWith('/')) {
    throw new Error(`fontFaceCss 的 baseUrl 必须以 "/" 结尾，收到 ${JSON.stringify(baseUrl)}`);
  }

  return fontAssets()
    .map(({ family, weight, file }) =>
      [
        '@font-face {',
        `  font-family: '${family.cssFamily}';`,
        '  font-style: normal;',
        `  font-weight: ${weight};`,
        '  font-display: block;',
        `  src: url('${baseUrl}${file}') format('woff2');`,
        '}',
      ].join('\n'),
    )
    .join('\n\n');
}
