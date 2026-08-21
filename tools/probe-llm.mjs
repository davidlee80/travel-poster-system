#!/usr/bin/env node
/**
 * OpenAI 兼容端点的能力探测（接第三方中转站 / 直连供应商前用）。
 *
 *   node tools/probe-llm.mjs --base-url https://xxx --model gpt-4o
 *   LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... node tools/probe-llm.mjs
 *   node tools/probe-llm.mjs --dry-run          # 只做本地 schema 体检，不发请求
 *
 * ## 存在的理由
 *
 * `packages/llm/src/client.ts` 的 `DirectLlmClient` 从来没对**真实端点**跑过 ——
 * 它的测试注入 fake fetch，只断言请求体字段名。而生产代码为了不回显提示词
 * （二十章禁止 raw_request 落日志），HTTP 错误只保留状态码：
 *
 *     throw new LlmUnavailableError(`HTTP ${response.status}`);
 *
 * 这个取舍在生产上是对的，在首次联调时却让人完全瞎着调 —— 端点拼错、
 * 参数名过时、schema 不合规、模型不支持结构化输出，四种原因在日志里
 * 长得一模一样：`PLAN_LLM_UNAVAILABLE: HTTP 400`。
 *
 * 这个脚本是那个取舍的**对侧**：它是一次性诊断工具，不入生产路径，
 * 因此可以回显完整错误体。发出去的提示是固定的假数据（杭州 1 天行程），
 * 不含任何用户信息，所以回显是安全的。
 *
 * ## 为什么要「先协商基线，再单独变动 response_format」
 *
 * 如果一上来就发完整请求，400 的原因无法归因。所以分三步：
 *   阶段 A  只探端点拼法（最小请求、无 response_format）
 *   阶段 B  只探参数名（max_tokens / max_completion_tokens、temperature）
 *   阶段 C  基线固定，只变 response_format —— 此时失败必然出自结构化输出
 *
 * 隔离变量是这个脚本唯一的设计要点。少了它，输出就只是一串 400。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = path.join(repoRoot, 'packages', 'schemas', 'dist', 'index.js');

let schemas;
try {
  schemas = await import(`file://${distEntry.split(path.sep).join('/')}`);
} catch (error) {
  process.stderr.write(
    `无法加载 @tps/schemas 的构建产物：${distEntry}\n` +
      `先运行 pnpm --filter @tps/schemas run build（或用 pnpm probe:llm）。\n` +
      `原始错误：${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}

/** 生产代码实际交给模型的那一份（generate-plan.ts:266） */
const REAL_SCHEMA = schemas.travelPlanLlmOutputJsonSchema;

// ── CLI ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? '') : '';
}
const has = (name) => argv.includes(`--${name}`);

const baseUrlRaw = flag('base-url') || (process.env['LLM_BASE_URL'] ?? '').trim();
const apiKey = flag('api-key') || (process.env['LLM_API_KEY'] ?? '').trim();
const model = flag('model') || (process.env['LLM_MODEL'] ?? '').trim();
const dryRun = has('dry-run');
const timeoutMs = Number(flag('timeout') || '60000');

// 与 client.ts 一致：去掉末尾斜杠，避免拼出 //v1/...
const baseUrl = baseUrlRaw.replace(/\/+$/, '');

// ── strict 模式的 schema 体检 ───────────────────────────────

/*
 * OpenAI `strict: true` 的硬性规则（也是多数中转站兼容层照抄的那一套）：
 *   1. 每个 type:'object' 必须显式 additionalProperties:false
 *   2. object 的所有 properties 必须全部列进 required（不允许可选字段）
 *   3. 拒绝一批校验关键字 —— 命中即 400，不是忽略
 * 第 3 条最反直觉：minLength / pattern 这些在普通 JSON Schema 里完全正确。
 */
const STRICT_FORBIDDEN = new Set([
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
]);

