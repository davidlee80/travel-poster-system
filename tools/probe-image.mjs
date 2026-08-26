#!/usr/bin/env node
/**
 * 图像生成端点的能力探测（对应 tools/probe-llm.mjs，两者各自独立）。
 *
 *   node tools/probe-image.mjs --dry-run     # 只做本地体检，不发请求
 *   IMAGE_BASE_URL=... IMAGE_API_KEY=... IMAGE_MODEL=... node tools/probe-image.mjs
 *
 * 凭据读 `IMAGE_*`；缺省回落到 `LLM_*`（同一个中转站同时提供两种能力时
 * 只配一套即可）。回落时会明确打印用了哪一套 —— `image.ts` 的注释特意说明
 * 「不复用 LLM_BASE_URL」，因为文本与图片常常不是同一个供应商，
 * 静默回落会让「配了网关之后图片全部 404」难以归因。
 *
 * ## 为什么图像比文本更需要探测
 *
 * 文本失败是**阻断**（`PLAN_LLM_*` 有 httpStatus，用户看得见）。
 * 图像失败是**降级**（`ASSET_AI_GENERATION_*` 是告警码，只进
 * `generation_jobs.warnings`，页面照常产出渐变占位图）。
 *
 * 也就是说：图像接错了，系统表现为「一切正常，只是所有 AI 图都是色块」。
 * 没有报错、没有 5xx、用户拿得到页面 —— 这是最难被发现的失效模式，
 * 而它可能持续几个月直到有人问「为什么图片都长一样」。
 *
 * ## 四个必须实测的点
 *
 *   1. size 枚举   项目按比例算尺寸（1600x600 等），OpenAI 只收固定几档
 *   2. 返回的真实像素  供应商可能接受 size 却返回别的尺寸 —— 那样 11.2 的
 *                      processImage 会因宽度不足 min_width 而拒，又是静默降级
 *   3. 未知参数    image.ts 假设 negative_prompt / seed 「被忽略而不是报错」，
 *                  这条假设从未验证过
 *   4. 真实耗时    21.2 措施二把超时压到 20 秒，且 loadImageConfig **拒绝**
 *                  更大的配置值。所以耗时不是调参问题，是可行性问题
 *
 * 第 4 点是这个脚本用长超时（默认 120 秒）而不是 20 秒的原因：
 * 用 20 秒探测只能得到「超时了」，得不到「需要多久」。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDist = path.join(repoRoot, 'packages', 'assets', 'dist', 'index.js');

let assets;
try {
  assets = await import(`file://${assetsDist.split(path.sep).join('/')}`);
} catch (error) {
  process.stderr.write(
    `无法加载 @tps/assets 的构建产物：${assetsDist}\n` +
      `先运行 pnpm --filter @tps/assets run build（或用 pnpm probe:image）。\n` +
      `原始错误：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}

const { imageSizeFor } = assets;

// ── CLI 与凭据 ──────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? '') : '';
}
const has = (name) => argv.includes(`--${name}`);

const env = process.env;
function credential(imageKey, llmKey) {
  const own = (env[imageKey] ?? '').trim();
  if (own !== '') return { value: own, from: imageKey };
  return { value: (env[llmKey] ?? '').trim(), from: llmKey };
}

const baseUrlSrc = credential('IMAGE_BASE_URL', 'LLM_BASE_URL');
const apiKeySrc = credential('IMAGE_API_KEY', 'LLM_API_KEY');
const modelSrc = credential('IMAGE_MODEL', 'LLM_MODEL');

const baseUrl = (flag('base-url') || baseUrlSrc.value).replace(/\/+$/, '');
const apiKey = flag('api-key') || apiKeySrc.value;
const model = flag('model') || modelSrc.value;
const dryRun = has('dry-run');
const timeoutMs = Number(flag('timeout') || '120000');

/** 21.2 措施二的硬上限，loadImageConfig 会拒绝更大的配置值 */
const HARD_TIMEOUT_MS = 20_000;

// ── 本地体检：size 枚举 ─────────────────────────────────────

/*
 * OpenAI 图像端点接受的 size 枚举。超出即 400 `Invalid value for 'size'` ——
 * 不是四舍五入到最近的档位。SD / Flux 系的兼容端点通常接受任意尺寸
 * （常要求 8 或 64 的倍数），因此这张表只对 OpenAI 系模型是硬约束。
 */
