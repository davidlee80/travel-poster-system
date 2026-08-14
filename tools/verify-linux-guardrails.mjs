#!/usr/bin/env node
/**
 * 跨平台护栏的反向测试（TP-0-06，设计稿 22.3.3）。
 *
 * 为什么需要这个脚本：一个只会被工具拦住、不会被人眼拦住的护栏，
 * 如果工具配错了就等于完全没有护栏 —— 而且是**静默失效**，
 * 直到某天 Linux 部署失败才发现。
 *
 * 因此这里主动制造四类违规，逐项确认工具真的会失败：
 *   G-1  文件名大小写不一致的 import  → tsc 必须失败
 *   G-2  硬编码 Windows 路径分隔符    → eslint 必须失败
 *   G-3  CRLF 换行                    → .gitattributes 必须规范化为 LF
 *   G-4  平台可选依赖配置             → supportedArchitectures 必须含 linux/glibc
 *
 * 每项都在临时目录里进行，跑完清理，不污染仓库。
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function pass(id, message) {
  process.stdout.write(`  ✓ ${id}  ${message}\n`);
}

function fail(id, message) {
  failures += 1;
  process.stdout.write(`  ✗ ${id}  ${message}\n`);
}

/**
 * 运行命令，返回 { code, stdout, stderr }，不因非零退出码抛错。
 *
 * 不使用 shell: true —— 参数不转义会引入注入面，Node 24 也会为此发弃用警告。
 */
async function run(cmd, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: repoRoot,
      maxBuffer: 20 * 1024 * 1024,
      ...options,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(err.message ?? err),
    };
  }
}

/**
 * 读取仓库真实的 tsconfig.base.json。
 * 用 TypeScript 自带的解析器而不是手写正则剥注释 —— 该文件里有 `$schema`
 * 这种含 `//` 的字符串值，朴素的注释剥离会把它切坏。
 */
async function readBaseCompilerOptions() {
  const ts = (await import('typescript')).default;
  const file = path.join(repoRoot, 'tsconfig.base.json');
  const parsed = ts.readConfigFile(file, ts.sys.readFile);
  if (parsed.error) {
    throw new Error(`无法解析 tsconfig.base.json: ${String(parsed.error.messageText)}`);
  }
  return parsed.config?.compilerOptions ?? {};
}