function auditStrict(
  node,
  at = '',
  report = { objects: 0, missingAP: [], optional: [], forbidden: new Map() },
) {
  if (node === null || typeof node !== 'object') return report;
  if (Array.isArray(node)) {
    node.forEach((v, i) => auditStrict(v, `${at}[${i}]`, report));
    return report;
  }

  for (const key of Object.keys(node)) {
    if (!STRICT_FORBIDDEN.has(key)) continue;
    const hits = report.forbidden.get(key) ?? [];
    if (hits.length < 3) hits.push(at || '(root)');
    report.forbidden.set(key, hits);
  }

  if (node.type === 'object' || node.properties !== undefined) {
    report.objects += 1;
    if (node.additionalProperties !== false) report.missingAP.push(at || '(root)');
    const required = new Set(node.required ?? []);
    const missing = Object.keys(node.properties ?? {}).filter((p) => !required.has(p));
    if (missing.length > 0) report.optional.push(`${at || '(root)'}: ${missing.join(', ')}`);
  }

  for (const [key, value] of Object.entries(node)) {
    auditStrict(value, at === '' ? key : `${at}.${key}`, report);
  }
  return report;
}

/**
 * 把 schema 改造成满足 strict 三条规则的形态。
 *
 * **这不是无损转换。** 剥掉 minLength / pattern / minimum 等于放弃
 * 「模型在解码阶段被硬约束」，把这些检查完全交给解析后的 Zod。
 * 代价是真实存在的：日期格式错、字符串为空、天数越界这些原本不可能
 * 发生的输出，之后会以「校验失败 → 重试」的形式出现，消耗 3.2.2 的
 * 重生成次数。收益是请求不再被端点直接 400 拒掉。
 *
 * 采用与否取决于阶段 C 的实测结果，脚本本身不做决定。
 */
function sanitizeForStrict(node) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sanitizeForStrict);

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (STRICT_FORBIDDEN.has(key)) continue;
    out[key] = sanitizeForStrict(value);
  }

  if (out.type === 'object' || out.properties !== undefined) {
    out.additionalProperties = false;
    // 规则 2：strict 不允许可选字段，把全部属性提为 required
    if (out.properties !== undefined) out.required = Object.keys(out.properties);
  }
  return out;
}

const SANITIZED_SCHEMA = sanitizeForStrict(REAL_SCHEMA);