const OPENAI_SIZES = {
  'dall-e-3': ['1024x1024', '1792x1024', '1024x1792'],
  'gpt-image-1': ['1024x1024', '1536x1024', '1024x1536', 'auto'],
  'dall-e-2': ['256x256', '512x512', '1024x1024'],
};
const ALL_OPENAI_SIZES = new Set(Object.values(OPENAI_SIZES).flat());

/*
 * 三个素材角色的比例与 min_width，抄自 placeholders.ts 的 PLACEHOLDER_SPECS
 * （那张表的注释说「比例与 @tps/presentation 的槽位约束一致」）。
 *
 * 严格地说，AI 生成时的 min_width 来自 Brief 的 `visual_constraints.min_width`
 * 而不是这张占位图规格表，两者理论上一致。这里取占位图表的值是因为它是
 * 仓库里唯一把「角色 → 比例 + min_width」写全的地方。
 */
const PROJECT_SPECS = [
  { ratio: '16:6', minWidth: 1600, role: 'HERO' },
  { ratio: '16:9', minWidth: 800, role: '实景图' },
  { ratio: '4:3', minWidth: 600, role: '美食图' },
];

process.stdout.write('\n【本地体检】项目发出的 size 是否落在 OpenAI 的枚举内\n\n');

const projectSizes = [];
for (const spec of PROJECT_SPECS) {
  const s = imageSizeFor(spec.ratio, spec.minWidth);
  const size = `${s.width}x${s.height}`;
  projectSizes.push({ ...spec, size, width: s.width, height: s.height });
  const accepted = Object.entries(OPENAI_SIZES)
    .filter(([, list]) => list.includes(size))
    .map(([m]) => m);
  process.stdout.write(
    `  ${accepted.length > 0 ? '✓' : '✗'} ${spec.role.padEnd(8)} ${spec.ratio.padEnd(5)} ` +
      `min_width=${String(spec.minWidth).padEnd(5)} → size="${size}"` +
      (accepted.length > 0 ? `  ${accepted.join(', ')}` : '  不被任何 OpenAI 图像模型接受') +
      '\n',
  );
}

const hits = projectSizes.filter((s) => ALL_OPENAI_SIZES.has(s.size)).length;
process.stdout.write(`\n  命中 ${hits} / ${projectSizes.length}\n`);
process.stdout.write('\n  OpenAI 各模型的枚举：\n');
for (const [m, list] of Object.entries(OPENAI_SIZES)) {
  process.stdout.write(`      ${m.padEnd(12)} ${list.join(' / ')}\n`);
}

if (hits === 0) {
  process.stdout.write(
    '\n  → 若中转站把请求转给 OpenAI 系图像模型，每一张都会被 400 拒掉。\n' +
      '    表现不是报错，而是**所有 AI 图静默降级为渐变占位图**\n' +
      '    （ASSET_AI_GENERATION_FAILED 只进 warnings，不阻断任务）。\n' +
      '    若转给 SD / Flux 系（接受任意尺寸），这一条不成立 —— 阶段 C 实测。\n',
  );
}

process.stdout.write(
  `\n  另需注意：超时硬上限 ${HARD_TIMEOUT_MS} ms（21.2 措施二），` +
    `loadImageConfig 拒绝更大值。\n` +
    `  本脚本用 ${timeoutMs} ms 探测，目的是测出**真实耗时**而不只是「超时了」。\n`,
);

if (dryRun) {
  process.stdout.write('\n--dry-run：跳过所有网络请求。\n');
  process.exit(0);
}

if (baseUrl === '' || apiKey === '' || model === '') {
  process.stderr.write(
    '\n缺少凭据。三项都要给（IMAGE_* 优先，缺省回落 LLM_*）：\n' +
      `  base-url  ${baseUrl || '(空)'}\n` +
      `  api-key   ${apiKey === '' ? '(空)' : `已给，长度 ${apiKey.length}`}\n` +
      `  model     ${model || '(空)'}\n\n` +
      '只想看本地体检结果时加 --dry-run。\n',
  );
  process.exit(2);
}

