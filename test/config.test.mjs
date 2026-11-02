// 配置迁移与脱敏（src/config.js）：运行期造最小旧配置，跑真实代码路径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = require('../src/args');
const legacy = require('../src/legacy');
const config = require('../src/config');
const report = require('../src/report');

const { buildLegacyExport, makeTargetHome, FAKE_PROVIDER_KEY, FAKE_QQ_TOKEN, FAKE_MINIMAX_KEY, FAKE_BEARER } =
  await import('./build-legacy.mjs');

function makeCtx(input, home, extra = {}) {
  const options = args.parseArgs({ input, home, ...extra });
  const layout = legacy.describeInput(options.input);
  return {
    options,
    layout,
    fingerprint: report.fingerprintFor(layout),
    runId: report.newRunId(options.home),
  };
}

function readConfigDoc(fixture) {
  const file = path.join(fixture.homeRoot, 'config', 'config.jsonc');
  return config.parseJsonc(fs.readFileSync(file, 'utf8'));
}

test('config: parseJsonc 支持注释、尾逗号与字符串里的 //', () => {
  const fixture = buildLegacyExport();
  try {
    const doc = readConfigDoc(fixture);
    assert.equal(doc.config_version, 3);
    // URL 里的 // 不能被当注释吃掉
    assert.equal(doc.providers[0].base_url, 'https://api.alpha.test/v1/');
    assert.equal(doc.providers.length, 5);
  } finally {
    fixture.cleanup();
  }
});

test('config: providers 过滤（缺 base_url / 缺模型 / 协议不支持）', () => {
  const fixture = buildLegacyExport();
  try {
    const doc = readConfigDoc(fixture);
    const built = config.buildProviders(doc, { includeSecrets: false });
    assert.deepEqual(
      built.providers.map((provider) => provider.id),
      ['alpha', 'beta'],
    );
    assert.equal(built.providers[0].base_url, 'https://api.alpha.test/v1');
    assert.equal(built.providers[0].protocol, 'openai-chat');
    assert.equal(built.providers[1].protocol, 'anthropic-messages');
    assert.equal(built.dropped.no_base_url, 1);
    assert.equal(built.dropped.bad_protocol, 1);
    assert.equal(built.dropped.no_models, 1);
    // 账号默认只写 env 引用，不写明文
    for (const provider of built.providers) {
      for (const account of provider.accounts) {
        assert.equal(account.api_key, undefined);
        assert.match(account.api_key_env, /^GQY_PROVIDER_[A-Z0-9_]+_API_KEY$/);
      }
    }
    assert.equal(built.providers[0].accounts[0].api_key_env, 'GQY_PROVIDER_ALPHA_API_KEY');
  } finally {
    fixture.cleanup();
  }
});

test('config: include_secrets 才写明文', () => {
  const fixture = buildLegacyExport();
  try {
    const doc = readConfigDoc(fixture);
    const built = config.buildProviders(doc, { includeSecrets: true });
    assert.equal(built.providers[0].accounts[0].api_key, FAKE_PROVIDER_KEY);
    assert.equal(built.providers[0].accounts[0].api_key_env, undefined);
  } finally {
    fixture.cleanup();
  }
});

test('config: routing 取第一个可用模型、每档一个 order group', () => {
  const fixture = buildLegacyExport();
  try {
    const doc = readConfigDoc(fixture);
    const built = config.buildProviders(doc, { includeSecrets: false });
    const routing = config.buildRouting(doc, built.providers);
    assert.deepEqual(routing.default, { provider: 'alpha', model: 'alpha-model-1' });
    assert.equal(routing.groups.length, 1);
    assert.equal(routing.groups[0].id, 'standard');
    assert.equal(routing.groups[0].strategy, 'order');
    assert.deepEqual(routing.groups[0].members, ['alpha/alpha-model-1']);
    assert.equal(routing.max_attempts, 3);
  } finally {
    fixture.cleanup();
  }
});

