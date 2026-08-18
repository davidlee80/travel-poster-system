#!/usr/bin/env node
/**
 * 扫描日志调用里的敏感载荷插值（TP-5-02，设计稿 21.3、二十章）。
 *
 * ## redact 挡不住什么
 *
 * `@tps/shared` 的 logger 在序列化层剥离禁记字段（见 logger.ts 的 REDACT_PATHS），
 * 因此 `log.info({ email })` 是安全的 —— 落盘时值已经变成 `[REDACTED]`。
 *
 * 但 redact 只看**字段名**。这两种写法它完全看不见：
 *
 * ```ts
 * log.info({}, `请求内容：${JSON.stringify(rawRequest)}`);   // 进的是 msg 字符串
 * log.warn({}, `投影：${projection.destination.name}`);        // 同上
 * ```
 *
 * `msg` 是一个普通字符串，redact 不会去里面找 email。而这种写法在排查问题时
 * 是最自然的冲动（「把整个载荷打出来看看」），也是这类系统最常见的泄漏方式 ——
 * 一次上线后，用户的原始需求文本就永久留在日志归档里了。
 *
 * 因此这一条只能由静态检查兜：在 message 里插值禁记标识符即失败。
 *
 * ## 为什么禁记清单从源码里解析
 *
 * 本工具是 `.mjs`，不能 import `logger.ts` 的 `FORBIDDEN_KEYS`。而复制一份
 * 清单必然与实现分歧 —— 通常是有人往 logger.ts 加了一个键、忘了同步这里，
 * 于是那个键在 message 里就是自由的。因此这里**解析 logger.ts 的数组字面量**，
 * 并断言解析到的数量下限（解析失效时立刻报错，而不是静默放行一切）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const LOGGER_SOURCE = join(ROOT, 'packages/shared/src/logger.ts');

/** 解析失效的下限。当前实现有 22 个键，低于这个数说明正则没匹配上 */
const MIN_EXPECTED_KEYS = 15;

const SCAN_DIRS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', '.next', 'generated', '__visual__']);

/** logger 的方法名。`fatal` 也算 —— 崩溃前打载荷同样会落盘 */
const LOG_METHODS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function forbiddenKeys() {
  const source = readFileSync(LOGGER_SOURCE, 'utf8');
  const match = /const FORBIDDEN_KEYS = \[([\s\S]*?)\] as const;/.exec(source);
  if (match === null) {
    throw new Error(`无法在 ${relative(ROOT, LOGGER_SOURCE)} 里定位 FORBIDDEN_KEYS 数组`);
  }

  const keys = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (keys.length < MIN_EXPECTED_KEYS) {
    throw new Error(
      `只解析到 ${keys.length} 个禁记键（预期至少 ${MIN_EXPECTED_KEYS} 个）。` +
        'logger.ts 的写法可能变了 —— 请修正本工具的正则，而不是降低下限',
    );
  }
  return keys;
}

/**
 * 由禁记键派生标识符匹配正则。
 *
 * 同时覆盖蛇形与驼峰：`raw_request` 与 `rawRequest` 是同一个东西的两种写法，
 * 而变量名在 TypeScript 侧通常是后者。
 */
function identifierPattern(keys) {
  const variants = new Set();
  for (const key of keys) {
    variants.add(key.toLowerCase().replace(/_/g, ''));
  }
  return variants;
}

function normalizeIdentifier(text) {
  return text.toLowerCase().replace(/[_\s]/g, '');
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    /*
     * 测试文件也扫。测试里把载荷打进日志同样会落到 CI 日志归档里，
     * 而 CI 日志的访问范围通常比生产日志更宽。
     */
    yield full;
  }
}