process.stdout.write(
  `\n【网络探测】\n` +
    `  base-url : ${baseUrl}（来自 ${flag('base-url') ? '--base-url' : baseUrlSrc.from}）\n` +
    `  model    : ${model}（来自 ${flag('model') ? '--model' : modelSrc.from}）\n` +
    `  api-key  : ${apiKey.slice(0, 4)}…（长度 ${apiKey.length}，来自 ${flag('api-key') ? '--api-key' : apiKeySrc.from}）\n`,
);
if (baseUrlSrc.from === 'LLM_BASE_URL' && flag('base-url') === '') {
  process.stdout.write('  ⚠ 用的是 LLM_* 凭据。确认这个中转站的图像与文本走同一地址与同一 key。\n');
}

const PROMPT =
  'A wide cinematic photo of West Lake in Hangzhou at sunrise, misty water, traditional pavilion, no text, no watermark';
const NEGATIVE = 'text, watermark, logo, people faces, low quality';

// ── 图片字节 → 真实像素 ─────────────────────────────────────

/**
 * 从字节头读出真实宽高。
 *
 * 这是本脚本最要紧的一项检查：供应商可能**接受** size 参数却返回别的尺寸
 * （忽略、或吸附到最近档位）。那时 11.2 的 processImage 会因宽度低于
 * min_width 而拒掉整张图 —— 请求 200、字节完好、却仍然降级成占位图。
 * 不看真实像素就发现不了。
 *
 * 只实现 PNG / JPEG / WebP 三种：图像端点的返回不出这三类。
 */
function readPixelSize(bytes) {
  const b = bytes;
  // PNG: 8 字节签名 + IHDR(长度4 + 类型4) → 宽高在 16..24
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20), format: 'PNG' };
  }
  // WebP: 'RIFF' .... 'WEBP'
  if (b.length > 30 && b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8X') {
      // 24 位小端，存的是 (实际值 - 1)
      const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
      const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
      return { width: w, height: h, format: 'WebP/VP8X' };
    }
    if (chunk === 'VP8 ') {
      const w = (b[26] | (b[27] << 8)) & 0x3fff;
      const h = (b[28] | (b[29] << 8)) & 0x3fff;
      return { width: w, height: h, format: 'WebP/VP8' };
    }
    return { width: null, height: null, format: `WebP/${chunk}` };
  }
  // JPEG: 扫描 SOFn 段
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = b[i + 1];
      // SOF0/1/2/9/10 都带宽高；跳过 SOF4(DHT) 与 SOF8/12(保留)
      if ([0xc0, 0xc1, 0xc2, 0xc9, 0xca].includes(marker)) {
        const h = (b[i + 5] << 8) | b[i + 6];
        const w = (b[i + 7] << 8) | b[i + 8];
        return { width: w, height: h, format: 'JPEG' };
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return { width: null, height: null, format: '未识别' };
}

// ── 请求 ────────────────────────────────────────────────────

async function callImages(endpointPath, body) {
  const url = `${baseUrl}${endpointPath}`;
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* 中转站故障时常返回 HTML 错误页 */
    }
    return { url, status: response.status, ok: response.ok, text, json, ms: elapsed() };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    return {
      url,
      status: 0,
      ok: false,
      text: `${name}: ${error instanceof Error ? error.message : String(error)}`,
      ms: elapsed(),
    };
  }
}

function errorDetail(res) {
  const e = res.json?.error;
  const msg = typeof e === 'string' ? e : (e?.message ?? res.json?.message);
  return (typeof msg === 'string' ? msg : res.text).replace(/\s+/g, ' ').slice(0, 400);
}

// ── 阶段 A：端点拼法 ────────────────────────────────────────

process.stdout.write('\n─ 阶段 A：端点拼法 ─────────────────────────────\n');
process.stdout.write('  HttpImageClient 拼的是 baseUrl + "/v1/images/generations"。\n\n');

let endpointPath = '';
for (const candidate of ['/v1/images/generations', '/images/generations']) {
  // 用 1024x1024（最通用）探路，避免尺寸问题污染端点判断
  const res = await callImages(candidate, { model, prompt: 'ping', size: '1024x1024' });
  process.stdout.write(
    `  ${res.url}\n      ${res.status === 404 ? '✗ 404（路径不存在）' : `✓ HTTP ${res.status}`}` +
      ` ${Math.round(res.ms)} ms\n`,
  );
  if (res.status === 0) process.stdout.write(`      ${res.text}\n`);
  else if (!res.ok) process.stdout.write(`      ${errorDetail(res)}\n`);
  if (endpointPath === '' && res.status !== 404 && res.status !== 0) endpointPath = candidate;
}

