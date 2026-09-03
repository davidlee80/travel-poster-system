import { describe, expect, it } from 'vitest';

import { ROLE_INGEST_DEFAULTS, parseSeedManifest } from './seed-manifest.js';

/**
 * 轨道 B（种子素材灌库）的清单层（TP-3-06）。
 *
 * ## 为什么这一层必须有测试
 *
 * 清单是**人工维护**的 JSONL，而它承载两条**合规**校验：
 *
 *   1. 需要署名的授权必须带 `attribution_text`（二十章：图片来源必须记录）；
 *   2. AI 生成物必须标 `ILLUSTRATIVE`（9.4）。
 *
 * 这两条在清单层拦而不是入库后拦，理由写在 `seed-manifest.ts` 的文件头：
 * 入库后的修正要回填几千行。也就是说这一层是合规的**唯一**前置关口，
 * 而它此前零测试覆盖。
 *
 * ## 错行不跳过
 *
 * 收集全部错行后由调用方整体拒绝。跳过意味着「灌了 1998 条，两条静默丢失」，
 * 而清单的错行通常是同一类错误（比如整批漏填授权），一次报全比修一条跑一次快。
 */

/** 一条最小合法条目：只填必填项，其余走默认值 */
const MINIMAL = {
  file: 'gongchen-01.jpg',
  role: 'DESTINATION_PHOTO',
  license_type: 'CC0',
};

function line(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...MINIMAL, ...overrides });
}

