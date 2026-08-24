#!/usr/bin/env node
/**
 * 生成一份可以离线双击打开的前端页面快照。
 *
 *   pnpm mvp:up          # 整栈 + 本地反代必须先跑起来
 *   pnpm preview
 *   # 产物在 preview/，双击任一 .html
 *
 * ## 它解决什么
 *
 * 「把当前前端发给别人看」或「不跑 Docker 也能翻一遍页面」。**交互式预览不用
 * 它** —— 直接开 http://localhost:8080 才是真的（注册、改密码、生成弹层这些
 * 需要后端的状态在离线快照里一律看不到，见产物里的 说明.md）。
 *
 * ## 四个页面，两条取数路径
 *
 * ```text
 * /                          经反代取     采集工作台（服务端渲染的外壳）
 * /legal                     经反代取     用户协议与隐私政策（构建期静态预渲染）
 * /render/plans/{pv}/full     容器内取     完整计划信息图
 * /render/plans/{pv}/days/1   容器内取     单日信息图
 * ```
 *
 * `/render/**` 走不了反代 —— 那个前缀对公网 404（前端接入契约第 10 节），
 * 而且受 HMAC 令牌保护。因此**在容器里签令牌、在容器里取页面**，
 * 只把 HTML 拷出来：`RENDER_SIGNING_KEY` 不出容器，令牌也不进宿主的命令行历史。
 *
 * ## 为什么每次都新生成一份计划
 *
 * `/render/**` 需要一个已完成编排的 `plan_version_id`。从库里翻旧的要么得连
 * Postgres（多一层耦合、多一份口令），要么得知道是哪个用户的 —— 而
 * `LLM_MODE=fake` 下重新生成一份只要一分多钟。想复用已有的传 `--plan-version`。
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根。夹具按它定位，而不是按 cwd —— 换个目录跑不该断 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 参数 ────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    out: 'preview',
    base: 'http://127.0.0.1:8080',
    container: 'tps-render-worker',
    planVersion: null,
    keepRaw: false,
    frontendOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // `pnpm preview -- --out x` 会把这个裸 `--` 原样传进来
    if (arg === '--') continue;
    else if (arg === '--keep-raw') options.keepRaw = true;
    else if (arg === '--frontend-only') options.frontendOnly = true;
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--base') options.base = argv[++i];
    else if (arg === '--container') options.container = argv[++i];
    else if (arg === '--plan-version') options.planVersion = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          '用法：node tools/build-preview.mjs [选项]',
          '',
          '  --out DIR             产物目录（默认 preview）',
          '  --base URL            反代地址（默认 http://127.0.0.1:8080）',
          '  --plan-version UUID   复用已有的计划版本，跳过生成',
          '  --container NAME      签令牌用的容器（默认 tps-render-worker）',
          '  --keep-raw            保留本地化之前的原始 HTML',
          '  --frontend-only       只更新采集页与政策页，不访问 API 或 Docker',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`无法识别的参数：${arg}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const OUT = options.out;

function say(line) {
  process.stdout.write(`${line}\n`);
}

function fail(message, hint) {
  process.stderr.write(`\n✗ ${message}\n`);
  if (hint !== undefined) process.stderr.write(`  ${hint}\n`);
  process.exit(1);
}

// ── Cookie ──────────────────────────────────────────────────

/**
 * 最小 cookie 罐。
 *
 * 身份完全依赖 HttpOnly Cookie（13.0），而 Node 的 fetch 不带 cookie 存储。
 * 只存「名=值」，不管 Path / Expires —— 这个脚本的全部请求都在同一个源下，
 * 且只活几分钟。
 */
const jar = new Map();

