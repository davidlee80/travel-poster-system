import path from 'node:path';

import { TEMPLATE_ID_VALUES, type TemplateId } from '@tps/schemas';

import type { ExportFormat } from './export-plan.js';

/**
 * `render:fixture` 的参数解析（TP-1-13/14/15 的 CLI 入口）。
 *
 * 单独成文件是为了可测：参数校验是这条命令唯一有分支的逻辑，而它出错的
 * 后果很不直观 —— 例如签名密钥不一致时渲染路由返回 404，看起来像
 * 「路由不存在」，能让人查很久。
 */

export interface CliOptions {
  readonly days: number;
  readonly formats: readonly ExportFormat[];
  readonly baseUrl: string;
  readonly outputDir: string;
  readonly signingKey: string;
  readonly templateId: TemplateId;
}

export const ALL_FORMATS: readonly ExportFormat[] = ['html', 'png', 'pdf'];

/** 与 17.1 的 fail-closed 一致：密钥太短等于没有保护 */
const MIN_SIGNING_KEY_LENGTH = 32;

export interface ParseArgsEnv {
  readonly RENDER_SIGNING_KEY?: string | undefined;
  readonly RENDER_BASE_URL?: string | undefined;
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;

    // 支持 --flag=value 与 --flag value 两种写法
    const equals = arg.indexOf('=');
    if (equals !== -1) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }

    const next = argv[i + 1];
    flags.set(arg.slice(2), next !== undefined && !next.startsWith('--') ? next : 'true');
  }

  return flags;
}

function parseFormats(raw: string): readonly ExportFormat[] {
  if (raw === 'all') return ALL_FORMATS;

  const requested = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (requested.length === 0) {
    throw new Error('--format 不能为空；可选 html / png / pdf（逗号分隔）或 all');
  }

  const invalid = requested.filter((part) => !ALL_FORMATS.includes(part as ExportFormat));
  if (invalid.length > 0) {
    throw new Error(`未知格式 ${invalid.join(', ')}；可选 ${ALL_FORMATS.join(' / ')} 或 all`);
  }

  return requested as readonly ExportFormat[];
}

export function parseArgs(
  argv: readonly string[],
  env: ParseArgsEnv = {},
  cwd = process.cwd(),
): CliOptions {
  const flags = parseFlags(argv);

  const daysRaw = flags.get('days') ?? '7';
  const days = Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > 14) {
    throw new Error(`--days 必须是 1～14 的整数（1.1 支持范围），收到 ${JSON.stringify(daysRaw)}`);
  }

  /*
   * 签名密钥不给默认值。
   *
   * 给一个默认值的后果：本地忘了配就用默认值跑通了，部署时 web 用的是
   * 另一个值 —— 中间件对全部请求返回 404（fail closed，17.1），
   * 而 404 与「路由不存在」无法区分。宁可在这里直接报错。
   */
  const signingKey = flags.get('signing-key') ?? env.RENDER_SIGNING_KEY;
  if (signingKey === undefined || signingKey.length < MIN_SIGNING_KEY_LENGTH) {
    throw new Error(
      `RENDER_SIGNING_KEY 未设置或短于 ${MIN_SIGNING_KEY_LENGTH} 字符。` +
        '它必须与 web 服务使用的值完全一致，否则渲染路由会对全部请求返回 404（17.1）。',
    );
  }

  const baseUrl = (flags.get('base-url') ?? env.RENDER_BASE_URL ?? 'http://localhost:3000').replace(
    // 末尾斜杠会拼出 //render/…，Next 会 308 重定向，而跳转后自定义请求头会丢失
    /\/+$/,
    '',
  );

  /*
   * 样式套件（R-85 P2）。默认取第一个 —— 与服务端的默认套件同一个来源，
   * 因此不传 `--template` 时行为与加这个参数之前完全一致。
   *
   * 不接受未注册的值：套件写错时渲染路由会回退到默认套件或直接 404，
   * 两种都让人以为是渲染出了问题 —— 而真因只是多敲了一个字母。
   * 拍基线时这一点尤其要紧：退回默认套件会把 A 的图写成 B 的基线。
   */
  const templateRaw = flags.get('template') ?? TEMPLATE_ID_VALUES[0];
  if (!TEMPLATE_ID_VALUES.includes(templateRaw as TemplateId)) {
    throw new Error(
      `未知样式套件 ${JSON.stringify(templateRaw)}；可选 ${TEMPLATE_ID_VALUES.join(' / ')}`,
    );
  }

  return {
    days,
    formats: parseFormats(flags.get('format') ?? 'all'),
    baseUrl,
    outputDir: flags.get('out') ?? path.join(cwd, 'out-fixtures'),
    signingKey,
    templateId: templateRaw as TemplateId,
  };
}