function printAudit(label, schema) {
  const r = auditStrict(schema);
  const ok = r.missingAP.length === 0 && r.optional.length === 0 && r.forbidden.size === 0;
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${label}\n`);
  process.stdout.write(`      object 节点 ${r.objects} 个\n`);
  process.stdout.write(
    `      缺 additionalProperties:false ： ${r.missingAP.length}` +
      (r.missingAP.length > 0 ? `（如 ${r.missingAP.slice(0, 3).join(' / ')}）` : '') +
      '\n',
  );
  process.stdout.write(`      含可选属性的 object      ： ${r.optional.length}\n`);
  process.stdout.write(
    `      strict 禁用关键字         ： ${r.forbidden.size} 种` +
      (r.forbidden.size > 0 ? `（${[...r.forbidden.keys()].sort().join(' / ')}）` : '') +
      '\n',
  );
  return ok;
}

process.stdout.write('\n【本地体检】交给模型的 JSON Schema 是否满足 strict 模式\n\n');
const realOk = printAudit('原样 schema（= 现在生产代码发出去的）', REAL_SCHEMA);
process.stdout.write('\n');
printAudit('净化后 schema（候选修复方案）', SANITIZED_SCHEMA);

if (!realOk) {
  process.stdout.write(
    '\n  → 原样 schema 不满足 strict 规则。对严格实现该规则的端点，\n' +
      '    `strict: true` 会被直接 400 拒掉，在日志里表现为 HTTP 400。\n' +
      '    阶段 C 的 S1 与 S2 会实测这一点。\n',
  );
}

if (dryRun) {
  process.stdout.write('\n--dry-run：跳过所有网络请求。\n');
  process.exit(0);
}

// ── 网络探测 ────────────────────────────────────────────────

if (baseUrl === '' || apiKey === '' || model === '') {
  process.stderr.write(
    '\n缺少凭据。三项都要给（CLI 参数优先于环境变量）：\n' +
      `  --base-url  ${baseUrl || '(空)'}\n` +
      `  --api-key   ${apiKey === '' ? '(空)' : `已给，长度 ${apiKey.length}`}\n` +
      `  --model     ${model || '(空)'}\n\n` +
      '只想看本地 schema 体检结果时加 --dry-run。\n',
  );
  process.exit(2);
}

process.stdout.write(
  `\n【网络探测】\n  base-url : ${baseUrl}\n  model    : ${model}\n` +
    `  api-key  : ${apiKey.slice(0, 4)}…（长度 ${apiKey.length}，不完整回显）\n` +
    '  提示内容 : 固定假数据（杭州 1 天行程），不含用户信息\n',
);

const SYSTEM = '你是行程规划助手，严格按给定的 JSON Schema 输出，不要输出 Schema 之外的任何文字。';
const USER = '生成杭州 1 天行程：2 位成人，2026-09-01 出发，总预算 800 元人民币。';

/** 发一次请求，把失败也当数据返回（不抛） */
async function callChat(endpointPath, body) {
  const url = `${baseUrl}${endpointPath}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* 中转站故障时常返回 HTML 错误页，保持 json 为 undefined */
    }
    return { url, status: response.status, ok: response.ok, text, json };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    return {
      url,
      status: 0,
      ok: false,
      text: `${name}: ${error instanceof Error ? error.message : String(error)}`,
      transport: name === 'TimeoutError' ? 'timeout' : 'network',
    };
  }
}

/** 从各家不一样的错误体里挖出人类可读的那一句 */
function errorDetail(res) {
  const e = res.json?.error;
  const msg = typeof e === 'string' ? e : (e?.message ?? res.json?.message);
  return (typeof msg === 'string' ? msg : res.text).replace(/\s+/g, ' ').slice(0, 400);
}

// ── 阶段 A：端点拼法 ────────────────────────────────────────

process.stdout.write('\n─ 阶段 A：端点拼法 ─────────────────────────────\n');
process.stdout.write(
  '  client.ts 拼的是 baseUrl + "/v1/chat/completions"。中转站给的地址\n' +
    '  常常已经带 /v1，那样会拼成 /v1/v1/... → 404。\n\n',
);

const CANDIDATES = ['/v1/chat/completions', '/chat/completions'];
const minimalBody = { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 };

let endpointPath = '';
for (const candidate of CANDIDATES) {
  const res = await callChat(candidate, minimalBody);
  // 404 = 路径不存在；401/400 说明路由到了处理器，路径是对的
  const verdict =
    res.status === 404 ? '✗ 404（路径不存在）' : `✓ HTTP ${res.status}（已路由到处理器）`;
  process.stdout.write(`  ${res.url}\n      ${verdict}\n`);
  if (res.status === 0) process.stdout.write(`      ${res.text}\n`);
  if (res.status === 401 || res.status === 403) {
    process.stdout.write(`      ⚠ 鉴权被拒：${errorDetail(res)}\n`);
  }
  if (endpointPath === '' && res.status !== 404 && res.status !== 0) endpointPath = candidate;
}

if (endpointPath === '') {
  process.stdout.write('\n  两种拼法都不可用，后续探测无意义。先确认 base-url 与网络连通性。\n');
  process.exit(1);
}

process.stdout.write(`\n  采用：${endpointPath}\n`);
if (endpointPath !== '/v1/chat/completions') {
  process.stdout.write(
    `  ⚠ 与 client.ts 硬编码的 "/v1/chat/completions" 不一致。\n` +
      `    对策是 LLM_BASE_URL 去掉尾部 /v1（改配置，不改代码）。\n`,
  );
}

