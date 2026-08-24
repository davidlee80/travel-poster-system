#!/usr/bin/env node
/**
 * 前端请求体校验器（P8，R-56）。
 *
 *   node tools/validate-travel-request.mjs path/to/request.json
 *   node tools/validate-travel-request.mjs --self-test
 *
 * ## 存在的理由
 *
 * 前端呈现层可以整体替换（任意 HTML / 任意框架），而替换者需要一个
 * **不依赖后端在跑**的方式确认自己拼的 JSON 合法。把 Zod 直接暴露成命令行，
 * 比让人读文档猜字段可靠得多 —— 尤其是「哪些字段可以不传」这一类问题，
 * 文档会过时而 schema 不会。
 *
 * ## 为什么必须有 --self-test
 *
 * 一个恒返回 0 的校验器会让所有模板都「通过」，而那种失效是完全静默的：
 * CI 绿、命令行绿、直到某个模板的请求在生产被 400 拒掉。
 * 自测用一份**已知非法**的输入反证它真的会拒。
 *
 * ## 输出格式与 API 对齐
 *
 * 打印 `issue.path` 而不只是 message：13.7 要求请求校验错误带 `field`
 * 以便前端高亮出错的表单项，而 `field` 就是从同一个 path 来的。
 * 因此这里的输出可以直接对照 API 的错误体读。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * 从 dist 引 schema 而不是 src：与 tools/ 下其他脚本一致（它们都是纯 node，
 * 不经 ts 编译）。因此使用前需要 `pnpm --filter @tps/schemas run build`，
 * 由 package.json 的 `validate:request` 别名负责。
 *
 * fileURLToPath 而不是 new URL(...).pathname —— 后者在 Windows 上返回
 * "/E:/..." 这种带前导斜杠的非法路径（见 next.config.mjs 里的同类说明）。
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = path.join(repoRoot, 'packages', 'schemas', 'dist', 'index.js');

/** @type {{ TravelRequestUISchema: import('zod').ZodType }} */
let schemas;
try {
  schemas = await import(`file://${distEntry.split(path.sep).join('/')}`);
} catch (error) {
  process.stderr.write(
    `无法加载 @tps/schemas 的构建产物：${distEntry}\n` +
      `先运行 pnpm --filter @tps/schemas run build（或用 pnpm validate:request）。\n` +
      `原始错误：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}

const { TravelRequestUISchema } = schemas;

/**
 * 校验一个已解析的 JSON 值。
 *
 * @param {unknown} value
 * @param {string} label 出现在输出里的来源名
 * @returns {boolean} 是否合法
 */
function validate(value, label) {
  const result = TravelRequestUISchema.safeParse(value);

  if (result.success) {
    process.stdout.write(`✓ ${label} 合法\n`);
    return true;
  }

  process.stdout.write(`✗ ${label} 非法：\n`);
  for (const issue of result.error.issues) {
    const field = issue.path.length > 0 ? issue.path.join('.') : '(根)';
    process.stdout.write(`  ${field}: ${issue.message}\n`);
  }
  return false;
}

/**
 * 自测：一份合法输入必须过，一份已知非法的必须被拒。
 *
 * 两个方向都测。只测「合法的能过」的话，一个 `return true` 的实现也能通过。
 */
async function selfTest() {
  /** 只带 11 个必填字段 —— 契约的最低门槛 */
  const minimal = {
    schema_version: 'travel_request_ui_v1',
    client_request_id: 'self-test-1',
    timezone: 'Asia/Shanghai',
    trip: {
      origin: { text: '上海' },
      destination: { text: '杭州' },
      dates: { start_date: '2026-10-01', end_date: '2026-10-03' },
    },
    travelers: { adults: 2 },
    budget: { basis: 'PER_PERSON_PER_DAY', min: 300, max: 800 },
  };

  const cases = [
    { label: '最小必填集', value: minimal, expectValid: true },
    {
      label: '缺 budget.basis',
      // basis 决定 min/max 是人均每天还是全程总额，猜错偏差约（人数 × 天数）
      value: { ...minimal, budget: { min: 300, max: 800 } },
      expectValid: false,
    },
    {
      /*
       * 域前缀不在白名单内。
       *
       * 这条反证曾经用 `diet.kosher`，而 P9 把犹太洁食加进了条件字典 ——
       * 于是「期望非法」变成了错的。换成一个域前缀本身不存在的 code：
       * `ConditionCodeSchema` 校验的正是域前缀（七个既有域之一），
       * 而具体 code 在不在字典里由服务端的 N-08 判定（配置中心可以发布新码，
       * 见 conditions.ts）—— 因此 schema 层唯一能拒的就是域。
       */
      label: '条件 code 的域前缀不在白名单内',
      value: { ...minimal, conditions: [{ code: 'weather.sunny', mode: 'MUST', value: true }] },
      expectValid: false,
    },
    {
      label: 'schema_version 是 v2',
      value: { ...minimal, schema_version: 'travel_request_ui_v2' },
      expectValid: false,
    },
  ];

  let failures = 0;
  for (const kase of cases) {
    const actual = TravelRequestUISchema.safeParse(kase.value).success;
    const ok = actual === kase.expectValid;
    if (!ok) failures += 1;
    process.stdout.write(
      `  ${ok ? '✓' : '✗'} ${kase.label}：期望${kase.expectValid ? '合法' : '非法'}，` +
        `实得${actual ? '合法' : '非法'}\n`,
    );
  }

  if (failures > 0) {
    process.stdout.write(`自测失败 ${failures} 项 —— 校验器本身不可信\n`);
    return 1;
  }
  process.stdout.write('自测通过（4 项，含 3 项反证）\n');
  return 0;
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');

if (args.includes('--self-test')) {
  process.exit(await selfTest());
}

if (args.length === 0) {
  process.stderr.write(
    '用法：node tools/validate-travel-request.mjs <request.json> [更多文件...]\n' +
      '      node tools/validate-travel-request.mjs --self-test\n',
  );
  process.exit(2);
}

let bad = 0;
for (const file of args) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    process.stdout.write(
      `✗ ${file} 不是合法 JSON：${error instanceof Error ? error.message : ''}\n`,
    );
    bad += 1;
    continue;
  }
  if (!validate(parsed, file)) bad += 1;
}

process.exit(bad === 0 ? 0 : 1);