describe('parseSeedManifest', () => {
  it('最小合法条目解析成功，可选项落到默认值', () => {
    const { entries, errors } = parseSeedManifest(line());

    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      file: 'gongchen-01.jpg',
      role: 'DESTINATION_PHOTO',
      license_type: 'CC0',
      // 以下四项的默认值决定了「没填会怎样」，改动它们会影响存量清单的语义
      entity_name: null,
      style_tags: [],
      source_type: 'PLATFORM_LIBRARY',
      representation_type: 'PHOTOGRAPHIC',
    });
  });

  it('空行与 // 注释跳过', () => {
    const text = ['// 杭州一批', '', line(), '   ', line({ file: 'b.jpg' })].join('\n');
    const { entries, errors } = parseSeedManifest(text);

    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);
  });

  it('错行收集而不是在第一行停下，且行号是原文行号', () => {
    /*
     * 行号必须算上被跳过的注释与空行 —— 报「第 2 行」而实际是第 4 行，
     * 人工对着几千行的清单找错会非常痛苦。
     */
    const text = ['// 注释', line(), '{ 不是 JSON', line({ role: 'ROUTE_MAP' })].join('\n');
    const { entries, errors } = parseSeedManifest(text);

    expect(entries).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.line).toBe(3);
    expect(errors[1]?.line).toBe(4);
  });

  describe('合规校验', () => {
    it('LICENSED 且非平台库时缺 attribution_text 被拒', () => {
      const { entries, errors } = parseSeedManifest(
        line({ license_type: 'LICENSED', source_type: 'LICENSED_SOURCE' }),
      );

      expect(entries).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('attribution_text');
    });

    it('LICENSED 带了 attribution_text 就通过', () => {
      const { entries, errors } = parseSeedManifest(
        line({
          license_type: 'LICENSED',
          source_type: 'LICENSED_SOURCE',
          attribution_text: 'Photo by X on Y',
        }),
      );

      expect(errors).toEqual([]);
      expect(entries[0]?.attribution_text).toBe('Photo by X on Y');
    });

    it('PLATFORM_LIBRARY 的 LICENSED 素材免署名（refine 的第三个分支）', () => {
      /*
       * 平台自有库里的授权素材，授权信息在采购合同里而不在图片旁边。
       * 这个分支存在，因此必须有用例 —— 否则下一个人会以为那条 refine
       * 只有两个分支，把它简化掉。
       */
      const { entries, errors } = parseSeedManifest(
        line({ license_type: 'LICENSED', source_type: 'PLATFORM_LIBRARY' }),
      );

      expect(errors).toEqual([]);
      expect(entries).toHaveLength(1);
    });

    it('AI_GENERATED 标成 PHOTOGRAPHIC 被拒（9.4）', () => {
      /*
       * AI 生成的「景点照片」不能被当成实拍展示给用户。数据库另有
       * `assets_ai_must_be_illustrative` 兜底，但那是最后一道 ——
       * 清单层拦住才能在灌库之前发现整批标错。
       */
      const { entries, errors } = parseSeedManifest(
        line({ source_type: 'AI_GENERATED', representation_type: 'PHOTOGRAPHIC' }),
      );

      expect(entries).toHaveLength(0);
      expect(errors[0]?.message).toContain('ILLUSTRATIVE');
    });

    it('AI_GENERATED + ILLUSTRATIVE 通过', () => {
      const { errors } = parseSeedManifest(
        line({ source_type: 'AI_GENERATED', representation_type: 'ILLUSTRATIVE' }),
      );

      expect(errors).toEqual([]);
    });
  });

  describe('角色白名单', () => {
    it('ROUTE_MAP 不能灌库（9.2：它是程序生成的 SVG）', () => {
      const { entries, errors } = parseSeedManifest(line({ role: 'ROUTE_MAP' }));

      expect(entries).toHaveLength(0);
      expect(errors).toHaveLength(1);
    });

    it('三个可灌库角色都接受', () => {
      const text = ['HERO_BACKGROUND', 'FOOD_IMAGE', 'DESTINATION_PHOTO']
        .map((role, i) => line({ role, file: `${i}.jpg` }))
        .join('\n');

      const { entries, errors } = parseSeedManifest(text);
      expect(errors).toEqual([]);
      expect(entries).toHaveLength(3);
    });
  });

  describe('必填项', () => {
    it('缺 file 被拒', () => {
      const { errors } = parseSeedManifest(
        JSON.stringify({ role: 'FOOD_IMAGE', license_type: 'CC0' }),
      );
      expect(errors).toHaveLength(1);
    });

    it('缺 license_type 被拒（授权是合规前提，不能有默认值）', () => {
      const { errors } = parseSeedManifest(JSON.stringify({ file: 'a.jpg', role: 'FOOD_IMAGE' }));
      expect(errors).toHaveLength(1);
    });

    it('空字符串的 entity_name 被拒而不是当成 null', () => {
      /*
       * `.min(1).nullable()` 的意思是「要么不填，要么填有内容的」。
       * 空串通过会让 `entity_match`（权重 0.35）拿一个空值去比，
       * 那是「填了但没用」——比不填更难发现。
       */
      const { errors } = parseSeedManifest(line({ entity_name: '' }));
      expect(errors).toHaveLength(1);
    });
  });
});

describe('ROLE_INGEST_DEFAULTS', () => {
  it('与 packages/presentation 的槽位约束同一口径', () => {
    /*
     * 两处不一致的表现是「灌进来的素材在解析时被 aspect_ratio_score 判低分，
     * 命中率莫名偏低，而两边单独看都是按规格做的」（seed-manifest.ts 的注释）。
     *
     * 这里把数字写死是有意的：它们本该由 presentation 导出，但那会让
     * generation-worker 的清单层依赖展示层。写死 + 这条断言是折中 ——
     * 改了一侧另一侧会红。
     */
    expect(ROLE_INGEST_DEFAULTS).toEqual({
      HERO_BACKGROUND: { aspectRatio: '16:6', minWidth: 1600 },
      FOOD_IMAGE: { aspectRatio: '4:3', minWidth: 600 },
      DESTINATION_PHOTO: { aspectRatio: '16:9', minWidth: 800 },
    });
  });

  it('三个可灌库角色都有默认值', () => {
    for (const role of ['HERO_BACKGROUND', 'FOOD_IMAGE', 'DESTINATION_PHOTO'] as const) {
      expect(ROLE_INGEST_DEFAULTS[role]).toBeDefined();
    }
  });
});