// ── 阶段 B：参数名 ──────────────────────────────────────────

process.stdout.write('\n─ 阶段 B：基线参数 ─────────────────────────────\n');

let tokenField = 'max_tokens';
let sendTemperature = true;

const tokenProbe = await callChat(endpointPath, {
  model,
  messages: [{ role: 'user', content: 'ping' }],
  max_tokens: 8,
});
if (!tokenProbe.ok && /max_completion_tokens|max_tokens/i.test(errorDetail(tokenProbe))) {
  const alt = await callChat(endpointPath, {
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_completion_tokens: 8,
  });
  if (alt.ok) tokenField = 'max_completion_tokens';
}
process.stdout.write(
  `  token 上限字段 : ${tokenField}` +
    (tokenField === 'max_tokens' ? '（与 client.ts:187 一致）' : '（⚠ client.ts:187 需要改）') +
    '\n',
);

const tempProbe = await callChat(endpointPath, {
  model,
  messages: [{ role: 'user', content: 'ping' }],
  [tokenField]: 8,
  temperature: 0.3,
});
if (!tempProbe.ok && /temperature/i.test(errorDetail(tempProbe))) {
  sendTemperature = false;
}
process.stdout.write(
  `  temperature    : ${sendTemperature ? '接受 0.3（与 client.ts:207 一致）' : '⚠ 被拒，client.ts:207 需要按模型跳过'}\n`,
);

if (!tempProbe.ok && sendTemperature) {
  process.stdout.write(`  ⚠ 基线请求仍失败：HTTP ${tempProbe.status} ${errorDetail(tempProbe)}\n`);
}

function baseBody() {
  return {
    model,
    [tokenField]: 4096,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: USER },
    ],
    ...(sendTemperature ? { temperature: 0.3 } : {}),
  };
}

// ── 阶段 C：结构化输出矩阵 ──────────────────────────────────

const CASES = [
  {
    id: 'S1',
    label: 'json_schema + strict:true + 原样 schema',
    note: '= 现在生产代码的行为',
    format: {
      type: 'json_schema',
      json_schema: { name: 'travel_plan', schema: REAL_SCHEMA, strict: true },
    },
  },
  {
    id: 'S2',
    label: 'json_schema + strict:true + 净化 schema',
    note: '候选修复；代价是丢掉模型侧的格式与范围约束',
    format: {
      type: 'json_schema',
      json_schema: { name: 'travel_plan', schema: SANITIZED_SCHEMA, strict: true },
    },
  },
  {
    id: 'S3',
    label: 'json_schema + strict:false + 原样 schema',
    note: 'schema 降级为「建议」，输出形状无硬保证',
    format: {
      type: 'json_schema',
      json_schema: { name: 'travel_plan', schema: REAL_SCHEMA, strict: false },
    },
  },
  {
    id: 'S4',
    label: 'json_object',
    note: '只保证是 JSON，不保证形状',
    format: { type: 'json_object' },
  },
  { id: 'S5', label: '不带 response_format', note: '兜底：靠提示词要求 JSON', format: undefined },
];

const only = flag('only');
const selected = only === '' ? CASES : CASES.filter((c) => only.split(',').includes(c.id));

process.stdout.write('\n─ 阶段 C：结构化输出能力 ───────────────────────\n');
process.stdout.write(`  基线已固定，只变 response_format —— 失败即出自结构化输出。\n`);
process.stdout.write(`  将发出 ${selected.length} 次真实调用（各约 4k token 上限）。\n`);

