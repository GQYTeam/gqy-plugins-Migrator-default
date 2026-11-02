// 端到端幂等与 JSON-RPC 协议（index.js）：运行期造最小旧版导出，跑真实主流程。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runMigration } = require('../index.js');
const report = require('../src/report');

const { buildLegacyExport, makeTargetHome, readJsonl } = await import('./build-legacy.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listReports(home) {
  const dir = path.join(home, '.migrate-reports');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
}

test('idempotent: dry-run 只出报告，不写数据', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const result = runMigration({ input: fixture.input, home: target.home });
    assert.equal(result.output.applied, false);
    assert.equal(result.output.dry_run, true);
    assert.equal(result.output.units['personas.memory'].records.facts, 2);
    assert.equal(result.output.units['personas.memory'].records.episodes, 3);
    assert.equal(result.output.units['personas.memory'].records.revisions, 1);
    assert.equal(result.output.units['personas.memory'].orphan_vectors, 1);
    assert.equal(result.output.units['personas.memory'].missing_vectors, 3);
    assert.equal(result.output.units['personas.memory'].missing, 1);
    assert.equal(result.output.units['state.evicted_context'].records.evicted, 1);
    assert.equal(result.output.exit_code, 0);
    assert.equal(result.output.totals.records_added, 0);

    // 报告落盘
    const reports = listReports(target.home);
    assert.equal(reports.length, 1);
    const saved = report.readJsonSafe(path.join(target.home, '.migrate-reports', reports[0]), null);
    assert.equal(saved.applied, false);
    assert.equal(saved.schema_version, 1);
    assert.equal(saved.units['personas.memory'].status, 'planned');
    assert.equal(saved.totals.records, 7); // facts 2 + episodes 3 + revisions 1 + evicted 1
    // 目标里不应出现记忆数据
    assert.equal(fs.existsSync(path.join(target.home, 'memory')), false);
    assert.equal(fs.existsSync(path.join(target.home, 'providers.json')), false);
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

test('idempotent: apply 落盘 + 二次 apply records_added=0', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const first = runMigration({ input: fixture.input, home: target.home, apply: true });
    assert.equal(first.output.applied, true);
    assert.equal(first.output.totals.records_added, 7);
    assert.equal(first.output.units['personas.memory'].status, 'applied');
    assert.equal(readJsonl(path.join(target.home, 'memory', 'default', 'facts.jsonl')).length, 2);
    assert.equal(readJsonl(path.join(target.home, 'memory', 'default', 'episodes.jsonl')).length, 3);
    assert.equal(
      report.readJsonSafe(path.join(target.home, 'memory', 'meta.json'), null).migrated_from
        .source_fingerprint,
      first.output.source_fingerprint,
    );
    assert.ok(fs.existsSync(path.join(target.home, 'kb', 'meta.json')));
    assert.ok(fs.existsSync(path.join(target.home, 'themes', 'webui-theme.css')));
    assert.ok(fs.existsSync(path.join(target.home, 'identities', 'Test Cat.md')));
    assert.ok(fs.existsSync(path.join(target.home, 'profile.md')));

    const factsAfterFirst = fs.readFileSync(path.join(target.home, 'memory', 'default', 'facts.jsonl'), 'utf8');
    const reportsBefore = listReports(target.home);

    const second = runMigration({ input: fixture.input, home: target.home, apply: true });
    assert.equal(second.output.totals.records_added, 0);
    assert.equal(second.output.units['personas.memory'].status, 'unchanged');
    assert.equal(second.output.units['state.evicted_context'].status, 'unchanged');
    assert.equal(second.output.units['kb.meta'].status, 'unchanged');
    assert.equal(second.output.units['data.prompts'].status, 'unchanged');
    assert.equal(
      fs.readFileSync(path.join(target.home, 'memory', 'default', 'facts.jsonl'), 'utf8'),
      factsAfterFirst,
    );
    // 每次运行都写报告（证据可追溯），文件名不冲突
    const reportsAfter = listReports(target.home);
    assert.equal(reportsAfter.length, reportsBefore.length + 1);
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

test('idempotent: kinds 选择生效（archive 默认不动）', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const result = runMigration({
      input: fixture.input,
      home: target.home,
      apply: true,
      kinds: ['memory'],
    });
    assert.ok(fs.existsSync(path.join(target.home, 'memory', 'default', 'facts.jsonl')));
    assert.equal(fs.existsSync(path.join(target.home, 'providers.json')), false);
    assert.equal(fs.existsSync(path.join(target.home, 'prompts')), false);
    assert.equal(result.output.units['home.conversation'].status, 'skipped');
    assert.equal(result.output.units['home.conversation'].reason, 'not_selected');

    // 显式 archive 才复制会话归档
    const archived = runMigration({
      input: fixture.input,
      home: target.home,
      apply: true,
      kinds: ['archive'],
    });
    assert.equal(archived.output.units['home.conversation'].status, 'applied');
    assert.ok(fs.existsSync(path.join(target.home, 'sessions')));
    assert.ok(fs.existsSync(path.join(target.home, 'data', 'pictures')));
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

test('idempotent: 报告里没有明文凭据与正文', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const result = runMigration({ input: fixture.input, home: target.home });
    const reports = listReports(target.home);
    const raw = fs.readFileSync(path.join(target.home, '.migrate-reports', reports[0]), 'utf8');
    for (const marker of ['VWUZGCNYMTKGBFPXVAN', 'OPYTIKTJXBFCGQE', 'VYWRYYXBNIGWPGIGJF', 'TESTONLYCOOKIE']) {
      assert.equal(raw.includes(marker), false);
    }
    // 记忆正文与人格目录名也不出现在报告里
    assert.equal(raw.includes('单元测试事实'), false);
    assert.equal(raw.includes('legacyuser'), false);
    assert.equal(result.output.warnings.some((item) => item.includes('单元测试事实')), false);
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

function runRpc(lines, env = {}) {
  return new Promise((resolve, reject) => {
    const flags = process.execArgv.filter((arg) => arg === '--experimental-sqlite');
    const child = spawn(process.execPath, [...flags, 'index.js'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, messages: stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) });
    });
    for (const line of lines) child.stdin.write(`${line}\n`);
    child.stdin.end();
  });
}

test('jsonrpc: initialize / call / shutdown 与 EOF 自退', async () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const { code, messages } = await runRpc([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'call',
        params: { action: 'run', arguments: { input: fixture.input, home: target.home } },
      }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'shutdown' }),
    ]);
    assert.equal(code, 0);
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[0].result.actions, ['run']);
    assert.equal(messages[0].result.mode, 'oneshot');
    const payload = JSON.parse(messages[1].result.content);
    assert.equal(payload.ok, true);
    assert.equal(payload.output.applied, false);
    assert.equal(payload.output.exit_code, 0);
    assert.equal(messages[2].result.ok, true);
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

test('jsonrpc: 错误码分层（-32700 / -32601 / -32602 / -32000）', async () => {
  const { code, messages } = await runRpc([
    'not-json',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: { action: 'nope', arguments: {} } }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: { action: 'run', arguments: {} } }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'call',
      params: { action: 'run', arguments: { input: '/tmp/definitely-missing-gqy-export' } },
    }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'shutdown' }),
  ]);
  assert.equal(code, 0);
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages[1].error.code, -32601);
  assert.equal(messages[2].error.code, -32601);
  assert.equal(messages[3].error.code, -32602);
  assert.equal(messages[4].error.code, -32000);
  assert.match(messages[4].error.message, /input 目录不存在/);
});
