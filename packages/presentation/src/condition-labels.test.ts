import {
  CONDITION_CODES_BY_DOMAIN,
  CONDITION_CODE_VALUES,
  CONDITION_DOMAIN_VALUES,
} from '@tps/schemas';
import { describe, expect, it } from 'vitest';

import {
  CONDITION_DOMAIN_LABEL,
  CONDITION_LABEL,
  MUST_BY_DEFAULT_DOMAINS,
} from './condition-labels.js';

describe('条件字典标签（5.1）', () => {
  it('24 个 code 全部有标签', () => {
    // 漏一个的表现是表单里出现一个没有文字的复选框
    for (const code of CONDITION_CODE_VALUES) {
      expect(CONDITION_LABEL[code], `${code} 缺标签`).toMatch(/[一-龥]/);
    }
    expect(Object.keys(CONDITION_LABEL)).toHaveLength(CONDITION_CODE_VALUES.length);
  });

  it('标签互不重复', () => {
    /*
     * 两个 code 用同一个标签时，用户在表单里看到两个一样的选项，
     * 而勾中哪一个会导致不同的约束进入 Prompt。
     */
    const labels = Object.values(CONDITION_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('六个域全部有标题', () => {
    for (const domain of CONDITION_DOMAIN_VALUES) {
      expect(CONDITION_DOMAIN_LABEL[domain], `${domain} 缺标题`).toMatch(/[一-龥]/);
    }
  });

  it('无障碍与饮食默认为硬约束', () => {
    /*
     * 轮椅通行与食物过敏不是偏好。默认成「尽量满足」的话，
     * 生成出的计划可能根本无法使用，而用户看不出这个区别 ——
     * 界面上两者都只是一个勾。
     */
    expect([...MUST_BY_DEFAULT_DOMAINS].sort()).toEqual(['accessibility', 'diet']);
    for (const domain of MUST_BY_DEFAULT_DOMAINS) {
      expect(CONDITION_CODES_BY_DOMAIN[domain].length).toBeGreaterThan(0);
    }
  });

  it('标签不含 code 本身（避免直接把英文标识符展示给用户）', () => {
    for (const [code, label] of Object.entries(CONDITION_LABEL)) {
      expect(label).not.toContain(code);
      expect(label).not.toMatch(/[a-z_]{4,}/);
    }
  });
});
