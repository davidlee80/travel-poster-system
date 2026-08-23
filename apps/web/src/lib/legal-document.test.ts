import { describe, expect, it } from 'vitest';

import { extractTitle, loadLegalDocument, stripInternalPreamble } from './legal-document.js';

/**
 * `/legal` 页面的数据源。
 *
 * 这些断言看起来琐碎，但它们守的是两件会安静出错的事：
 *   1. 内部说明（「本文件是草案」「由某个测试校验」）渲染给了用户；
 *   2. 政策文档被改名或移动，而页面渲染出空白 —— 一个空白的隐私政策页
 *      比没有政策页更糟，且不会有任何报错。
 */

describe('stripInternalPreamble', () => {
  it('切掉第一条 --- 之前的全部内容', () => {
    const input = ['# 标题', '', '> 内部说明', '', '---', '', '## 一、正文'].join('\n');

    const result = stripInternalPreamble(input);

    expect(result).not.toContain('内部说明');
    expect(result).toContain('## 一、正文');
  });

  it('只切第一条 ---（正文里的分隔线要留着）', () => {
    const input = ['> 内部', '---', '## 一', '---', '## 二'].join('\n');

    expect(stripInternalPreamble(input).match(/^---$/gm)).toHaveLength(1);
  });

  it('没有 --- 时原样返回', () => {
    expect(stripInternalPreamble('## 只有正文')).toBe('## 只有正文');
  });
});

describe('extractTitle', () => {
  it('取出一级标题并从正文里去掉（页面自己渲染标题）', () => {
    const { title, body } = extractTitle('# 用户协议与隐私政策（草案）\n\n正文');

    expect(title).toBe('用户协议与隐私政策（草案）');
    expect(body).not.toContain('# 用户协议');
    expect(body).toContain('正文');
  });

  it('没有一级标题时给一个兜底标题', () => {
    expect(extractTitle('## 二级').title).toBe('用户协议与隐私政策');
  });
});

describe('loadLegalDocument（读真实的 docs 文件）', () => {
  const document = loadLegalDocument();

  it('找得到政策文档并渲染出内容', () => {
    // 文档被改名或移动时这里直接抛错 —— 与构建期的失败方式一致
    expect(document.title).toContain('用户协议与隐私政策');
    expect(document.html.length).toBeGreaterThan(2_000);
  });

  it('渲染出结构化 HTML 而不是原样 markdown', () => {
    expect(document.html).toContain('<h2');
    // 政策里有三张表格，GFM 表格必须真的被解析
    expect(document.html).toContain('<table>');
  });

  it('不含给维护者看的内部说明', () => {
    /*
     * 一份自称草案、还提到测试文件路径与源码路径的隐私政策，
     * 对用户既无意义也不专业。
     */
    expect(document.html).not.toContain('runbook.test.ts');
    expect(document.html).not.toContain('AnonymousNotice');
    expect(document.html).not.toContain('实施计划 TP-5-14');
  });

  it('含 P7 之后的关键承诺', () => {
    // 政策正文与实现一致：必须注册才能生成，忘记口令可用手机号验证码登录
    expect(document.html).toContain('需要注册才能使用');
    expect(document.html).toContain('忘记口令时仍可使用手机号验证码登录');
  });
});
