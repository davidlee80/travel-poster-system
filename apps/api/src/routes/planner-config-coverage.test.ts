import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { migrationsDirectory } from '@tps/db';
import { CONDITION_CODE_COUNT, CONDITION_CODE_VALUES } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

/*
 * 复用**生产代码里那一个**判定函数。
 *
 * 在测试里重写一遍 `endsWith('tags')` 会让这组断言变成一个自说自话的检查：
 * 生产代码改回 `.endsWith('.tags')` 时它照样全绿，而那正是本文件要防的缺陷。
 */
import { isConditionCodeOption } from './travel-plans.js';

/**
 * 陷阱 1 的自动化守卫：**内置条件码集合 ⊆ 迁移注册的码集合。**
 *
 * ## 这条断言防的是什么
 *
 * `travel-plans.ts` 在有已发布 planner config 时这样判定条件码：
 *
 *     const known = context.allowedConditionCodes?.has(code)
 *                     ?? isKnownConditionCode(code);
 *
 * 是 `??` 而不是并集。也就是说**一旦数据库里有 PUBLISHED 版本，
 * `CONDITION_CODE_VALUES` 这份内置字典就完全不参与判断**。
 *
 * 于是「往 conditions.ts 里加一个码」这个看起来自足的改动会有一个隐藏的
 * 第二步：注册进 `planner_config_options` 并发布新版本。漏掉第二步的表现是
 * 装了配置中心的环境里那个标签被 N-08 拒掉整个请求 —— 而界面上它完全正常，
 * 用户点它、勾它、提交，然后收到一句「存在暂不支持的偏好条件」。
 *
 * 本地开发与单测环境通常**没有**配置中心（`deps.plannerConfig` 为
 * undefined），因此这类缺失在开发期完全看不见。这条断言是唯一能提前发现它的
 * 地方。
 *
 * ## 为什么读 SQL 文本而不是连数据库
 *
 * 要断言的是「仓库里的迁移」与「仓库里的字典」一致，而不是「某个数据库实例
 * 的当前状态」。连库的集成测试测的是后者 —— 它在一个还没跑迁移的库上会失败，
 * 而那不是本条要防的问题。读文本也让这条断言进普通 `pnpm test`
 * 而不是需要 Postgres 的 `test:integration`。
 *
 * ## 为什么在 apps/api 而不是 packages/db
 *
 * 被保护的不变量在 `travel-plans.ts` 那一行 `??` 上。放在这里，下一个改那行
 * 代码的人会先看到这个文件。`@tps/db` 也不依赖 `@tps/schemas`，
 * 而这条断言两边都要用。
 */

/**
 * 从全部迁移文件里抽出注册过的 (field_key, option_key, value_kind)。
 *
 * 用正则扫 `('field_key', 'option_key', ...)` 形态的元组而不是解析 SQL：
 * 这里只需要「哪些选项被插入过、各自算不算条件码」，而一个 SQL 解析器
 * 会引入一个依赖去解决一个正则几行就能解决的问题。
 *
 * `value_kind` 按**语句块**取：0012 起每条 INSERT 在 SELECT 子句里写一个
 * 字面 metadata（`'{"value_kind":"ENUM"}'::jsonb`），一条语句里的元组同属一类。
 * 因此先按 `INSERT INTO planner_config_options` 切块，再在块内扫元组 ——
 * 0010 / 0011 的块里没有 `value_kind`，于是走 `isConditionCodeOption` 的
 * 后缀回退分支，与生产代码在同一个中间态下的行为一致。
 *
 * 代价是「注册方式变了」（比如改成从 CSV 导入）时这组断言会静默失效 ——
 * 因此下面有一条断言盯着「至少扫到了预期数量的码」，
 * 让「什么都没扫到」表现为红而不是绿。
 */
interface RegisteredOption {
  readonly fieldKey: string;
  readonly optionKey: string;
  readonly isCode: boolean;
}

function registeredOptions(): readonly RegisteredOption[] {
  const dir = migrationsDirectory();
  const out: RegisteredOption[] = [];

  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    /* 第 0 块是第一条 INSERT 之前的内容（建表、函数），里面没有选项元组 */
    for (const block of sql.split('INSERT INTO planner_config_options').slice(1)) {
      const kind = /"value_kind"\s*:\s*"([A-Z_]+)"/.exec(block)?.[1];
      const metadata: Record<string, unknown> = kind === undefined ? {} : { value_kind: kind };

      /*
       * 匹配 `('field_key', 'option_key'` —— 每个 VALUES 元组的前两列。
       * `[^']*` 而不是 `.*`：跨列贪婪匹配会把一整行吞掉。
       */
      for (const match of block.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
        const fieldKey = match[1];
        const optionKey = match[2];
        if (fieldKey === undefined || optionKey === undefined) continue;
        out.push({ fieldKey, optionKey, isCode: isConditionCodeOption(fieldKey, metadata) });
      }
    }
  }

  return out;
}

