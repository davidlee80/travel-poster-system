import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSilentLogger } from '@tps/shared';
import { InMemoryExportStorage } from '@tps/storage';
import { describe, expect, it } from 'vitest';

import { deleteExportObjects } from './objects.js';

/**
 * 对象清理与生命周期规则（TP-6-14/15，设计稿 15.1、19.3、R-50/R-51）。
 *
 * 后半段是**文本层断言**，与 P5 对 Helm 模板的处理同一形态：本机没有
 * `mc`，也拉不下 MinIO 镜像，因此断言的是「声明里写了什么」而不是
 * 「桶上生效了什么」。语法与实际生效由 CI 校验。
 *
 * 这种断言仍然有价值：R-50 的硬约束（`anon/` 前缀**不挂**规则）一旦被
 * 违反，表现是「已归并用户三年前的产物在某天静默消失」—— 那是不可恢复的，
 * 而且没有任何测试会因此变红，除了这一条。
 */

describe('deleteExportObjects', () => {
  it('逐键删除', async () => {
    const storage = new InMemoryExportStorage();
    storage.objects.set('a', { body: new Uint8Array(), contentType: 'image/png' });
    storage.objects.set('b', { body: new Uint8Array(), contentType: 'image/png' });

    await deleteExportObjects({ storage, logger: createSilentLogger() }, ['a']);

    expect([...storage.objects.keys()]).toEqual(['b']);
  });

  it('空列表不调用存储（多数匿名用户只生成计划、不导出）', async () => {
    const storage = new InMemoryExportStorage();
    await deleteExportObjects({ storage, logger: createSilentLogger() }, []);
    expect(storage.counts.delete).toBe(0);
  });

  it('存储失败原样抛出，**不吞异常**', async () => {
    /*
     * 吞掉的表现是「行删了、对象留着」，而那些对象再也推不出键
     * —— 调用方（purge.ts）依赖这个异常让事务回滚。
     */
    const failing = { delete: () => Promise.reject(new Error('S3 5xx')) };
    await expect(
      deleteExportObjects({ storage: failing, logger: createSilentLogger() }, ['a']),
    ).rejects.toThrow('S3 5xx');
  });
});

// ── TP-6-15：生命周期规则的声明 ─────────────────────────────

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface LifecycleRule {
  readonly ID?: string;
  readonly Status?: string;
  readonly Filter?: { readonly Prefix?: string };
  readonly Expiration?: { readonly Days?: number };
}

function lifecycle(): { readonly Rules: readonly LifecycleRule[] } {
  const path = join(repoRoot, 'deploy', 'storage', 'exports-lifecycle.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { Rules: LifecycleRule[] };
}

describe('导出桶生命周期规则（TP-6-15，门禁 #38 后半）', () => {
  it('users/ 前缀挂 90 天规则（19.3）', () => {
    const rule = lifecycle().Rules.find((entry) => entry.Filter?.Prefix === 'users/');

    expect(rule).toBeDefined();
    expect(rule?.Status).toBe('Enabled');
    expect(rule?.Expiration?.Days).toBe(90);
  });

  it('**不存在**任何 anon/ 前缀的规则（R-50 的硬约束）', () => {
    /*
     * anon/ 下混有已升级 / 已归并用户的长期数据 —— 归并只改数据库归属、
     * 对象零搬运。挂规则会把它们静默删掉，而生命周期规则没有「例外名单」，
     * 它只认前缀。这些对象的到期由 retention-worker 按数据库归属处理。
     */
    const anonRules = lifecycle().Rules.filter((entry) =>
      (entry.Filter?.Prefix ?? '').startsWith('anon'),
    );
    expect(anonRules).toEqual([]);
  });

  it('也不存在覆盖全桶的无前缀规则（那等于给 anon/ 挂上了）', () => {
    /*
     * 这一条拦的是另一种写法：`Filter: {}` 或省略 Filter 会作用于整个桶，
     * 于是 anon/ 也被覆盖 —— 而它读起来完全不像「给 anon 挂了规则」。
     */
    const global = lifecycle().Rules.filter((entry) => (entry.Filter?.Prefix ?? '') === '');
    expect(global).toEqual([]);
  });

  it('每条规则都有 ID 与 Status（缺 ID 时 mc ilm 无法按名管理）', () => {
    for (const rule of lifecycle().Rules) {
      expect(rule.ID).toBeTruthy();
      expect(rule.Status).toBe('Enabled');
    }
  });

  it('本地 compose 的 minio-init 应用了这份声明', () => {
    /*
     * 本地与生产用同一份 JSON。两处各写一份的表现是「本地测出来的规则
     * 与生产不一样」，而那种分歧只有在生产删错东西时才会被发现。
     */
    const compose = readFileSync(join(repoRoot, 'infrastructure', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('mc ilm import local/tps-exports');
    expect(compose).toContain('/config/exports-lifecycle.json');
  });
});
