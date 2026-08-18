import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * 告警的 runbook 链接与政策文案的一致性（TP-5-11、TP-5-14）。
 *
 * ## 拦的是什么
 *
 * 两类都是「文档与代码各自演化」的典型：
 *
 * ```text
 * runbook 锚点失效   告警注解指向 docs/运维手册.md#某个标题，而那个标题被改了。
 *                    半夜被叫起来的人点开链接落在文件顶部，没有起点。
 *                    改标题的人不会想到有六个 YAML 文件在引用它。
 * 保留期数字不一致   界面提示条说 30 天、隐私政策说 90 天。这不是笔误问题 ——
 *                    它是一份对用户的承诺，两个数字里必然有一个是假的。
 * ```
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/**
 * Markdown 标题 → GitHub 风格锚点。
 *
 * 规则：小写、空格转连字符、去掉除连字符与中日韩字符之外的标点。
 * 中文标题保留原字符（GitHub 的实际行为），因此「中文字体故障」的锚点
 * 就是 `中文字体故障`。
 */
function anchorOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function anchorsIn(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    anchors.add(anchorOf(match[1]!));
  }
  return anchors;
}

interface RuleFile {
  readonly groups: readonly {
    readonly rules: readonly {
      readonly alert?: string;
      readonly annotations?: Record<string, string>;
    }[];
  }[];
}

describe('告警的 runbook 链接（TP-5-11）', () => {
  const rules: RuleFile = parse(read('deploy/prometheus/rules/travel-poster.rules.yml'));
  const alerts = rules.groups.flatMap((group) => group.rules).filter((rule) => rule.alert);
  const runbookAnchors = anchorsIn(read('docs/运维手册.md'));

  it('每条告警的 runbook 锚点在运维手册里存在', () => {
    const broken: string[] = [];

    for (const alert of alerts) {
      const runbook = alert.annotations?.['runbook'];
      expect(runbook, `${alert.alert!} 缺 runbook`).toBeTruthy();

      const [file, anchor] = runbook!.split('#');
      expect(file, `${alert.alert!} 的 runbook 应指向运维手册`).toBe('docs/运维手册.md');
      if (anchor === undefined || !runbookAnchors.has(anchor)) {
        broken.push(`${alert.alert!} → #${anchor ?? '(缺锚点)'}`);
      }
    }

    /*
     * 报出全部失效链接而不是第一个：改一个标题通常会同时打断两三条告警的
     * 链接，而逐个修再跑一遍很慢。
     */
    expect(broken, `失效的 runbook 链接（可用锚点：${[...runbookAnchors].join(', ')}）`).toEqual(
      [],
    );
  });

  it('六条告警各有独立的一节（不是都指向同一个锚点）', () => {
    /*
     * 都指向 `#通用起点` 也能让上一条断言通过，而那等于没有 runbook ——
     * 半夜被叫起来的人需要的是「这条告警怎么处置」，不是一份总目录。
     */
    const anchors = alerts.map((alert) => alert.annotations!['runbook']!.split('#')[1]);
    expect(new Set(anchors).size).toBe(alerts.length);
  });
});

describe('TP-5-11 要求的运维主题都在手册里', () => {
  const runbook = read('docs/运维手册.md');

  it.each([
    ['错误码排查', '错误码排查'],
    ['缓存预热', '缓存预热'],
    ['字体故障', '中文字体故障'],
    ['成本超支', '成本超支与熔断'],
    ['匿名清理异常', '匿名清理异常'],
    ['归并失败重放', '归并失败重放'],
  ])('%s', (_topic, heading) => {
    expect(runbook).toContain(heading);
  });
});

describe('隐私政策与界面文案的一致性（TP-5-14）', () => {
  const policy = read('docs/用户协议与隐私政策.md');
  const notice = read('apps/web/src/components/AnonymousNotice.tsx');

  it('匿名保留期在政策与提示条里是同一个数字', () => {
    /*
     * 这不是笔误问题 —— 保留期是一份对用户的承诺。界面说 30 天而政策说
     * 别的，两个数字里必然有一个是假的，而用户看到的是界面那个。
     *
     * 15.1 的实现值也是 30 天（`ANON_RETENTION_DAYS`）。三者一致才算对。
     */
    expect(policy).toContain('30 天');
    expect(notice).toContain('30 天');
  });

  it('政策明确区分「计划 30 天删除」与「脱敏知识长期保留」', () => {
    /*
     * TP-5-14 点名要求这个区分。不写清楚的后果不是合规风险而是**信任问题**：
     * 用户以为「30 天后全删了」，而我们确实保留了一份摘要 ——
     * 即使它不可识别，没说清楚也是失信。
     */
    expect(policy).toContain('长期保留');
    expect(policy).toMatch(/脱敏/);
    // 必须逐条说明摘要里没有什么，而不是笼统一句「已脱敏」
    for (const excluded of ['出行日期', '预算金额', '人员构成', '自由文本']) {
      expect(policy, `政策应说明摘要不含${excluded}`).toContain(excluded);
    }
  });

  it('政策说明了匿名身份的固有限制', () => {
    // 3.6：清掉浏览器数据后那些计划再也无法访问 —— 这一点必须提前告知，
    // 否则用户会在丢失之后才发现
    expect(policy).toMatch(/清掉浏览器数据|清浏览器数据/);
  });

  it('草案的待确认事项还在（正式发布前必须清空）', () => {
    /*
     * 这条断言故意会在正式发布时失败 —— 那时删掉待确认一节，
     * 同时把这条断言改成「不应含待确认事项」。
     * 在此之前它提醒任何读到这份政策的人：它还没定稿。
     */
    expect(policy).toContain('待确认事项');
  });
});