function registeredConditionCodes(): ReadonlySet<string> {
  return new Set(
    registeredOptions()
      .filter((o) => o.isCode)
      .map((o) => o.optionKey),
  );
}

describe('配置中心注册的条件码覆盖内置字典（陷阱 1）', () => {
  const registered = registeredConditionCodes();

  it('扫描确实抓到了码 —— 防止正则失效后反向那条断言空转', () => {
    /*
     * 「注册方式变了」（改成从 CSV 导入之类）会让 `registered` 变成空集。
     * 那时下面第一条（内置 ⊆ 注册）会正常报红，但第二条（注册 ⊆ 内置）
     * 会**通过** —— 空集是任何集合的子集。这一条盯住集合非空，
     * 让扫描失效表现为红而不是「一半绿一半红」那种更难判断的状态。
     */
    expect(registered.size).toBeGreaterThanOrEqual(CONDITION_CODE_COUNT);
  });

  it('每个内置条件码都注册进了 planner_config_options', () => {
    const missing = CONDITION_CODE_VALUES.filter((code) => !registered.has(code));
    /*
     * 报出缺失清单而不只是数量：这条红的时候，读者需要的正是
     * 「哪几个码忘了注册」，而那份清单直接就是要补进迁移的内容。
     */
    expect(missing).toEqual([]);
  });

  it('注册的码都在内置字典里 —— 反向漏洞同样致命', () => {
    /*
     * 配置中心里有一个内置字典没有的码，意味着它能通过 N-08，
     * 却在 `CONDITION_LABEL`（`Record<ConditionCode, string>`）里查不到标签，
     * 也不在 `CONDITION_CODES_BY_DOMAIN` 的任何一组里 ——
     * 于是它通过了校验但**不会进 Prompt**，条件静默失效。
     */
    const known = new Set<string>(CONDITION_CODE_VALUES);
    expect([...registered].filter((code) => !known.has(code)).sort()).toEqual([]);
  });

  it('每条注册链都发布了配置版本', () => {
    /*
     * 注册了码但不发布，等于没注册：`planner_config_current` 视图只看
     * `status = 'PUBLISHED'` 的版本。
     */
    const sql = (name: string): string =>
      readFileSync(path.join(migrationsDirectory(), name), 'utf8');

    const v2 = sql('0011_planner_v2_config.sql');
    expect(v2).toContain('clone_planner_config(1, 2');
    expect(v2).toContain('publish_planner_config(2)');

    const v3 = sql('0012_planner_config_all_options.sql');
    expect(v3).toContain('clone_planner_config(2, 3');
    expect(v3).toContain('publish_planner_config(3)');
  });

  it('0012 之后每一条 INSERT 都显式标注了 value_kind', () => {
    /*
     * 这一条盯的是「新增一条 INSERT 但忘了写 metadata」。
     *
     * 忘了写的后果不是报错而是**静默走后缀回退** —— 一批新条件码落在
     * `lodging.amenities` 这种不以 tags 结尾的路径下，于是它们不进白名单，
     * 提交时被 N-08 拒，而界面上那些标签完全正常。
     *
     * **这条原先只读 `0012` 那一个文件**，而标题写的是「0012 之后」——
     * 于是 0013 以后任何新增的 INSERT 都从缝里漏过去。R-85 P3 加
     * `0017_template_catalog.sql` 时正好撞上：那条迁移若忘了 value_kind，
     * 两个模板 ID 会因后缀回退而混进条件码白名单，而这条仍然是绿的。
     * 现在改成扫全部 >= 0012 的迁移。
     */
    const dir = migrationsDirectory();
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      /* 字典序对零填充的编号成立：'0012' <= '0017' */
      .filter((name) => name >= '0012')
      .sort();

    let checked = 0;
    for (const file of files) {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      for (const block of sql.split('INSERT INTO planner_config_options').slice(1)) {
        expect(block, `${file} 里有一条 INSERT 没标 value_kind`).toMatch(
          /"value_kind"\s*:\s*"(ENUM|CONDITION_CODE)"/,
        );
        checked += 1;
      }
    }

    /* 文件名筛选写错时 checked 会是 0，而上面的循环一次也不跑 —— 那同样是绿的 */
    expect(checked, '一条 INSERT 也没扫到，筛选条件可能已失效').toBeGreaterThan(0);
  });
});
