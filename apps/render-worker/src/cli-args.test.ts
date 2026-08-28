import { TEMPLATE_ID_VALUES } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import { ALL_FORMATS, parseArgs } from './cli-args.js';

const KEY = 'k'.repeat(32);
const env = { RENDER_SIGNING_KEY: KEY };

describe('parseArgs', () => {
  it('默认 7 天、全部格式', () => {
    const options = parseArgs([], env, '/work');
    expect(options.days).toBe(7);
    expect(options.formats).toEqual(ALL_FORMATS);
    expect(options.baseUrl).toBe('http://localhost:3000');
  });

  it('支持 --flag value 与 --flag=value 两种写法', () => {
    expect(parseArgs(['--days', '14'], env).days).toBe(14);
    expect(parseArgs(['--days=14'], env).days).toBe(14);
  });

  it('逗号分隔的格式子集', () => {
    expect(parseArgs(['--format', 'png,pdf'], env).formats).toEqual(['png', 'pdf']);
  });

  it('拒绝未知样式套件', () => {
    /*
     * 拍视觉基线时这条尤其要紧：套件名敲错而不报错的后果是退回默认套件，
     * 于是 A 的图被写成 B 的基线 —— 而那之后会让 B 的每次改动都“通过”。
     */
    expect(() => parseArgs(['--template', 'no_such_v1'], env)).toThrow(/未知样式套件/);
  });

  it('不传 --template 时取第一个已注册套件', () => {
    // 与服务端默认套件同一个来源，因此行为与加这个参数之前一致
    expect(parseArgs([], env).templateId).toBe(TEMPLATE_ID_VALUES[0]);
    expect(parseArgs(['--template', 'blueprint_v1'], env).templateId).toBe('blueprint_v1');
  });

  it('拒绝未知格式', () => {
    expect(() => parseArgs(['--format', 'jpeg'], env)).toThrow(/未知格式/);
  });

  it('拒绝空格式', () => {
    expect(() => parseArgs(['--format', ','], env)).toThrow(/不能为空/);
  });

  it.each([['0'], ['15'], ['abc'], ['1.5'], ['-3']])('拒绝越界天数 %s', (raw) => {
    // 1.1 的支持范围是 1～14 天。超出范围的 fixture 会渲染出不存在的天，
    // 而渲染路由对不存在的天返回 404 —— 表现成「令牌无效」，排查方向完全错
    expect(() => parseArgs(['--days', raw], env)).toThrow(/1～14/);
  });

  it('缺少签名密钥时抛错，不给默认值', () => {
    /*
     * 给默认值的后果：本地忘配也能跑通，部署时 web 用另一个值 ——
     * 中间件对全部请求返回 404（fail closed），而 404 与「路由不存在」
     * 无法区分。宁可在参数解析处直接失败。
     */
    expect(() => parseArgs([], {})).toThrow(/RENDER_SIGNING_KEY/);
  });

  it('拒绝过短的签名密钥', () => {
    expect(() => parseArgs([], { RENDER_SIGNING_KEY: 'short' })).toThrow(/32 字符/);
  });

  it('命令行密钥覆盖环境变量', () => {
    const other = 'x'.repeat(40);
    expect(parseArgs(['--signing-key', other], env).signingKey).toBe(other);
  });

  it('去掉 base-url 末尾斜杠', () => {
    /*
     * 保留斜杠会拼出 //render/…，Next 用 308 重定向到规范路径，
     * 而跳转后自定义请求头会丢失 —— 于是中间件拿不到令牌，返回 404。
     */
    expect(parseArgs(['--base-url', 'http://web:3000///'], env).baseUrl).toBe('http://web:3000');
  });

  it('输出目录默认在 cwd 下', () => {
    expect(parseArgs([], env, '/work').outputDir).toMatch(/out-fixtures$/);
  });
});
