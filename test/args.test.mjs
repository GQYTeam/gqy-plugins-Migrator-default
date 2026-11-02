// 参数校验与默认值（src/args.js）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArgs, UsageError, KINDS, DEFAULT_KINDS } = require('../src/args');

const BASE = { input: '/tmp/legacy-export' };
const ENV = { HOME: '/home/tester', GQY_HOME: '' };

test('args: input 必填且必须是字符串', () => {
  assert.throws(() => parseArgs({}, { env: ENV, cwd: '/' }), UsageError);
  assert.throws(() => parseArgs({ input: '' }, { env: ENV, cwd: '/' }), UsageError);
  assert.throws(() => parseArgs({ input: 42 }, { env: ENV, cwd: '/' }), UsageError);
  assert.throws(() => parseArgs([], { env: ENV, cwd: '/' }), UsageError);
  assert.throws(() => parseArgs('nope', { env: ENV, cwd: '/' }), UsageError);
});

test('args: 缺省 dry-run、全组（不含 archive）', () => {
  const options = parseArgs(BASE, { env: ENV, cwd: '/' });
  assert.equal(options.apply, false);
  assert.equal(options.includeSecrets, false);
  assert.equal(options.noBackup, false);
  assert.deepEqual(options.kinds, DEFAULT_KINDS);
  assert.equal(options.kinds.includes('archive'), false);
  assert.equal(KINDS.includes('archive'), true);
  assert.equal(options.persona, null);
  assert.equal(options.report, null);
});

test('args: home 取值顺序（参数 > GQY_HOME > ~/.gqy）', () => {
  const fromEnv = parseArgs(BASE, { env: { ...ENV, GQY_HOME: '/tmp/env-home' }, cwd: '/' });
  assert.equal(fromEnv.home, '/tmp/env-home');
  const fromArg = parseArgs({ ...BASE, home: '/tmp/arg-home' }, { env: { ...ENV, GQY_HOME: '/tmp/env-home' }, cwd: '/' });
  assert.equal(fromArg.home, '/tmp/arg-home');
  const fallback = parseArgs(BASE, { env: { HOME: '/home/tester' }, cwd: '/' });
  assert.equal(fallback.home, '/home/tester/.gqy');
  const tilde = parseArgs({ ...BASE, home: '~/gqy' }, { env: { HOME: '/home/tester' }, cwd: '/' });
  assert.equal(tilde.home, '/home/tester/gqy');
});

test('args: 相对路径按 cwd 解析', () => {
  const options = parseArgs({ input: 'backup', report: 'out/report.json' }, { env: ENV, cwd: '/work' });
  assert.equal(options.input, '/work/backup');
  assert.equal(options.report, '/work/out/report.json');
});

test('args: 布尔参数严格校验', () => {
  assert.throws(() => parseArgs({ ...BASE, apply: 'true' }, { env: ENV }), UsageError);
  assert.throws(() => parseArgs({ ...BASE, include_secrets: 1 }, { env: ENV }), UsageError);
  assert.throws(() => parseArgs({ ...BASE, no_backup: 'no' }, { env: ENV }), UsageError);
  const options = parseArgs({ ...BASE, apply: true, include_secrets: true, no_backup: true }, { env: ENV, cwd: '/' });
  assert.equal(options.apply, true);
  assert.equal(options.includeSecrets, true);
  assert.equal(options.noBackup, true);
});

test('args: kinds 校验与去重', () => {
  const options = parseArgs({ ...BASE, kinds: ['config', 'memory', 'config'] }, { env: ENV, cwd: '/' });
  assert.deepEqual(options.kinds, ['config', 'memory']);
  assert.throws(() => parseArgs({ ...BASE, kinds: 'memory' }, { env: ENV }), UsageError);
  assert.throws(() => parseArgs({ ...BASE, kinds: [] }, { env: ENV }), UsageError);
  // 合法人格 id 形状的会当 persona 过滤，不是未知组
  assert.equal(parseArgs({ ...BASE, kinds: ['nope'] }, { env: ENV, cwd: '/' }).persona, 'nope');
  assert.throws(() => parseArgs({ ...BASE, kinds: ['NoSuchKind'] }, { env: ENV }), UsageError);
  assert.throws(() => parseArgs({ ...BASE, kinds: ['archive', 7] }, { env: ENV }), UsageError);
});

test('args: 人格 id 可以当 kinds 项（兼容旧写法），等价于 persona 过滤', () => {
  const options = parseArgs({ ...BASE, kinds: ['persona-a', 'memory'] }, { env: ENV, cwd: '/' });
  assert.deepEqual(options.kinds, ['memory']);
  assert.equal(options.persona, 'persona-a');
  assert.throws(
    () => parseArgs({ ...BASE, kinds: ['persona-a', 'persona-b'] }, { env: ENV }),
    UsageError,
  );
});

test('args: persona 格式校验', () => {
  assert.equal(parseArgs({ ...BASE, persona: 'default' }, { env: ENV, cwd: '/' }).persona, 'default');
  assert.throws(() => parseArgs({ ...BASE, persona: '../etc' }, { env: ENV }), UsageError);
  assert.throws(() => parseArgs({ ...BASE, persona: 'A' }, { env: ENV }), UsageError);
  assert.throws(() => parseArgs({ ...BASE, persona: '' }, { env: ENV }), UsageError);
});

test('args: 未知参数不报错、只回告', () => {
  const options = parseArgs({ ...BASE, extra: 1 }, { env: ENV, cwd: '/' });
  assert.deepEqual(options.unknown, ['extra']);
});