const results = [];
for (const testCase of selected) {
  const body = baseBody();
  if (testCase.format !== undefined) body.response_format = testCase.format;

  const res = await callChat(endpointPath, body);
  process.stdout.write(`\n  [${testCase.id}] ${testCase.label}\n        ${testCase.note}\n`);

  if (!res.ok) {
    process.stdout.write(`        ✗ HTTP ${res.status}\n        ${errorDetail(res)}\n`);
    results.push({ ...testCase, verdict: 'http', status: res.status });
    continue;
  }

  const choice = res.json?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    process.stdout.write('        ✗ 200 但缺 message.content\n');
    results.push({ ...testCase, verdict: 'no-content' });
    continue;
  }

  /*
   * 围栏检测是这个脚本最实用的一项：client.ts 直接 JSON.parse(content)，
   * 遇到 ```json 包裹会以 PLAN_LLM_OUTPUT_UNPARSEABLE 结束 —— 而那个码
   * 的含义是「我们的提示或 schema 有问题」，会把排查引向错误方向。
   */
  const fenced = /^\s*```/.test(content);
  const truncated = choice?.finish_reason === 'length';

  let parsed;
  let parseError = '';
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  const marks = [];
  if (fenced) marks.push('⚠ 被 Markdown 围栏包裹（client.ts 会解析失败）');
  if (truncated) marks.push(`⚠ finish_reason=length，输出在 ${body[tokenField]} token 处被截断`);
  if (parseError !== '') marks.push(`✗ content 不是合法 JSON：${parseError}`);

  if (parsed !== undefined && parseError === '') {
    const keys = Object.keys(parsed);
    const wanted = REAL_SCHEMA.required ?? [];
    const missing = wanted.filter((k) => !keys.includes(k));
    marks.push(
      missing.length === 0
        ? `✓ 合法 JSON，顶层必填字段齐全（${wanted.length} 个）`
        : `⚠ 合法 JSON，但顶层缺字段：${missing.join(', ')}`,
    );
  }

  process.stdout.write(
    `        HTTP 200，回显 model=${res.json?.model ?? '(无)'}，` +
      `token in/out=${res.json?.usage?.prompt_tokens ?? '?'}/${res.json?.usage?.completion_tokens ?? '?'}\n`,
  );
  marks.forEach((m) => process.stdout.write(`        ${m}\n`));

  results.push({
    ...testCase,
    verdict: parseError === '' && !fenced && !truncated ? 'pass' : 'degraded',
  });
}

// ── 结论 ────────────────────────────────────────────────────

process.stdout.write('\n─ 结论 ─────────────────────────────────────────\n\n');
for (const r of results) {
  const icon = r.verdict === 'pass' ? '✓' : r.verdict === 'degraded' ? '~' : '✗';
  const tail = r.verdict === 'http' ? ` (HTTP ${r.status})` : '';
  process.stdout.write(`  ${icon} ${r.id}  ${r.label}${tail}\n`);
}

const s1 = results.find((r) => r.id === 'S1');
const s2 = results.find((r) => r.id === 'S2');

process.stdout.write('\n');
if (s1?.verdict === 'pass') {
  process.stdout.write('  现有代码可直接用：LLM_MODE=direct + 三个环境变量，不必改 client.ts。\n');
} else if (s2?.verdict === 'pass') {
  process.stdout.write(
    '  需要改代码：strict 模式可用，但 schema 必须先净化。\n' +
      '  落点是 packages/schemas（导出一份 strict 兼容的 schema），\n' +
      '  而不是在 client.ts 里就地改 —— 那里没有 schema 的上下文。\n' +
      '  注意净化会把格式与范围约束从「解码期硬保证」降为「解析后校验+重试」。\n',
  );
} else {
  process.stdout.write(
    '  strict 两档都不可用。看上面 S3/S4/S5 哪档通过，\n' +
      '  再决定是否给 LlmConfig 增加一个「结构化输出档位」配置项。\n' +
      '  若只有 S4/S5 通过，还需要在 client.ts 里剥离 Markdown 围栏。\n',
  );
}

const anyPass = results.some((r) => r.verdict === 'pass');
process.exit(anyPass ? 0 : 1);
