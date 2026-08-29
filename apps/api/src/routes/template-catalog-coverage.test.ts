import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { TEMPLATE_ID_VALUES } from '@tps/schemas';
import { describe, expect, it } from 'vitest';

/**
 * 模板样式目录与代码枚举的双向一致性（R-85 P3）。
 *
 * ## 为什么必须双向
 *
 * `TEMPLATE_ID_VALUES` 是代码里的枚举，模板目录是数据库里的配置行 ——
 * 两者会漂移，而两个方向的症状都不指向真因：
 *
 * - **配置有、代码没有** → 用户在界面上选得到，但 `TemplateIdSchema` 拒，
 *   于是「界面完全正常却提交被拒」。
 * - **代码有、配置没有** → 用户选不到，那套套件白做。没有任何报错，
 *   因为后端的默认值会兜住，产物照样生成 —— 只是永远是默认样式。
 *
 * 这与条件码那组（`planner-config-coverage.test.ts`）是同一个失败模式，
 * 因此照它的形状做，包括那条「扫描确实抓到了行」的非空守卫。
 *
 * ## 扫 SQL 而不连库
 *
 * 与条件码那组同一个理由：这组要能在没有数据库的环境里跑（PR 门禁）。
 * 代价是「注册方式变了」时断言会静默失效，因此有非空守卫盯着。
 */

const TEMPLATE_FIELD_KEY = 'output.template_id';

/**
 * R-85 P1 重命名前的旧枚举值。它们已不在 `TEMPLATE_ID_VALUES` 里，
 * 任何测试再引用它们都会在**运行时**被 `TemplateIdSchema` 拒成 400。
 *
 * 有一条断言扫全部测试文件禁它们再入 —— 见文件末尾。
 * 那是 2026-08-29 实际撞出来的：三个集成测试带着旧值，`pnpm test`
 * 排除 integration 文件所以 CI 全绿，真跑 `test:e2e` 时 6 条全红。
 */
const RETIRED_TEMPLATE_IDS = ['travel_infographic_v1', 'travel_full_plan_v1'] as const;

function migrationsDirectory(): string {
  return path.join(process.cwd(), '..', '..', 'infrastructure', 'migrations');
}

function webPublicDirectory(): string {
  return path.join(process.cwd(), '..', 'web', 'public');
}

interface CatalogRow {
  readonly optionKey: string;
  readonly label: string;
  readonly valueKind: string | undefined;
  readonly previewImage: string | undefined;
}

/**
 * 从迁移 SQL 里抽出模板目录行。
 *
 * 逐个 INSERT 块扫，块内按元组匹配 —— 与 `planner-config-coverage.test.ts`
 * 的做法一致（那里有为何这样切块的完整说明）。这里多抽两个字段：
 * `value_kind` 与 `preview_image`，它们都在同一个元组的 JSONB 字面量里。
 */
function catalogRows(): readonly CatalogRow[] {
  const dir = migrationsDirectory();
  const out: CatalogRow[] = [];

  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(path.join(dir, file), 'utf8');

    for (const block of sql.split('INSERT INTO planner_config_options').slice(1)) {
      /*
       * 一个元组 = 一行。逐元组匹配而不是整块正则：
       * 整块匹配会把第一个 `value_kind` 配给所有行，
       * 于是「第二行标错了 kind」这种情况检不出来。
       */
      for (const tuple of block.matchAll(
        /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']*)'[^)]*?\)/g,
      )) {
        const [full, fieldKey, optionKey, label] = tuple;
        if (fieldKey !== TEMPLATE_FIELD_KEY || optionKey === undefined) continue;

        out.push({
          optionKey,
          label: label ?? '',
          valueKind: /"value_kind"\s*:\s*"([A-Z_]+)"/.exec(full)?.[1],
          previewImage: /"preview_image"\s*:\s*"([^"]+)"/.exec(full)?.[1],
        });
      }
    }
  }

  return out;
}

