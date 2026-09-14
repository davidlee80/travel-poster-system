// Windows-only orchestration tests. Docker, HTTP and browser calls are mocked.
// Run: node --test tools/start-local-test.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesRoot = path.join(repo, 'tmp', 'start-local-test-tests');
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

function fixture(t) {
  mkdirSync(fixturesRoot, { recursive: true });
  const dir = mkdtempSync(path.join(fixturesRoot, 'case-'));
  for (const relative of ['tools', 'apps/web/.next', 'packages/shared/.turbo', '.turbo']) {
    mkdirSync(path.join(dir, relative), { recursive: true });
  }
  copyFileSync(
    path.join(repo, 'tools/start-local-test.ps1'),
    path.join(dir, 'tools/start-local-test.ps1'),
  );
  writeFileSync(path.join(dir, '.env.deploy'), 'KEEP_EXISTING_CONFIG=true');
  writeFileSync(path.join(dir, 'apps/web/.next/sentinel'), 'old cache');
  writeFileSync(path.join(dir, 'apps/web/source.ts'), 'keep source');
  t.after(() => {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), fixturesRoot);
    rmSync(target, { recursive: true, force: true });
  });
  return dir;
}

function run(
  dir,
  {
    dryRun = false,
    failBuild = false,
    httpStatus = 200,
    metadataFailures = 0,
    heldLock = false,
    initExitCode = 0,
  } = {},
) {
  const log = path.join(dir, 'calls.jsonl');
  const driver = path.join(dir, 'driver.ps1');
  writeFileSync(
    driver,
    `
$ErrorActionPreference = 'Stop'
$global:buildAttempts = 0
${
  heldLock
    ? `
New-Item -ItemType Directory -Path ${quote(path.join(dir, 'tmp'))} -Force | Out-Null
$heldLock = [IO.File]::Open(${quote(path.join(dir, 'tmp/start-local-test.lock'))}, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
`
    : ''
}
function global:docker {
    ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath ${quote(log)}
    $global:LASTEXITCODE = 0
    if ($args -contains 'info') { Write-Output 'linux' }
    if ($args -contains 'inspect') { Write-Output '{"Status":"exited","ExitCode":${initExitCode}}' }
    # Emulate Compose failing on a successful one-shot service with a global --wait.
    if (($args -contains '--wait') -and !($args -contains '--no-deps')) { $global:LASTEXITCODE = 1 }
    if (${failBuild ? '$true' : '$false'} -and ($args -contains 'build')) { $global:LASTEXITCODE = 42 }
    if ($args -contains 'build') {
        $global:buildAttempts++
        if ($global:buildAttempts -le ${metadataFailures}) {
            Write-Error 'no valid drivers found: failed to read metadata: open meta.json: The process cannot access the file because it is being used by another process.'
            $global:LASTEXITCODE = 1
        }
    }
}
function global:Start-Sleep { param($Seconds) }
function global:Invoke-WebRequest {
    param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
    return [pscustomobject]@{ StatusCode = ${httpStatus} }
}
& ${quote(path.join(dir, 'tools/start-local-test.ps1'))} -NoBrowser ${dryRun ? '-DryRun' : ''}
exit $LASTEXITCODE
`,
  );
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driver],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.ifError(result.error);
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    : [];
  return { ...result, calls };
}

const windows = { skip: process.platform !== 'win32' };