// ── G-1：大小写不一致的 import 必须被 tsc 拦住 ──────────────
async function checkCasing() {
  const id = 'G-1';
  const dir = await mkdtemp(path.join(tmpdir(), 'tps-guardrail-casing-'));

  try {
    const base = await readBaseCompilerOptions();

    // 关键：使用仓库**真实配置**里的值，而不是在这里硬编码 true。
    // 硬编码只能证明"tsc 有这个能力"，无法证明"本仓库启用了它" ——
    // 有人把它改成 false 时测试仍会通过，护栏静默失效。
    // TS 5 起该项默认 true，因此 undefined 视为启用。
    const enabled = base.forceConsistentCasingInFileNames !== false;
    if (!enabled) {
      fail(
        id,
        'tsconfig.base.json 显式关闭了 forceConsistentCasingInFileNames —— 大小写护栏已失效',
      );
      return;
    }

    const src = path.join(dir, 'src');
    await mkdir(src, { recursive: true });

    await writeFile(path.join(src, 'travelCard.ts'), 'export const value = 1;\n', 'utf8');
    // 大小写与真实文件名不符：Windows 上能解析，Linux 上不能
    await writeFile(
      path.join(src, 'index.ts'),
      "import { value } from './TravelCard.js';\nexport const doubled = value * 2;\n",
      'utf8',
    );
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: base.target ?? 'ES2023',
            module: base.module ?? 'NodeNext',
            moduleResolution: base.moduleResolution ?? 'NodeNext',
            strict: base.strict ?? true,
            forceConsistentCasingInFileNames: base.forceConsistentCasingInFileNames ?? true,
            noEmit: true,
            skipLibCheck: true,
            // 临时目录里解析不到 @types/node，且本用例不需要
            types: [],
          },
          include: ['src/**/*'],
        },
        null,
        2,
      ),
      'utf8',
    );

    // 不走 node_modules/.bin（Windows 上是需要 shell 的 .cmd 包装），
    // 直接执行 typescript 的 JS 入口 —— 两个平台上行为一致
    const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const result = await run(process.execPath, [tscEntry, '-p', path.join(dir, 'tsconfig.json')], {
      cwd: dir,
    });

    if (result.code === 0) {
      fail(
        id,
        'tsc 接受了大小写不一致的 import —— 该护栏已失效！' +
          '请检查 tsconfig.base.json 的 forceConsistentCasingInFileNames。',
      );
    } else {
      pass(id, '仓库配置启用了大小写检查，且大小写不一致的 import 确实被 tsc 拦住');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── G-2：硬编码 Windows 路径分隔符必须被 eslint 拦住 ─────────
async function checkPathSeparator() {
  const id = 'G-2';

  const { default: rule } = await import('./eslint-rules/no-windows-path-separator.mjs');
  const { Linter } = await import('eslint');
  const linter = new Linter({ configType: 'flat' });

  const RULE_ID = 'local/no-windows-path-separator';
  const config = [
    {
      // flat config 必须有 files 才会匹配被校验的文件名，
      // 否则 verify 只返回一条 "No matching configuration found"
      files: ['**/*.ts'],
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      plugins: { local: { rules: { 'no-windows-path-separator': rule } } },
      rules: { [RULE_ID]: 'error' },
    },
  ];

  /** [代码, 是否应当报错, 说明] */
  const cases = [
    ["const p = 'src\\\\index.ts';", true, '双反斜杠路径'],
    ["const p = '.\\\\dist';", true, '相对路径反斜杠'],
    ['const p = `out\\\\${name}`;', true, '模板字符串中的反斜杠'],
    ["const s = 'line\\nbreak';", false, '换行转义'],
    ["const s = 'tab\\there';", false, '制表符转义'],
    ['const re = /\\d+/;', false, '正则字面量'],
    ["const p = 'src/index.ts';", false, '正斜杠路径'],
    ["const s = '\\u4e2d\\u6587';", false, 'Unicode 转义'],
  ];

  let ok = true;
  for (const [code, shouldReport, label] of cases) {
    const messages = linter.verify(code, config, 'test.ts');

    // 解析错误与配置未匹配都会混进 messages。只有按 ruleId 过滤，
    // 这个断言才是在检验它声称检验的东西。
    const fatal = messages.filter((m) => m.fatal || m.ruleId === null);
    if (fatal.length > 0) {
      ok = false;
      fail(id, `校验「${label}」时出现非规则错误: ${fatal.map((m) => m.message).join('; ')}`);
      continue;
    }

    const reported = messages.some((m) => m.ruleId === RULE_ID);
    if (reported !== shouldReport) {
      ok = false;
      fail(
        id,
        `路径护栏对「${label}」判断错误：期望 ${shouldReport ? '报错' : '不报错'}，实际 ${reported ? '报错' : '不报错'}`,
      );
    }
  }

  if (ok) pass(id, `路径分隔符规则在 ${cases.length} 个正反用例上表现正确`);
}

// ── G-3：CRLF 必须被 .gitattributes 规范化为 LF ─────────────
async function checkLineEndings() {
  const id = 'G-3';

  const attributes = await readFile(path.join(repoRoot, '.gitattributes'), 'utf8');
  if (!/^\*\s+text=auto\s+eol=lf\s*$/m.test(attributes)) {
    fail(id, '.gitattributes 缺少 `* text=auto eol=lf`');
    return;
  }

  // git check-attr 是权威判定：确认 git 真的会对 .ts / .sh 应用 eol=lf
  for (const file of [
    'packages/shared/src/index.ts',
    'infrastructure/migrations/0001_extensions.sql',
  ]) {
    const result = await run('git', ['check-attr', 'text', 'eol', '--', file]);
    if (result.code !== 0 || !result.stdout.includes('eol: lf')) {
      fail(
        id,
        `git 未对 ${file} 应用 eol=lf（输出: ${result.stdout.trim() || result.stderr.trim()}）`,
      );
      return;
    }
  }

  const prettier = await readFile(path.join(repoRoot, '.prettierrc.json'), 'utf8');
  if (!/"endOfLine"\s*:\s*"lf"/.test(prettier)) {
    fail(id, '.prettierrc.json 未设置 endOfLine: "lf"');
    return;
  }

  pass(id, 'git 与 Prettier 均强制 LF');
}

// ── G-4：平台可选依赖必须覆盖 linux/x64/glibc ───────────────
async function checkSupportedArchitectures() {
  const id = 'G-4';

  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const arch = pkg?.pnpm?.supportedArchitectures;

  if (!arch) {
    fail(id, 'package.json 缺少 pnpm.supportedArchitectures');
    return;
  }

  const missing = [];
  if (!arch.os?.includes('linux')) missing.push('os: linux');
  if (!arch.cpu?.includes('x64')) missing.push('cpu: x64');
  if (!arch.libc?.includes('glibc')) missing.push('libc: glibc');

  if (missing.length > 0) {
    fail(
      id,
      `supportedArchitectures 缺少 ${missing.join('、')} —— ` +
        'sharp 等原生依赖的 Linux 二进制不会被下载（设计稿 22.3.2）',
    );
    return;
  }

  const dockerignore = await readFile(path.join(repoRoot, '.dockerignore'), 'utf8');
  if (!/^\*\*\/node_modules$/m.test(dockerignore) || !/^node_modules$/m.test(dockerignore)) {
    fail(id, '.dockerignore 未排除 node_modules —— 宿主的 win32 原生二进制会被拷进 Linux 镜像');
    return;
  }

  pass(id, 'supportedArchitectures 覆盖 linux/x64/glibc，且 .dockerignore 排除 node_modules');
}

// ── 主流程 ─────────────────────────────────────────────────
process.stdout.write('跨平台护栏反向测试（TP-0-06 / 设计稿 22.3.3）\n\n');

await checkCasing();
await checkPathSeparator();
await checkLineEndings();
await checkSupportedArchitectures();

process.stdout.write('\n');
if (failures > 0) {
  process.stdout.write(
    `${failures} 项护栏失效。这些护栏是"静默失效"型的 —— 现在不修，会在 Linux 部署时才暴露。\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write('全部护栏有效。\n');
}