test('config: settings 脱敏（凭据一律 env 引用，明文不落盘）', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const ctx = makeCtx(fixture.input, target.home, { apply: true });
    const planned = config.plan(ctx);
    const unit = planned.units['config.main'];
    assert.equal(unit.status, 'planned');
    assert.equal(unit.records.providers, 2);
    assert.equal(unit.records.dropped_providers, 3);
    // alpha key / qq access_token / connectors.imessage token / minimax key / mcp cookie /
    // bearer 形状值 / api_quota 账号 key / imessage.json token
    assert.equal(unit.redacted, 8);

    const applied = config.apply(ctx, planned);
    assert.equal(applied.units['config.main'].status, 'applied');

    const providersText = fs.readFileSync(path.join(target.home, 'providers.json'), 'utf8');
    const settingsText = fs.readFileSync(path.join(target.home, 'settings.json'), 'utf8');
    const routingText = fs.readFileSync(path.join(target.home, 'routing.json'), 'utf8');
    for (const secret of [FAKE_PROVIDER_KEY, FAKE_QQ_TOKEN, FAKE_MINIMAX_KEY, FAKE_BEARER, 'TESTONLYCOOKIE']) {
      assert.equal(providersText.includes(secret), false);
      assert.equal(settingsText.includes(secret), false);
      assert.equal(routingText.includes(secret), false);
    }
    assert.match(providersText, /api_key_env/);

    const settings = report.readJsonSafe(path.join(target.home, 'settings.json'), null);
    assert.equal(settings.system_prompt_file, 'prompts/system-prompt.md');
    assert.equal(settings.tool_timeout_s, 45);
    // context 只迁数值型
    assert.equal(settings.context.default_context_window, 128000);
    assert.equal(settings.context.on_overflow, undefined);
    // 平台 token 与 mcp 里的 cookie 都转成 env 引用
    assert.match(settings.platforms.qq.access_token, /^env:GQY_MIGRATED_/);
    assert.match(settings.platforms.connectors.imessage.token, /^env:GQY_MIGRATED_/);
    assert.match(settings.platforms.imessage.token, /^env:GQY_MIGRATED_/);
    assert.match(settings.mcp.servers[0].env.NETEASE_COOKIE, /^env:GQY_MIGRATED_/);
    assert.equal(settings.mcp.servers[0].env.PLAIN_VAR, 'ok');
    assert.match(settings.voice.tts.minimax.api_key, /^env:GQY_MIGRATED_/);
    // 留档里也不能有明文
    assert.equal(JSON.stringify(settings.migrated).includes(FAKE_PROVIDER_KEY), false);
    assert.equal(JSON.stringify(settings.migrated).includes(FAKE_BEARER), false);
    assert.equal(settings.migrated.secrets_included, false);

    // home marker 同步写成 gqy-1，旧值留在 memory/meta.json（此处 memory 组没跑，只校验文件本身）
    assert.equal(fs.readFileSync(path.join(target.home, '.home-layout-v1'), 'utf8').trim(), 'gqy-1');
    assert.equal(planned.units['layout.home_marker'].home_layout.from, 'legacyhost');
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

test('config: 二次 apply 不重复改写（幂等）', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const first = makeCtx(fixture.input, target.home, { apply: true });
    config.apply(first, config.plan(first));
    const before = fs.readFileSync(path.join(target.home, 'settings.json'), 'utf8');

    const second = makeCtx(fixture.input, target.home, { apply: true });
    const applied = config.apply(second, config.plan(second));
    assert.equal(applied.units['config.main'].status, 'unchanged');
    assert.equal(applied.units['config.main'].files_written, 0);
    assert.equal(fs.readFileSync(path.join(target.home, 'settings.json'), 'utf8'), before);
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

test('config: 报告不含明文凭据', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const ctx = makeCtx(fixture.input, target.home);
    const planned = config.plan(ctx);
    const body = JSON.stringify({ units: planned.units, warnings: planned.warnings });
    for (const secret of [FAKE_PROVIDER_KEY, FAKE_QQ_TOKEN, FAKE_MINIMAX_KEY, FAKE_BEARER]) {
      assert.equal(body.includes(secret), false);
    }
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});
