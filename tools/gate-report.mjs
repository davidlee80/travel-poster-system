#!/usr/bin/env node
/**
 * 24.1 门禁报告（TP-5-06）。
 *
 * ```bash
 * pnpm gate                 # 跑全部可自动化的项
 * pnpm gate -- --list       # 只列清单，不执行
 * pnpm gate -- --only 1,13  # 只跑指定编号
 * ```
 *
 * ## 相同命令只跑一次
 *
 * 34 项里有 6 项都由 `pnpm test:acceptance` 覆盖（#1/#2/#3/#4/#12/#19/#21）。
 * 逐项执行会把那条 20 用例的测试跑七遍，一次门禁从两分钟变成十四分钟 ——
 * 而慢到没人愿意跑的门禁等于没有门禁。因此按命令去重，一次结果映射到多项。
 *
 * ## 退出码
 *
 * ```text
 * 0  全部可自动化的项通过
 * 1  有自动化项失败
 * ```
 *
 * `ci-only` 与 `manual` 不影响退出码，但会在报告里单独列出并计数 ——
 * 把它们算成失败会让本机跑门禁永远是红的（于是没人跑），
 * 算成通过则是说谎。它们需要的是**可见**，不是一个布尔值。
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { GATES, GATE_COUNT } from './acceptance-gates.mjs';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const listOnly = args.includes('--list');
const onlyArg = args.find((arg) => arg.startsWith('--only'));
const only = onlyArg
  ? new Set(
      (onlyArg.includes('=') ? onlyArg.split('=')[1] : (args[args.indexOf(onlyArg) + 1] ?? ''))
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value)),
    )
  : null;

const hasDb = process.env['DATABASE_URL'] !== undefined && process.env['REDIS_URL'] !== undefined;

// 自检：清单本身必须完整且编号连续（漏一项不该是静默的）
if (GATES.length !== GATE_COUNT) {
  console.error(`门禁清单有 ${GATES.length} 项，24.1 要求 ${GATE_COUNT} 项`);
  process.exit(1);
}
for (const [index, gate] of GATES.entries()) {
  if (gate.id !== index + 1) {
    console.error(`门禁编号不连续：第 ${index + 1} 项的 id 是 ${gate.id}`);
    process.exit(1);
  }
}

const selected = GATES.filter((gate) => only === null || only.has(gate.id));

if (listOnly) {
  for (const gate of selected) {
    const mark = gate.kind === 'command' ? '·' : gate.kind === 'ci-only' ? 'CI' : '人工';
    console.log(`${String(gate.id).padStart(2)} [${mark}] ${gate.title}`);
    console.log(`      依据 ${gate.ref}`);
    if (gate.run) console.log(`      ${gate.run}`);
    if (gate.why) console.log(`      ${gate.why}`);
  }
  process.exit(0);
}

/** 命令 → 执行结果缓存（同一命令只跑一次） */
const results = new Map();

function runCommand(command) {
  const cached = results.get(command);
  if (cached !== undefined) return cached;

  process.stdout.write(`  跑 ${command}\n`);
  const started = Date.now();
  const outcome = spawnSync(command, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: process.env,
  });
  const result = {
    ok: outcome.status === 0,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    /*
     * 只在失败时保留输出。成功时留着它会让一次门禁报告有几万行 ——
     * 而门禁报告的用途是「哪一项红了」，不是「测试跑了什么」。
     */
    output: outcome.status === 0 ? '' : `${outcome.stdout ?? ''}${outcome.stderr ?? ''}`.trim(),
  };
  results.set(command, result);
  return result;
}

const report = [];

for (const gate of selected) {
  if (gate.kind !== 'command') {
    report.push({ gate, status: gate.kind });
    continue;
  }
  if (gate.needsDb === true && !hasDb) {
    report.push({ gate, status: 'skipped-no-db' });
    continue;
  }
  const result = runCommand(gate.run);
  report.push({ gate, status: result.ok ? 'pass' : 'fail', result });
}

// ── 报告 ─────────────────────────────────────────────────
const LABELS = {
  pass: '通过',
  fail: '失败',
  'ci-only': '仅 CI',
  manual: '人工',
  'skipped-no-db': '跳过（缺 DATABASE_URL / REDIS_URL）',
};

console.log('\n24.1 验收门禁报告\n');
for (const entry of report) {
  const label = LABELS[entry.status];
  console.log(`${String(entry.gate.id).padStart(2)}  ${label.padEnd(4)}  ${entry.gate.title}`);
}

const counts = report.reduce((accumulator, entry) => {
  accumulator[entry.status] = (accumulator[entry.status] ?? 0) + 1;
  return accumulator;
}, {});

console.log('\n汇总');
for (const [status, label] of Object.entries(LABELS)) {
  if (counts[status] !== undefined) console.log(`  ${label}：${counts[status]} 项`);
}

const failures = report.filter((entry) => entry.status === 'fail');
if (failures.length > 0) {
  console.error('\n失败详情\n');
  for (const entry of failures) {
    console.error(`── #${entry.gate.id} ${entry.gate.title}`);
    console.error(`   ${entry.gate.run}`);
    // 只留尾部：vitest 的失败摘要在最后，而前面是几百行通过的用例
    const tail = entry.result.output.split('\n').slice(-40).join('\n');
    console.error(`${tail}\n`);
  }
}

if (counts['skipped-no-db'] !== undefined) {
  console.log(
    '\n提示：设置 DATABASE_URL 与 REDIS_URL 后可跑完全部自动化项（pnpm infra:up 起本地依赖）。',
  );
}
if (counts['ci-only'] !== undefined || counts['manual'] !== undefined) {
  console.log(
    '仅 CI 与人工两类不计入退出码 —— 它们需要的是可见，而不是一个布尔值。' +
      '逐项理由见 tools/acceptance-gates.mjs。',
  );
}

process.exit(failures.length > 0 ? 1 : 0);