test('dry run preserves caches, config and makes no Docker calls', windows, (t) => {
  const dir = fixture(t);
  const result = run(dir, { dryRun: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
  assert.ok(existsSync(path.join(dir, 'apps/web/.next/sentinel')));
  assert.equal(readFileSync(path.join(dir, '.env.deploy'), 'utf8'), 'KEEP_EXISTING_CONFIG=true');
});

test('build failure does not stop or recreate running services', windows, (t) => {
  const dir = fixture(t);
  const result = run(dir, { failBuild: true });
  assert.equal(result.status, 1);
  assert.ok(result.calls.some((args) => args.includes('build') && args.includes('--no-cache')));
  assert.equal(result.calls.filter((args) => args.includes('build')).length, 1);
  assert.ok(result.calls.every((args) => !args.includes('stop') && !args.includes('up')));
});

test('successful run clears only build outputs and rebuilds before restarting', windows, (t) => {
  const dir = fixture(t);
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!existsSync(path.join(dir, 'apps/web/.next')));
  assert.ok(!existsSync(path.join(dir, '.turbo')));
  assert.ok(!existsSync(path.join(dir, 'packages/shared/.turbo')));
  assert.ok(existsSync(path.join(dir, 'apps/web/source.ts')));
  assert.equal(readFileSync(path.join(dir, '.env.deploy'), 'utf8'), 'KEEP_EXISTING_CONFIG=true');
  const build = result.calls.findIndex((args) => args.includes('build'));
  const builds = result.calls.filter((args) => args.includes('build'));
  assert.deepEqual(
    builds.map((args) => args.slice(args.indexOf('build') + 1)),
    [
      ['--no-cache', 'api'],
      ['--no-cache', 'web'],
      ['--no-cache', 'generation-worker'],
      ['--no-cache', 'render-worker'],
      ['--no-cache', 'retention-worker'],
    ],
  );
  const stop = result.calls.findIndex((args) => args.includes('stop'));
  const up = result.calls.findIndex((args) => args.includes('up'));
  assert.ok(build >= 0 && build < stop && stop < up);
  assert.ok(result.calls[up].includes('--force-recreate'));
  assert.ok(!result.calls[up].includes('--wait'));
  const wait = result.calls.find((args) => args.includes('--wait'));
  assert.ok(wait.includes('--no-deps') && wait.includes('--no-recreate'));
  assert.ok(wait.includes('api') && wait.includes('web') && wait.includes('minio'));
  assert.ok(!wait.includes('minio-init') && !wait.includes('migrate'));
  const inspected = result.calls
    .filter((args) => args.includes('inspect'))
    .map((args) => args.at(-1));
  assert.deepEqual(inspected, ['tps-db-migrate', 'tps-minio-init']);
  assert.ok(
    result.calls.every(
      (args) => !args.some((arg) => ['prune', 'down', '-v', 'FLUSHDB', 'FLUSHALL'].includes(arg)),
    ),
  );
});

test('failed initialization is not mistaken for a successful startup', windows, (t) => {
  const result = run(fixture(t), { initExitCode: 2 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /initialization failed \(exit 2\)/);
  assert.doesNotMatch(result.stdout, /Local test ready/);
});

test('temporary Docker metadata sharing violations retry only the failed service', windows, (t) => {
  const result = run(fixture(t), { metadataFailures: 2 });
  assert.equal(result.status, 0, result.stderr);
  const targets = result.calls.filter((args) => args.includes('build')).map((args) => args.at(-1));
  assert.deepEqual(targets, [
    'api',
    'api',
    'api',
    'web',
    'generation-worker',
    'render-worker',
    'retention-worker',
  ]);
});

test(
  'persistent metadata lock stops after three attempts and preserves running services',
  windows,
  (t) => {
    const result = run(fixture(t), { metadataFailures: 10 });
    assert.equal(result.status, 1);
    assert.equal(result.calls.filter((args) => args.includes('build')).length, 3);
    assert.ok(result.calls.every((args) => !args.includes('stop') && !args.includes('up')));
    assert.match(result.stderr, /still locked after 3 attempts/);
    assert.doesNotMatch(result.stdout, /Inspect service logs/);
  },
);

test('another active script prevents cache deletion and Docker calls', windows, (t) => {
  const dir = fixture(t);
  const result = run(dir, { heldLock: true });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, []);
  assert.ok(existsSync(path.join(dir, 'apps/web/.next/sentinel')));
  assert.match(result.stderr, /Cannot acquire the local test lock/);
});

test('unhealthy HTTP response is reported as failure', windows, (t) => {
  const result = run(fixture(t), { httpStatus: 503 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HTTP 503/);
});

test('linked cache paths are rejected without deleting the destination', windows, (t) => {
  const dir = fixture(t);
  const outside = fixture(t);
  const cache = path.join(dir, 'apps/web/.next');
  // Replace the empty fixture cache with a junction to another fixture.
  assert.ok(cache.startsWith(dir + path.sep));
  rmSync(cache, { recursive: true });
  const setup = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `New-Item -ItemType Junction -Path ${quote(cache)} -Target ${quote(outside)} | Out-Null`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(setup.status, 0, setup.stderr);
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing a linked path/);
  assert.ok(existsSync(path.join(outside, 'apps/web/.next/sentinel')));
  assert.ok(result.calls.every((args) => !args.includes('build') && !args.includes('stop')));
});