describe('模板样式目录与代码枚举一致', () => {
  const rows = catalogRows();

  it('扫描确实抓到了模板行 —— 防止下面那条反向断言空转', () => {
    /*
     * **没这条的话下面第三条会静默通过**：注册方式一变（改成 CSV 导入、
     * 或者元组形状换了），`rows` 变成空集，而「注册的都是合法枚举值」
     * 对空集恒真。空集是任何集合的子集。
     *
     * 这个陷阱在条件码那组（同目录）的第一条里有原文记录，
     * 这里是同一个坑的第二次出现。
     */
    expect(rows.length, '一行模板配置也没扫到，元组形状可能已改').toBeGreaterThanOrEqual(
      TEMPLATE_ID_VALUES.length,
    );
  });

  it('每个 TEMPLATE_ID_VALUES 都注册进了配置中心', () => {
    const registered = new Set(rows.map((row) => row.optionKey));
    const missing = TEMPLATE_ID_VALUES.filter((id) => !registered.has(id));

    /*
     * 报出缺失清单而不只是数量：这条红的时候，读者要的正是
     * 「哪个套件忘了登记」，而那份清单直接就是要补进迁移的内容。
     */
    expect(missing, '这些套件用户选不到').toEqual([]);
  });

  it('注册的每一行都是合法 TEMPLATE_ID_VALUES', () => {
    /*
     * 反向漏洞同样致命：配置里多一个代码没有的 ID，用户能选中并提交，
     * 而 `TemplateIdSchema`（`z.enum(TEMPLATE_ID_VALUES)`）会拒 ——
     * 症状是界面完全正常却提交被拒，而错误信息指向 schema 校验，
     * 不指向配置中心。
     */
    const known = new Set<string>(TEMPLATE_ID_VALUES);
    const unknown = rows.map((row) => row.optionKey).filter((key) => !known.has(key));

    expect(unknown.sort(), '配置里这些 ID 代码不认').toEqual([]);
  });

  it('每一行都标了 value_kind=ENUM', () => {
    /*
     * 模板 ID 是界面选项，不是条件码。标成 `CONDITION_CODE` 的后果是它们
     * 混进条件码白名单 —— 而那意味着一个拼错的条件码可能因为撞上某个
     * 模板 ID 而通过 N-08（`planner-config-whitelist.test.ts` 的原话）。
     *
     * 完全不标也不行：那会走后缀回退（`field_key` 以 tags 结尾才算条件码），
     * `output.template_id` 不以 tags 结尾因此**恰好**不进白名单 ——
     * 但那是碰巧对，不是设计对。改一次 field_key 就会翻车。
     */
    const wrong = rows.filter((row) => row.valueKind !== 'ENUM');

    expect(
      wrong.map((row) => `${row.optionKey}=${String(row.valueKind)}`),
      '这些行的 value_kind 不是 ENUM',
    ).toEqual([]);
  });

  it('每一行都有中文展示名，且不等于 ID 本身', () => {
    /*
     * `ink_paper_v1` 是给代码与数据库看的，不是给用户看的
     * （`enums.ts` 里 `TEMPLATE_ID_VALUES` 的注释写着这一点）。
     * label 忘了填不会报错，界面上会直接显示下划线 ID。
     */
    const bad = rows.filter((row) => row.label.length === 0 || row.label === row.optionKey);

    expect(bad.map((row) => row.optionKey), '这些行缺展示名').toEqual([]);
  });

  it('每一行的示例图文件真的存在', () => {
    /*
     * 缺图不会报错，只会在界面上渲出一个碎图标 —— 而用户看到的是
     * 「这个样式坏了」，于是不选它。
     *
     * 这条同时守住「加了新套件、登记了配置、但忘了生成示例图」——
     * 那是 `tools/make-template-previews.mjs` 存在的理由，
     * 而忘了跑它这条会红。
     */
    const publicDir = webPublicDirectory();
    const missing: string[] = [];

    for (const row of rows) {
      if (row.previewImage === undefined) {
        missing.push(`${row.optionKey}（metadata 里没有 preview_image）`);
        continue;
      }
      /* 配置里存的是站点绝对路径（`/images/...`），落盘在 web 的 public 下 */
      const file = path.join(publicDir, row.previewImage.replace(/^\//, ''));
      if (!existsSync(file)) missing.push(`${row.optionKey} → ${row.previewImage}`);
    }

    expect(missing, '这些示例图不存在').toEqual([]);
  });

  it('测试与脚本不得在请求体里引用已退役的模板枚举值', () => {
    /*
     * `travel_infographic_v1` / `travel_full_plan_v1` 是 R-85 P1 重命名前的
     * 旧值，已不在 `TEMPLATE_ID_VALUES` 里。**请求体**再引用它们的后果
     * 不是编译错（请求体多为 `Record<string, unknown>`，类型系统抓不住），
     * 而是运行时被 `TemplateIdSchema` 拒成 400 —— 且 `pnpm test` 排除
     * integration 文件，于是 CI 全绿、真跑 `test:e2e` 时整组红。
     * 2026-08-29 实际撞到过一次（pipeline.integration 6 条全红）。
     *
     * **只抓请求体形态**：`output_preferences` 块里出现旧 `template_id`。
     * 其他形态合法且必须保留 —— 模拟历史落库行的 INSERT、草稿里故意放
     * 退役 ID 验回退的用例，都不是违例。全文件禁会让这些用例反过来
     * 成为误报，而误报的守卫会被人删掉。
     */
    const repoRoot = path.join(process.cwd(), '..', '..');
    const scanDirs = [
      path.join(repoRoot, 'apps'),
      path.join(repoRoot, 'packages'),
      path.join(repoRoot, 'tools'),
    ];
    const offenders: string[] = [];
    let scanned = 0;

    for (const dir of scanDirs) {
      for (const file of walkFiles(dir)) {
        if (!/\.(ts|tsx|mjs)$/.test(file)) continue;
        const source = readFileSync(file, 'utf8');
        /* 先剔注释：说明历史的注释引用旧值不违例 */
        const code = source
          .replaceAll(/\/\*[\s\S]*?\*\//g, '')
          .replaceAll(/^\s*\/\/[^\n]*/gm, '');
        for (const retired of RETIRED_TEMPLATE_IDS) {
          /*
           * `[^]` 匹配任意字符（含换行）、`[ \t]*` 匹配空白 —— 两者都不含
           * 反斜杠，否则 `no-windows-path-separator` 规则会把正则里的
           * `\\s` 当成硬编码路径分隔符报错。
           */
          const pattern = new RegExp(
            `output_preferences[^]{0,400}template_id:[ \t]*'${retired}'`,
          );
          if (pattern.test(code)) {
            offenders.push(`${path.relative(repoRoot, file)}: '${retired}'`);
          }
        }
        scanned += 1;
      }
    }

    /* 非空守卫：目录扫不到文件时上面的循环空转，同样是绿的 */
    expect(scanned, '一个文件也没扫到，扫描目录可能已失效').toBeGreaterThan(50);
    expect(offenders, '这些文件的请求体仍引用已退役的模板枚举值').toEqual([]);
  });
});

/** 递归列出目录下的全部文件。node_modules 跳过 */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
