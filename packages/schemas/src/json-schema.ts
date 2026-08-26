import { z } from 'zod';
import { TravelPlanLlmOutputSchema, TravelPlanSchema } from './travel-plan.js';

/**
 * JSON Schema 导出（设计稿 6.3）。
 *
 * 大模型的结构化输出需要 JSON Schema 而不是 Zod 对象。用 Zod 4 内置的
 * `z.toJSONSchema()`，因此**一份 Zod 定义同时服务运行期校验与模型约束** ——
 * 这正是选全 TypeScript 的核心理由（设计稿 22.1）：契约不必维护两份。
 *
 * `io: 'input'` 让导出的 schema 描述**输入**形态。对本项目的 schema 而言
 * 输入输出一致（没有 transform / default），显式声明是为了在将来引入
 * 默认值时不至于把「输出才有的字段」当成模型必须提供的字段。
 */

/** 交给大模型的 schema：不含程序注入的 ID、`schema_version` 与 `status` */
export const travelPlanLlmOutputJsonSchema = z.toJSONSchema(TravelPlanLlmOutputSchema, {
  io: 'input',
  target: 'draft-2020-12',
});

/** 完整 TravelPlan 的 JSON Schema，供契约文档与外部校验工具使用 */
export const travelPlanJsonSchema = z.toJSONSchema(TravelPlanSchema, {
  io: 'input',
  target: 'draft-2020-12',
});

// ── strict 兼容变体（结构化输出实际发出去的那一份）────────────

/**
 * OpenAI `strict: true` 拒绝的校验关键字 —— 命中即 400，不是忽略。
 *
 * 最反直觉的一点：`minLength` / `pattern` 这些在普通 JSON Schema 里完全正确，
 * 也是 Zod 的 `.min()` / `.regex()` 的如实导出。
 *
 * `tools/probe-llm.mjs` 的本地体检 import 这一份，两边不能各写一遍：
 * 漂移的症状是「探针说合规、真实端点 400」，而那时人会先怀疑端点。
 */
export const STRICT_FORBIDDEN_KEYWORDS: readonly string[] = [
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'default',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'unevaluatedProperties',
  'contains',
];

const FORBIDDEN = new Set(STRICT_FORBIDDEN_KEYWORDS);

/**
 * 被改成可空的属性路径（`toStrictJsonSchema` 收集，`normalizeStrictLlmOutput` 消费）。
 *
 * 两个函数共享这一份而不是各自硬编码字段名：它们必须处理**同一批**属性，
 * 而分开写的漂移症状是「模型给了 null、Zod 报 expected number」——
 * 一条指向 schema 的错误，实际原因在这里少加了一行。
 */
type NullablePath = readonly string[];

interface StrictConversion {
  readonly schema: Record<string, unknown>;
  readonly nullablePaths: readonly NullablePath[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把可选属性改成「可空且必填」。
 *
 * strict 不允许可选属性，但**不能因此简单地提为 required**：
 * `total_budget.intercity_transport` 的 `undefined` 有明确语义（见
 * `travel-plan.ts` 那 25 行论证）——「模型没给」，此时校验层不扣除并记一条
 * assumption。强制必填会逼模型填一个数，而它在「确实没有城际交通」时
 * 倾向填 0，于是「未知」与「零」被合并，正是那段注释要区分的东西。
 *
 * OpenAI 对此的标准解法是 `type: ["number", "null"]` + 列进 required：
 * 模型显式给 `null` 表示没有，信息不丢。
 */
function toNullable(node: Record<string, unknown>, at: string): Record<string, unknown> {
  const type = node['type'];
  if (typeof type === 'string') return { ...node, type: [type, 'null'] };
  /*
   * 不静默兜底：可选属性出现别的形态（enum、$ref、已是数组）时，
   * 猜一个转换等于产出一份可能被 400 的 schema，而排查会从这里开始绕。
   * 真出现了就在这里显式支持它。
   */
  throw new Error(
    `无法把 ${at} 转成可空：期望 type 是字符串，实际 ${JSON.stringify(type)}。` +
      '请在 toNullable 里显式支持这种形态',
  );
}

function convert(node: unknown, at: string, nullablePaths: NullablePath[]): unknown {
  if (Array.isArray(node))
    return node.map((item, i) => convert(item, `${at}[${i}]`, nullablePaths));
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN.has(key)) continue;
    out[key] = convert(value, at === '' ? key : `${at}.${key}`, nullablePaths);
  }

  const properties = out['properties'];
  if (!isPlainObject(properties)) return out;

  // 规则 1：object 必须禁止额外属性
  out['additionalProperties'] = false;