function rememberCookies(response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value.length === 0) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function api(path, init = {}) {
  const headers = { ...init.headers };
  if (jar.size > 0) headers.cookie = cookieHeader();
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${options.base}${path}`, { ...init, headers });
  rememberCookies(response);

  const text = await response.text();
  let body = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

// ── 第 1 步：探活 ───────────────────────────────────────────

async function checkStack() {
  let probe;
  try {
    probe = await api('/api/v1/auth/session');
  } catch (error) {
    fail(
      `连不上 ${options.base}（${error.message}）`,
      '先跑 pnpm mvp:up。注意是 8080 而不是 3000 —— 3000 上没有 /api 反代。',
    );
  }

  if (probe.status === 404) {
    fail(
      `${options.base}/api/v1/auth/session 返回 404`,
      '这是「没有反代」的症状：web 直接暴露在这个端口上。用 8080（deploy/local-proxy.yml）。',
    );
  }
  if (probe.status !== 401) {
    fail(
      `会话端点返回 ${probe.status}，预期 401`,
      '401 才是 P7 的正确响应（未注册请求一律拒）。200 说明 FEATURE_ANONYMOUS_ENABLED 被打开了。',
    );
  }
  say(`✓ 反代与 api 就绪（会话端点 401，符合 P7）`);
}

// ── 第 2 步：造一份计划 ─────────────────────────────────────

/** `YYYY-MM-DD`，从今天往后 offset 天 */
function isoDate(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function generatePlan() {
  const stamp = Date.now();
  const email = `preview-${stamp}@example.invalid`;

  const registered = await api('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email,
      // 一次性账号，口令只要过得了强度校验（≥10 字符且不在弱口令字典里）
      password: `preview-${stamp}-passphrase`,
      display_name: '预览快照',
    }),
  });
  if (registered.status !== 201) {
    fail(`注册失败（${registered.status}）`, JSON.stringify(registered.body));
  }
  say(`✓ 一次性账号 ${email}`);

  /*
   * 请求体照抄最小必填集夹具，只改三处：幂等键（13.8 每次必须换）、
   * 日期（N-01 要求不早于今天）、时区（跟宿主一致，免得 N-01 差一天）。
   */
  const fixture = JSON.parse(
    await readFile(
      join(REPO_ROOT, 'packages/schemas/fixtures/travel-request.minimal.json'),
      'utf8',
    ),
  );
  const request = {
    ...fixture,
    client_request_id: `preview-${stamp}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    trip: {
      ...fixture.trip,
      dates: { start_date: isoDate(30), end_date: isoDate(32) },
    },
  };

  const submitted = await api('/api/v1/travel-plans/generate', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  if (submitted.status !== 201) {
    fail(`提交失败（${submitted.status}）`, JSON.stringify(submitted.body));
  }
  const { job_id: jobId, plan_id: planId } = submitted.body;
  say(`✓ 已入队 job=${jobId}`);

  /*
   * 轮到 COMPLETED 而不是「计划可读」。
   *
   * `/render/**` 读的是**落库的 ViewModel**（plan_presentations），它在
   * BUILDING_PRESENTATION 阶段才写入 —— 而那一步在 SAVING_PLAN 之后。
   * 停在「可读」就取页面，会拿到 404。
   */
  const deadline = Date.now() + 320_000;
  let last = '';
  while (Date.now() < deadline) {
    const job = await api(`/api/v1/generation-jobs/${jobId}`);
    if (job.status !== 200) fail(`查任务失败（${job.status}）`, JSON.stringify(job.body));

    const { status, progress, message } = job.body;
    const line = `  ${String(progress).padStart(3)}% ${status} ${message}`;
    if (line !== last) {
      say(line);
      last = line;
    }
    if (status === 'FAILED') fail(`生成失败：${message}`);
    if (status === 'COMPLETED') break;

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  const presentation = await api(`/api/v1/travel-plans/${planId}/presentations/full`);
  if (presentation.status !== 200) {
    fail(
      `编排产物还没就绪（${presentation.status}）`,
      '任务已完成但 plan_presentations 里没有 FULL_PLAN —— 看 generation-worker 的日志。',
    );
  }

  const planVersionId = presentation.body.plan_version_id;
  say(`✓ plan_version_id=${planVersionId}`);
  return planVersionId;
}

// ── 第 3 步：容器内签令牌 + 取渲染页 ───────────────────────

/**
 * 在容器里跑一段 Node：签令牌、取页面、写进容器的 /tmp。
 *
 * 令牌与密钥都留在容器里。让宿主拿到令牌也「只」是一个 120 秒的一次性凭据，
 * 但它会进 shell 历史与本脚本的输出 —— 没有理由让它出去。
 */
function fetchRenderPages(planVersionId) {
  const script = `
    const { issueRenderToken } = require('/app/node_modules/@tps/shared/dist/index.js');
    const fs = require('node:fs');

    const key = process.env.RENDER_SIGNING_KEY;
    if (!key) {
      console.error('容器里没有 RENDER_SIGNING_KEY');
      process.exit(2);
    }

    const planVersionId = ${JSON.stringify(planVersionId)};
    const pages = [
      ['full', 'full', '/render/plans/' + planVersionId + '/full'],
      ['day1', 'day:1', '/render/plans/' + planVersionId + '/days/1'],
    ];

    (async () => {
      fs.mkdirSync('/tmp/tps-preview', { recursive: true });
      for (const [name, pageKey, path] of pages) {
        const token = issueRenderToken(
          { planVersionId, pageKey, jti: name + '-' + Date.now() },
          key,
        );
        // 令牌走请求头（middleware.ts 的 RENDER_TOKEN_HEADER），不是查询串 ——
        // 查询串会进 web 容器的访问日志，而它是一个能读用户私有计划的凭据
        const response = await fetch('http://web:3000' + path, {
          headers: { 'x-render-token': token },
        });
        if (!response.ok) {
          console.error(name + ' → HTTP ' + response.status);
          process.exit(3);
        }
        const html = await response.text();
        fs.writeFileSync('/tmp/tps-preview/' + name + '.html', html, 'utf8');
        console.log(name + ' ← ' + html.length + ' 字节');
      }
    })();
  `;

  const result = spawnSync(
    'docker',
    ['exec', '-w', '/app', options.container, 'node', '-e', script],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) {
    fail(
      `在 ${options.container} 里取渲染页失败`,
      (result.stderr || result.stdout || '').trim() ||
        '容器不在？确认 pnpm mvp:up 起来了，或用 --container 指定名字。',
    );
  }
  for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
    say(`  ${line}`);
  }
}