/** 从 `start` 处的 `(` 开始，返回括号平衡的调用文本 */
function extractCall(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (quote !== null) {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 只暴露体量而非内容的表达式，放过。
 *
 * `${rawText.length}` 是**推荐**写法：排查「模型为什么没读到需求」时需要知道
 * 原文有没有内容，而长度足以回答，且它不泄漏任何一个字。
 * 把这类写法也拦掉会让开发者绕过整个门禁（`// eslint-disable` 式的对抗），
 * 那比留一个精确的例外更糟。
 */
const SIZE_ONLY = /\.(length|size|byteLength)\s*$/;

/** 调用文本里的可疑插值 */
function violationsIn(call, forbidden) {
  const found = [];

  /*
   * 模板插值。不支持插值里再有 `}`（如对象字面量），那种写法在日志 message
   * 里极少见，且漏检一个总比误报一片好 —— 一个总在报假警的门禁会被关掉。
   */
  for (const match of call.matchAll(/\$\{([^{}]*)\}/g)) {
    const expression = match[1];
    if (SIZE_ONLY.test(expression)) continue;
    for (const key of forbidden) {
      if (normalizeIdentifier(expression).includes(key)) {
        found.push({ expression: expression.trim(), key });
        break;
      }
    }
  }

  // JSON.stringify(x) 即使不在模板里也一样：它的产物只会进 message
  for (const match of call.matchAll(/JSON\.stringify\(\s*([A-Za-z_$][\w.$[\]']*)/g)) {
    const argument = match[1];
    for (const key of forbidden) {
      if (normalizeIdentifier(argument).includes(key)) {
        found.push({ expression: `JSON.stringify(${argument})`, key });
        break;
      }
    }
  }

  return found;
}

function scan() {
  const keys = forbiddenKeys();
  const forbidden = identifierPattern(keys);
  const offenses = [];

  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const text = readFileSync(file, 'utf8');

      for (const method of LOG_METHODS) {
        const needle = `.${method}(`;
        let index = text.indexOf(needle);
        while (index !== -1) {
          const call = extractCall(text, index + needle.length - 1);
          if (call !== null) {
            /*
             * 只看 logger 调用。`.info(` 也可能是别的对象的方法，
             * 因此要求接收者名字里含 log —— 本仓库的约定是 `logger` / `log` /
             * `deps.logger` / `request.log` / `this.logger`。
             */
            const before = text.slice(Math.max(0, index - 24), index).toLowerCase();
            if (/\blog(ger)?$|\blog(ger)?\b\s*$/.test(before) || before.endsWith('log')) {
              for (const violation of violationsIn(call, forbidden)) {
                const line = text.slice(0, index).split('\n').length;
                offenses.push({
                  file: relative(ROOT, file).split(sep).join('/'),
                  line,
                  ...violation,
                });
              }
            }
          }
          index = text.indexOf(needle, index + 1);
        }
      }
    }
  }

  return { keys, offenses };
}

/**
 * 护栏自身的反向测试（`--self-test`）。
 *
 * 一个只会被人眼拦住、不会被工具拦住的护栏等于没有护栏 —— 而这个工具最可能
 * 的失效方式是**静默通过一切**：logger.ts 的写法一变，正则匹配不到禁记键；
 * 或者 message 的括号提取出错，`violationsIn` 永远收到空字符串。
 * 两种情况下扫描都会「通过」，而那与「代码干净」在输出上完全一样。
 *
 * 因此这里内置一组必须检出与必须放过的样本，与 CI 的
 * `verify:linux-guardrails` 同一思路。
 */
function selfTest() {
  const forbidden = identifierPattern(forbiddenKeys());

  const mustCatch = [
    'log.info({}, `请求内容：${JSON.stringify(rawRequest)}`)',
    'logger.warn({}, `投影：${projection.destination.name}`)',
    'log.error({}, `原文 ${raw_text}`)',
    'deps.logger.info({}, `计划 ${JSON.stringify(planJson)}`)',
    'log.debug({}, `会话 ${tp_session}`)',
  ];
  const mustPass = [
    // 对象字段形式：redact 会在序列化层剥离，是**推荐**写法
    "log.info({ raw_request: body }, '收到请求')",
    // 错误消息本身不含用户载荷
    'log.error({}, `持久化失败：${String(error)}`)',
    // 只记长度，不记内容
    'log.info({}, `原文 ${rawText.length} 字`)',
    "log.info({ stage: 'SAVING_PLAN' }, '计划已保存')",
  ];

  const failures = [];
  for (const sample of mustCatch) {
    const call = extractCall(sample, sample.indexOf('('));
    if (call === null || violationsIn(call, forbidden).length === 0) {
      failures.push(`应当被检出但放过了：${sample}`);
    }
  }
  for (const sample of mustPass) {
    const call = extractCall(sample, sample.indexOf('('));
    if (call === null) {
      failures.push(`括号提取失败：${sample}`);
      continue;
    }
    const found = violationsIn(call, forbidden);
    if (found.length > 0) {
      failures.push(`误报：${sample} → ${found.map((f) => f.expression).join(', ')}`);
    }
  }

  if (failures.length > 0) {
    console.error('日志载荷扫描器自检失败：\n');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(
    `自检通过：${mustCatch.length} 个违规样本全部检出，${mustPass.length} 个合规样本无误报。`,
  );
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

const { keys, offenses } = scan();

if (offenses.length > 0) {
  console.error('日志 message 里插值了禁记内容（设计稿 21.3、二十章）：\n');
  for (const offense of offenses) {
    console.error(`  ${offense.file}:${offense.line}`);
    console.error(`    插值 ${offense.expression}  ← 命中禁记键 "${offense.key}"`);
    console.error(
      '    redact 只看字段名，进了 message 就是明文落盘。' +
        '把需要的字段作为对象字段传（会被脱敏），或只记它的长度/哈希。\n',
    );
  }
  console.error(`共 ${offenses.length} 处。`);
  process.exit(1);
}

console.log(`日志载荷扫描通过：${keys.length} 个禁记键，未发现 message 内插值。`);