if (endpointPath === '') {
  process.stdout.write('\n  两种拼法都不可用。先确认 base-url 与该中转站是否开放图像端点。\n');
  process.exit(1);
}
process.stdout.write(`\n  采用：${endpointPath}\n`);
if (endpointPath !== '/v1/images/generations') {
  /*
   * 走到这里说明 base-url 带了 /v1（ofox 文档的 SDK 写法）。`loadImageConfig`
   * 现在会启动即拒这种取值，所以生产路径上不会出现 —— 但探针直接读 CLI 参数
   * 与环境变量、不过那道校验，因此这条提示仍然要在。
   */
  process.stdout.write(
    '  ⚠ 与 HttpImageClient 硬编码的路径不一致 → 去掉 base-url 尾部的 /v1。\n' +
      '    IMAGE_BASE_URL 带 /v1 会被 loadImageConfig 直接拒绝启动。\n',
  );
}

// ── 阶段 B：参数剥离阶梯 ────────────────────────────────────

const HERO = projectSizes[0];

/*
 * 阶梯里**没有 `n`**，与 `HttpImageClient.generate` 保持一致。
 *
 * 生产代码原来发 `n: 1`，接 ofox 时删掉了：OpenAI 的默认值就是 1（传与不传
 * 等价），而 Gemini 系图片模型不接受这个参数。这里跟着删是必须的 ——
 * P1 标着「= 生产行为」，两边不一致的话这份探测结论就是关于另一个请求的。
 */
const LADDER = [
  {
    id: 'P1',
    label: '原样（= HttpImageClient.generate 的生产行为）',
    body: {
      model,
      prompt: PROMPT,
      negative_prompt: NEGATIVE,
      seed: 42,
      size: HERO.size,
      response_format: 'b64_json',
    },
  },
  {
    id: 'P2',
    label: '去掉 response_format',
    body: { model, prompt: PROMPT, negative_prompt: NEGATIVE, seed: 42, size: HERO.size },
  },
  {
    id: 'P3',
    label: '再去掉 negative_prompt 与 seed',
    body: { model, prompt: PROMPT, size: HERO.size },
  },
  {
    id: 'P4',
    label: `size 换成 1024x1024（其余同 P3）`,
    body: { model, prompt: PROMPT, size: '1024x1024' },
  },
  { id: 'P5', label: '最小请求（只有 model 与 prompt）', body: { model, prompt: PROMPT } },
];

process.stdout.write('\n─ 阶段 B：参数剥离阶梯 ─────────────────────────\n');
process.stdout.write(
  `  自上而下逐项剥离，第一个转为成功的那一档就指出了肇事参数。\n` +
    `  HERO 的真实 size 是 ${HERO.size}（16:6，min_width ${HERO.minWidth}）。\n` +
    `  将发出 ${LADDER.length} 次真实调用 —— 图像调用比文本贵，注意成本。\n`,
);

