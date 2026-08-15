#!/usr/bin/env node
/**
 * 扫描源码中**会进入渲染结果的文案**，报出不在字体子集内的字符（TP-1-04）。
 *
 * ## 为什么必须解析 AST，不能扫原始文本
 *
 * 注释里出现「⊃」「❌」这类字符是完全正常的 —— 它们不进入页面。
 * 扫原始文本会把注释算进去，于是门禁天天报假失败，最后被加上
 * 「先跳过这一步」的注释，等于没有门禁。
 *
 * 因此只取三类节点：字符串字面量、模板字面量的静态片段、JSX 文本。
 * 这三类是文案唯一的来源；变量拼接出的用户内容不在源码里，
 * 由系统级完整 Noto CJK 兜底（见 README）。
 *
 * ## 为什么这是门禁而不只是测试
 *
 * 缺字形的表现是豆腐块，而豆腐块**不会让任何测试或构建失败** ——
 * 它只在最终 PNG 上可见。17.5 明确点出「故障会静默通过」是这一环的
 * 核心风险。把它变成一条 `--strict` 的构建期检查，是唯一能在
 * 用户看到之前拦住它的手段。
 *
 * 用法：
 *   pnpm --filter @tps/fonts fonts:scan            列出未覆盖字符
 *   pnpm --filter @tps/fonts fonts:scan -- --strict 有未覆盖字符则退出码 1
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { findUncoveredCharacters } from '../dist/charset.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const strict = process.argv.includes('--strict');

/**
 * 只扫会产出用户可见文案的源目录。
 *
 * `packages/fonts` 自身排除在外 —— 它的 charset 注释里必然出现各种示例字符，
 * 那是定义处，不是使用处。
 */
const ROOTS = [
  'apps/web/src',
  'apps/api/src',
  'apps/render-worker/src',
  'apps/generation-worker/src',
  'apps/retention-worker/src',
  'packages/presentation/src',
  'packages/schemas/src',
  'packages/shared/src',
  'packages/db/src',
  /*
   * packages/observability 不扫：它的字符串只有指标名与**编译期**诊断文案
   * （ValidLabel 的错误消息里用了 ❌），永远不会进入渲染结果。
   * 把它纳入扫描会让门禁常态失败，而常态失败的门禁最终会被跳过。
   */
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.turbo', '__visual__']);

/**
 * 测试文件不扫。
 *
 * 测试会故意构造病态输入（超长文案、生僻字、边界字符）来验证降级路径，
 * 那些字符不应该被要求有字形 —— 否则「测试生僻字回退」这件事本身
 * 就会把生僻字拖进子集，测试也就不再测原本要测的东西。
 */
function isScannable(fileName) {
  if (/\.(test|spec)\.(ts|tsx)$/.test(fileName)) return false;
  return /\.(ts|tsx)$/.test(fileName);
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, out);
    } else if (isScannable(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 收集单个文件里所有会进入渲染结果的文本片段 */
function collectLiterals(fileName, source) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const chunks = [];

  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      chunks.push(node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return chunks;
}

const files = (await Promise.all(ROOTS.map((r) => walk(path.join(repoRoot, r))))).flat();

/** 字符 → { 文件, 上下文片段 } */
const found = new Map();

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');

  for (const chunk of collectLiterals(file, source)) {
    for (const ch of findUncoveredCharacters(chunk)) {
      if (found.has(ch)) continue;
      found.set(ch, { file: relative, context: chunk.trim().slice(0, 40) });
    }
  }
}

process.stdout.write(
  `扫描 ${files.length} 个文件的字符串与 JSX 文本，未覆盖字符 ${found.size} 个\n`,
);

for (const [ch, { file, context }] of found) {
  const code = ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  process.stdout.write(`  U+${code} ${JSON.stringify(ch)}  ${file}  ${JSON.stringify(context)}\n`);
}

if (found.size > 0) {
  process.stdout.write(
    '\n把这些字符加入 src/charset.ts 的 EXTRA_CHARACTERS，再运行 fonts:build 重新生成子集。\n',
  );
  if (strict) process.exitCode = 1;
}