/** 把容器 /tmp 里的原始 HTML 拷出来 */
function copyRenderPages() {
  for (const name of ['full', 'day1']) {
    const result = spawnSync(
      'docker',
      [
        'cp',
        `${options.container}:/tmp/tps-preview/${name}.html`,
        join(OUT, 'raw', `${name}.html`),
      ],
      { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    if (result.status !== 0) fail(`拷 ${name}.html 失败`, result.stderr.trim());
  }
}

// ── 第 4 步：离线化 ─────────────────────────────────────────

/** 已下载的资源，避免同一份 CSS 被四个页面重复取 */
const fetched = new Set();

async function save(relPath, bytes) {
  const target = join(OUT, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

async function download(url, relPath) {
  if (fetched.has(relPath)) return true;

  const response = await fetch(url);
  if (!response.ok) {
    say(`  ! ${response.status} ${url}`);
    return false;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fetched.add(relPath);

  /*
   * CSS 里还有 url(/_next/static/media/...)。递归一层就够 ——
   * Next 的 media 引用只出现在 CSS 里，不会再往下嵌。
   */
  if (relPath.endsWith('.css')) {
    let css = buffer.toString('utf8');
    for (const inner of new Set(
      [...css.matchAll(/url\(\s*["']?(\/[^)"']+)["']?\s*\)/g)].map((m) => m[1]),
    )) {
      const innerRel = inner.replace(/^\//, '');
      await download(`${options.base}${inner}`, innerRel);
      // CSS 在 _next/static/css/ 下，要回退到根
      const back = '../'.repeat(relPath.split('/').length - 1);
      css = css.split(inner).join(`${back}${innerRel}`);
    }
    await save(relPath, Buffer.from(css, 'utf8'));
    return true;
  }

  await save(relPath, buffer);
  return true;
}

/** 把 MinIO 的 URL 压成扁平文件名，避免 assets/xx/yy 的深目录 */
function flatten(url) {
  const name = new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('-');
  return `media/${name}`;
}

async function localize(page) {
  say(`\n${page}`);
  let html = await readFile(join(OUT, 'raw', page), 'utf8');

  /*
   * 1. href / src 属性里的同源资源。
   *
   * **只能按属性匹配，不能全文替换。** Next 会把服务端渲染用过的那份 CSS 与
   * 组件树再序列化一遍放进 `self.__next_f`（RSC payload，供水合用）。全文替换
   * 会一起改掉那份副本，而它一旦对不上，水合就抛错并把已经渲染好的内容清空 ——
   * 实测表现是「页面只剩视口那么高、一张图都没有」，而 HTML 看着完全正常。
   */
  const local = new Set(
    [...html.matchAll(/(?:href|src)="(\/(?:_next|fonts)\/[^"]+)"/g)].map((m) => m[1]),
  );
  for (const path of local) {
    const rel = decodeURI(path).replace(/^\//, '');
    if (await download(`${options.base}${path}`, rel)) {
      html = html.split(`"${path}"`).join(`"${rel}"`);
    }
  }

  /*
   * 2. 内联 `<style>` 里的 `url('/fonts/x.woff2')`。
   *
   * 这些漏在属性匹配之外，而 500 字重**只**出现在这里（preload 只预载 400/700）。
   * 按**下标**切出 style 的内容再改，不用字符串替换 —— 那段 CSS 在 payload 里
   * 有一份字节相同的副本，替换会同时命中它。
   */
  const styleRanges = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  let rebuilt = '';
  let cursor = 0;
  for (const match of styleRanges) {
    const start = match.index + '<style>'.length;
    let css = match[1];
    for (const path of new Set([...css.matchAll(/\/fonts\/[A-Za-z0-9._-]+/g)].map((m) => m[0]))) {
      const rel = path.replace(/^\//, '');
      if (await download(`${options.base}${path}`, rel)) css = css.split(path).join(rel);
    }
    rebuilt += html.slice(cursor, start) + css;
    cursor = start + match[1].length;
  }
  html = rebuilt + html.slice(cursor);

  /*
   * 3. 字体改成 data URI。
   *
   * 路径改对了还不够：`@font-face` 取字体一律按 CORS 模式发起，而 `file://`
   * 文档的源是不透明的 —— 浏览器直接拒掉，表现与「文件不存在」一模一样。
   * 而模板用 `font-display: block`：字体没到位时**一个字都不画**。
   *
   * 抽成外部 `fonts.css` 而不是内联进 HTML：几个字重 base64 之后有 10 MB，
   * 四个页面各内联一份会让 HTML 变成 40 MB。
   */
  const fontFaces = [...html.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
  if (fontFaces.length > 0) {
    let css = '';
    /*
     * 按**字体文件 + 字重**去重。同一份 CSS 在页面里出现两次：`<style>` 标签
     * 一次、RSC payload 里的转义副本一次。两份内容相同但字节不同，
     * 因此不能按整块字符串去重 —— 不去重的话每个字体被 base64 两遍。
     */
    const seen = new Set();
    for (const block of fontFaces) {
      const file = /url\(['"]?(fonts\/[^'")]+)['"]?\)/.exec(block)?.[1];
      // payload 里那份副本的 url 还是绝对路径，匹配不上 —— 跳过它
      if (file === undefined) continue;

      const weight = /font-weight:\s*(\d+)/.exec(block)?.[1] ?? '400';
      const key = `${file}:${weight}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const bytes = await readFile(join(OUT, file));
      css += `${block.replace(
        /url\(['"]?fonts\/[^'")]+['"]?\)/,
        `url(data:font/woff2;base64,${bytes.toString('base64')})`,
      )}\n`;
    }
    if (css.length > 0) await save('fonts.css', Buffer.from(css, 'utf8'));

    /*
     * 挂在 `</head>` 之前，也就是原来那个内联 `<style>` **之后**，靠层叠覆盖 ——
     * 同 family 同字重时后声明的胜出，浏览器只取胜出那一份，失败的那条连请求
     * 都不发。删原块的代价是它在 RSC payload 里还有一份副本，
     * 整份文档做字符串替换会把那份一起改坏（见上面第 1 条）。
     */
    html = html.replace('</head>', '<link rel="stylesheet" href="fonts.css"/></head>');
  }

  /*
   * 4. MinIO 的图片与路线图 SVG。
   *
   * 这一处**是**全文替换，而且必须是：RSC payload 里也有这些 URL，
   * 不一起改的话水合会把 `<img>` 的 src 覆写回绝对地址，离线时图片全裂。
   */
  const remote = new Set(
    [...html.matchAll(/(?:href|src)="(https?:\/\/(?:localhost|127\.0\.0\.1):9000\/[^"]+)"/g)].map(
      (m) => m[1],
    ),
  );
  for (const url of remote) {
    const rel = flatten(url);
    if (await download(url, rel)) html = html.split(url).join(rel);
  }

  await save(page, Buffer.from(html, 'utf8'));
  say(`  ← 同源 ${local.size} 个、远端 ${remote.size} 个`);
}

// ── 说明 ────────────────────────────────────────────────────

async function writeReadme(planVersionId) {
  await save(
    '说明.md',
    Buffer.from(
      `# 前端页面离线预览

双击任一 \`.html\` 即可在浏览器里打开，**不需要跑任何服务**。
由 \`pnpm preview\`（\`tools/build-preview.mjs\`）生成。

| 文件 | 是什么 |
| --- | --- |
| \`planner.html\` | 首页：需求采集工作台（三栏九步 + 生成后的行前准备中心） |
| \`legal.html\` | 用户协议与隐私政策 |
| \`full.html\` | 完整计划信息图（长图版） |
| \`day1.html\` | 单日信息图（第 1 天） |

数据来自本机 fake 模式现场生成的一份真实计划（\`plan_version_id\`
\`${planVersionId}\`），不是手写的静态样例。

## 交互式预览请用 http://localhost:8080

这份快照**看不到任何需要后端的状态**：注册与登录表单、改密码、生成等待弹层、
计划页。想试那些就 \`pnpm mvp:up\` 然后开 8080 —— 那才是这个应用本身。

## 三处与线上不同，是环境所致而不是缺陷

**1. 图片是开发占位图。** \`IMAGE_MODE=fake\` 下 Hero 与配图由本机 sharp 画的
渐变图充当，上面印着 \`IMAGE_MODE=fake\`。线上接真实图像模型后这些位置是 AI
插画或素材库照片。**版式、比例、圆角、遮罩层都是真的** —— 只有像素内容是占位。
路线图 SVG 是程序生成的，与线上完全一致。

**2. \`planner.html\` 右上角的「用户登录」无法完成登录。** 离线打开时没有后端，
展开菜单后会显示会话请求失败。其余表单可以点、可以填（JS 一起带下来了），但
「生成旅行方案」按不动（未登录时它本来就是禁用的）。

**3. 控制台里有几条字体请求失败。** 那是 \`<link rel="preload" as="font">\` 带
\`crossorigin\`，在 \`file://\` 下必然被 CORS 拒掉。**字体本身没问题** ——
它们以 data URI 内联在 \`fonts.css\` 里，中文用思源黑体 / 思源宋体，与线上一致。

## 为什么字体必须内联

\`@font-face\` 取字体一律按 CORS 模式发起，而 \`file://\` 文档的源是不透明的 ——
浏览器直接拒掉，表现和「文件不存在」一样。而模板用的是 \`font-display: block\`：
字体没到位时**一个字都不画**。不内联的话双击打开会先空白三秒，再退回系统字体，
中文字形与线上明显不同。

## \`/plans/{planId}\` 为什么不在这里

它是客户端组件，内容靠浏览器里的 JS 调 API 拿。存成静态文件只会得到一个空壳。
\`full.html\` 用的是同一套模板（\`travel-full-plan-v1\`），所以视觉上看到的就是
那个页面加载完之后的样子。
`,
      'utf8',
    ),
  );
}

// ── 主流程 ──────────────────────────────────────────────────

await mkdir(join(OUT, 'raw'), { recursive: true });

let planVersionId = options.planVersion;
if (!options.frontendOnly) {
  await checkStack();
  planVersionId = options.planVersion ?? (await generatePlan());
  say('\n取渲染页（容器内签令牌）');
  fetchRenderPages(planVersionId);
  copyRenderPages();
}

say('\n取采集页与政策页');
for (const [name, path] of [
  ['planner.html', '/'],
  ['legal.html', '/legal'],
]) {
  const response = await fetch(`${options.base}${path}`);
  if (!response.ok) fail(`取 ${path} 失败（HTTP ${response.status}）`);
  await save(join('raw', name), Buffer.from(await response.arrayBuffer()));
  say(`  ${name} ← ${path}`);
}

say('\n离线化');
const pages = options.frontendOnly
  ? ['planner.html', 'legal.html']
  : ['planner.html', 'legal.html', 'full.html', 'day1.html'];
for (const page of pages) {
  await localize(page);
}

if (!options.frontendOnly) await writeReadme(planVersionId);

if (!options.keepRaw) await rm(join(OUT, 'raw'), { recursive: true, force: true });

say(`\n✓ 共 ${fetched.size} 个资源 → ${OUT}/`);
say(
  `  双击 ${join(OUT, 'planner.html')} 开始看；交互式预览请用 ${options.frontendOnly ? options.base : 'http://localhost:8080'}`,
);