const results = [];
for (const step of LADDER) {
  const res = await callImages(endpointPath, step.body);
  process.stdout.write(`\n  [${step.id}] ${step.label}\n`);
  process.stdout.write(`        请求键：${Object.keys(step.body).join(', ')}\n`);

  if (!res.ok) {
    process.stdout.write(
      `        ✗ HTTP ${res.status}  ${Math.round(res.ms)} ms\n        ${errorDetail(res)}\n`,
    );
    results.push({ ...step, verdict: 'http', status: res.status, ms: res.ms });
    continue;
  }

  const first = res.json?.data?.[0];
  const b64 = first?.b64_json;
  if (typeof b64 !== 'string' || b64.length === 0) {
    /*
     * 拿到 URL 而不是 b64_json 也算失败：image.ts 只读 b64_json，
     * 而二十章要求图片必须转存自己的对象存储、不直接引用第三方地址。
     */
    const gotUrl = typeof first?.url === 'string';
    process.stdout.write(
      `        ✗ 200 但缺 data[0].b64_json` +
        (gotUrl ? '（只给了 url —— image.ts 不读 url，会报「响应缺少」）' : '') +
        `  ${Math.round(res.ms)} ms\n`,
    );
    results.push({ ...step, verdict: gotUrl ? 'url-only' : 'no-b64', ms: res.ms });
    continue;
  }

  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  const pixels = readPixelSize(bytes);
  const wanted = step.body.size ?? '(未指定)';
  const actual = pixels.width === null ? '未能解析' : `${pixels.width}x${pixels.height}`;
  const sizeMatches = actual === wanted;

  process.stdout.write(
    `        ✓ HTTP 200  ${Math.round(res.ms)} ms  ${(bytes.byteLength / 1024).toFixed(0)} KB  ` +
      `${pixels.format}\n`,
  );
  process.stdout.write(
    `        请求 size=${wanted} → 实际 ${actual}  ` + (sizeMatches ? '✓ 一致' : '⚠ 不一致') + '\n',
  );

  const notes = [];
  if (!sizeMatches && pixels.width !== null && step.body.size !== undefined) {
    const enough = pixels.width >= HERO.minWidth;
    notes.push(
      enough
        ? '宽度仍 ≥ min_width，processImage 可通过'
        : `⚠ 宽度 ${pixels.width} < min_width ${HERO.minWidth} → processImage 会拒 → 静默降级占位图`,
    );
  }
  if (first?.seed !== undefined) notes.push(`回传 seed=${first.seed}（可复现性成立）`);
  else if (step.body.seed !== undefined)
    notes.push('未回传 seed（记录的是「请求了什么」，非「产物由什么决定」）');
  if (res.ms > HARD_TIMEOUT_MS) {
    notes.push(`⚠ 耗时超过 ${HARD_TIMEOUT_MS} ms 硬上限 → 生产上必然 ImageTimeoutError → 降级`);
  }
  notes.forEach((n) => process.stdout.write(`        ${n}\n`));

  results.push({
    ...step,
    verdict: 'pass',
    ms: res.ms,
    pixels,
    sizeMatches,
    tooSlow: res.ms > HARD_TIMEOUT_MS,
  });
}

// ── 结论 ────────────────────────────────────────────────────

process.stdout.write('\n─ 结论 ─────────────────────────────────────────\n\n');
for (const r of results) {
  const icon = r.verdict === 'pass' ? (r.tooSlow || !r.sizeMatches ? '~' : '✓') : '✗';
  const tail =
    r.verdict === 'http' ? ` (HTTP ${r.status})` : r.verdict !== 'pass' ? ` (${r.verdict})` : '';
  process.stdout.write(`  ${icon} ${r.id}  ${r.label}${tail}  ${Math.round(r.ms)} ms\n`);
}

const firstPass = results.find((r) => r.verdict === 'pass');
process.stdout.write('\n');

if (firstPass === undefined) {
  process.stdout.write(
    '  五档全败。图像能力接不上，先与中转站确认它代理的是哪个图像模型\n' +
      '  以及该模型的请求契约。IMAGE_MODE 先保持 fake。\n',
  );
} else if (firstPass.id === 'P1') {
  process.stdout.write(
    '  生产代码可直接用：IMAGE_MODE=direct + 三个 IMAGE_* 变量。\n' +
      (firstPass.sizeMatches ? '' : '  但返回像素与请求不一致，见上面那行的 min_width 判断。\n') +
      (firstPass.tooSlow ? '  但耗时超过 20 秒硬上限 —— 这不是调参能解决的，见下。\n' : ''),
  );
} else {
  const culprit = {
    P2: 'response_format —— 该模型不接受这个参数（gpt-image-1 总是返回 b64_json，传了即报未知参数）',
    P3: 'negative_prompt / seed —— image.ts:176-181 假设「多传的字段被忽略而不是报错」，这条假设在此端点上不成立',
    P4: `size —— ${HERO.size} 不被接受，而项目所有比例算出的尺寸都不在 OpenAI 枚举内`,
    P5: 'size 与 n 之外还有别的参数不被接受（P4 也失败了）',
  }[firstPass.id];
  process.stdout.write(`  需要改代码。第一个通过的是 ${firstPass.id}，肇事者：\n    ${culprit}\n`);
}

if (results.some((r) => r.tooSlow)) {
  process.stdout.write(
    `\n  关于耗时：loadImageConfig 硬拒 IMAGE_TIMEOUT_MS > ${HARD_TIMEOUT_MS}（21.2 的 T2 SLA\n` +
      '  就是按这个数算出来的）。所以慢模型不能靠放宽超时解决，只有两条路：\n' +
      '    换更快的图像模型；或把 AI 生成移出主路径（预热，见 assets:preheat）。\n',
  );
}

process.exit(firstPass === undefined ? 1 : 0);