  // 规则 2：所有属性必须必填 —— 原先可选的那些先转成可空
  const required = new Set(Array.isArray(out['required']) ? (out['required'] as string[]) : []);
  for (const [name, propSchema] of Object.entries(properties)) {
    if (required.has(name)) continue;
    if (!isPlainObject(propSchema)) continue;

    /*
     * JSON Schema 的内部路径（`properties.total_budget.properties`）要转成
     * 数据路径（`total_budget`）才能给 `normalizeStrictLlmOutput` 用。
     */
    const segments = at.split('.').filter((s) => s !== 'properties' && s !== '');
    /*
     * 数组元素里的可选属性走不通这条路：归一函数按对象键逐层下钻，遇到数组
     * 就停了。现在的 schema 只在 `total_budget` 有可选属性，所以够用 ——
     * 但**必须显式失败**而不是让路径静默失效：后者的症状是「模型给了 null、
     * Zod 报 expected number」，而排查会从 Zod 开始，绕很远才回到这里。
     */
    if (segments.includes('items')) {
      throw new Error(
        `${segments.join('.')}.${name} 是数组元素内的可选属性，` +
          'normalizeStrictLlmOutput 还不支持这种路径 —— 需要先让它能穿过数组',
      );
    }

    properties[name] = toNullable(propSchema, `${at}.${name}`);
    nullablePaths.push([...segments, name]);
  }
  out['required'] = Object.keys(properties);

  return out;
}

function toStrictJsonSchema(schema: Record<string, unknown>): StrictConversion {
  const nullablePaths: NullablePath[] = [];
  const converted = convert(schema, '', nullablePaths);
  return { schema: converted as Record<string, unknown>, nullablePaths };
}

const strictConversion = toStrictJsonSchema(travelPlanLlmOutputJsonSchema);

/**
 * 交给大模型的 strict 兼容 schema —— **结构化输出实际发的是这一份**。
 *
 * ## 为什么不能发原样那一份
 *
 * `z.toJSONSchema()` 的产物违反 strict 的全部三条规则（20 个 object 缺
 * `additionalProperties`、1 个含可选属性、4 类禁用关键字），对 OpenAI
 * 以及照抄那套规则的兼容层（ofox 转发过去就是 OpenAI 在校验）是直接 400。
 * `pnpm probe:llm -- --dry-run` 会把违规点逐条列出，不需要凭据。
 *
 * ## 这不是无损转换
 *
 * 剥掉 `pattern` / `minimum` / `minLength` 等于放弃「模型在解码阶段被硬
 * 约束」：日期写成 `2026/09/01`、`total_days` 超出 1～14、标题为空串这些
 * 原本不可能出现的输出，之后会以「Zod 校验失败 → 3.2.2 定向重生成」的形式
 * 出现，消耗重试次数。
 *
 * 换来的是另一类错误彻底消失：规则 1 与 2 让「字段缺失」与「多给字段」
 * 成为不可能。两类都落到重生成，但前者只是概率降低、后者是概率归零 ——
 * 这是选「strict:true + 净化」而不是「strict:false + 原样」的理由。
 * 后者保留了那些约束作为提示，但形状一点硬保证都没有。
 */
export const travelPlanLlmOutputStrictJsonSchema = strictConversion.schema;

/**
 * 把 strict 模式下模型显式给的 `null` 还原成「没给」。
 *
 * 被 `toNullable` 改成可空的属性，模型会用 `null` 表达「没有这一项」，
 * 而 Zod 侧那些字段是 `.optional()`（`null` 会报 expected number）。
 * 这一步把 `null` 键删掉 —— 于是 `undefined` 的原有语义（不扣除 + 记一条
 * assumption）继续成立，Zod 定义与消费方一行都不用改。
 *
 * 只处理 `nullablePaths` 里的那几个路径，不做「递归删掉所有 null」：
 * 后者会把将来真的以 `null` 为合法值的字段一起吞掉，而那种缺陷
 * 表现为「字段莫名消失」，极难查。
 */
export function normalizeStrictLlmOutput(data: unknown): unknown {
  if (!isPlainObject(data)) return data;

  for (const path of strictConversion.nullablePaths) {
    let cursor: Record<string, unknown> = data;
    for (const segment of path.slice(0, -1)) {
      const next = cursor[segment];
      if (!isPlainObject(next)) {
        cursor = {};
        break;
      }
      cursor = next;
    }
    const leaf = path[path.length - 1];
    if (leaf !== undefined && cursor[leaf] === null) delete cursor[leaf];
  }

  return data;
}
