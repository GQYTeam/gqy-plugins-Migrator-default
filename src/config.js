'use strict';
// 配置迁移：config/config.jsonc → providers.json + routing.json + settings.json（MG4 默认脱敏）。
//
// 目标形状见 blueprint/gateway.md（providers/routing 字段表）与 blueprint/config.md（settings 字段表）。
// 旧配置里的凭据一律不落明文：默认改写成 env 引用（`api_key_env` / `env:<NAME>`），
// `include_secrets=true` 才写明文，但目标文件仍是 0600，且报告里永远不出现明文。

const path = require('node:path');

const legacy = require('./legacy');
const report = require('./report');

// 旧协议名 → 新协议白名单（existing config.validProtocol）。
const PROTOCOL_MAP = {
  'openai-chat': 'openai-chat',
  openai: 'openai-chat',
  anthropic: 'anthropic-messages',
  'anthropic-messages': 'anthropic-messages',
  gemini: 'gemini',
  google: 'gemini',
};

const VALID_PROTOCOLS = new Set(['openai-chat', 'anthropic-messages', 'gemini']);

// 敏感键判定：按「整键名 + 后缀」精确匹配，避免 `show_token_usage` / `*_tokens`（计数字段）误伤。
const SECRET_KEY_SUFFIX_RE = /(_api_key|_apikey|_access_token|_auth_token|_bot_token|_refresh_token|_cookie|_cookies|_sessdata|_secret|_client_secret|_password|_passwd|_private_key|_authorization)$/i;
const SECRET_KEYS = new Set([
  'token',
  'tokens',
  'cookie',
  'cookies',
  'sessdata',
  'secret',
  'password',
  'passwd',
  'authorization',
  'api_key',
  'apikey',
  'api_keys',
  'access_token',
  'auth_token',
  'refresh_token',
  'bot_token',
  'session_token',
  'id_token',
  'amap_key',
  'private_key',
  'client_secret',
]);

function isSecretKey(key) {
  const name = String(key).toLowerCase();
  if (SECRET_KEYS.has(name)) return true;
  if (/^api_?keys?$/.test(name)) return true;
  return SECRET_KEY_SUFFIX_RE.test(name);
}

// 值形状像密钥的，即使键名不敏感也脱敏（防漏网）。
const SECRET_VALUE_PATTERNS = [
  /^sk[-][A-Za-z0-9_-]{12,}$/,
  /^Bearer\s+\S{8,}$/i,
  /^gh[pousr]_[A-Za-z0-9_]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^hf_[A-Za-z0-9]{20,}$/,
  /^AIza[0-9A-Za-z_-]{20,}$/,
];

function text(value) {
  return typeof value === 'string' ? value : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析 JSONC：去掉 `//`、`/* *\/` 注释与尾逗号（字符串内部不动）。
 * 旧版 config.jsonc 是「带注释的 JSON」，不是 TOML，也不是宽松 JSON。
 */
function parseJsonc(source) {
  const input = String(source || '');
  let stripped = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') {
      stripped += ch;
      i += 1;
      while (i < input.length) {
        const cur = input[i];
        stripped += cur;
        i += 1;
        if (cur === '\\') {
          if (i < input.length) {
            stripped += input[i];
            i += 1;
          }
          continue;
        }
        if (cur === '"') break;
      }
      continue;
    }
    if (ch === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    stripped += ch;
    i += 1;
  }

  // 去尾逗号（同样的字符串感知扫描）。
  let out = '';
  i = 0;
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < stripped.length) {
        const cur = stripped[i];
        out += cur;
        i += 1;
        if (cur === '\\') {
          if (i < stripped.length) {
            out += stripped[i];
            i += 1;
          }
          continue;
        }
        if (cur === '"') break;
      }
      continue;
    }
    if (ch === ',') {
      let look = i + 1;
      while (look < stripped.length && /\s/.test(stripped[look])) look += 1;
      if (stripped[look] === '}' || stripped[look] === ']') {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out);
}

/** 从 JSON 路径推导一个可读的 env 名（脱敏后用）。 */
function envNameFromPath(jsonPath) {
  const cleaned = jsonPath
    .replace(/\[(\d+)\]/g, (_, index) => `_${index}`)
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return `GQY_MIGRATED_${cleaned || 'SECRET'}`;
}

function looksLikeSecret(value) {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 深拷贝并脱敏：敏感键 / 形似密钥的字符串 → env 引用；空值保持空。
 * @returns {{value: any, redacted: number}}
 */
function redact(value, jsonPath = '', counter = { redacted: 0 }) {
  if (Array.isArray(value)) {
    const out = [];
    for (let index = 0; index < value.length; index += 1) {
      out.push(redact(value[index], `${jsonPath}[${index}]`, counter));
    }
    return out;
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const childPath = jsonPath ? `${jsonPath}.${key}` : key;
      if (isSecretKey(key)) {
        if (typeof item === 'string') {
          if (item.trim()) counter.redacted += 1;
          out[key] = item.trim() ? `env:${envNameFromPath(childPath)}` : '';
        } else if (Array.isArray(item)) {
          out[key] = item.map((entry, index) => {
            if (typeof entry === 'string' && entry.trim()) {
              counter.redacted += 1;
              return `env:${envNameFromPath(`${childPath}[${index}]`)}`;
            }
            if (isPlainObject(entry)) return redact(entry, `${childPath}[${index}]`, counter);
            return entry;
          });
        } else if (isPlainObject(item)) {
          out[key] = redact(item, childPath, counter);
        } else {
          out[key] = item;
        }
        continue;
      }
      out[key] = redact(item, childPath, counter);
    }
    return out;
  }
  if (typeof value === 'string' && value.trim() && looksLikeSecret(value.trim())) {
    counter.redacted += 1;
    return `env:${envNameFromPath(jsonPath)}`;
  }
  return value;
}

function providerEnvName(providerId, accountIndex, accountCount) {
  const base = String(providerId)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (accountCount > 1) return `GQY_PROVIDER_${base}_ACCOUNT_${accountIndex + 1}_API_KEY`;
  return `GQY_PROVIDER_${base}_API_KEY`;
}

/**
 * 旧 providers[] → 新版 providers.json（只保留新网关能跑的；跑不了的显式降级并计数）。
 * @returns {{providers: Array, dropped: object, redacted: number}}
 */
function buildProviders(doc, options) {
  const dropped = { no_id: 0, no_base_url: 0, bad_protocol: 0, no_models: 0 };
  const providers = [];
  const legacyProviders = Array.isArray(doc.providers) ? doc.providers : [];
  const quota = isPlainObject(doc.plugins && doc.plugins.api_quota) ? doc.plugins.api_quota : {};

  for (const raw of legacyProviders) {
    if (!isPlainObject(raw)) continue;
    const id = text(raw.id).trim();
    if (!id) {
      dropped.no_id += 1;
      continue;
    }
    const baseUrl = text(raw.base_url).trim().replace(/\/+$/, '');
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      dropped.no_base_url += 1;
      continue;
    }
    const protocol = PROTOCOL_MAP[text(raw.protocol).trim().toLowerCase() || 'openai-chat'];
    if (!protocol || !VALID_PROTOCOLS.has(protocol)) {
      dropped.bad_protocol += 1;
      continue;
    }
    const models = Array.isArray(raw.models)
      ? raw.models.map((item) => text(item).trim()).filter(Boolean)
      : [];
    const defaultModel = text(raw.default_model).trim() || models[0] || '';
    if (!defaultModel) {
      dropped.no_models += 1;
      continue;
    }
    const normalizedModels = models.includes(defaultModel) ? models : [defaultModel, ...models];

    // 账号：优先用 api_quota 里按 provider 归并的账号，其次单账号占位。
    const quotaAccounts = isPlainObject(quota[id]) && Array.isArray(quota[id].accounts) ? quota[id].accounts : [];
    const accounts = [];
    if (quotaAccounts.length > 0) {
      quotaAccounts.forEach((account, index) => {
        const accountId = text(account && account.id).trim() || `account-${index + 1}`;
        const plain = text(account && account.api_key);
        const entry = { id: accountId };
        const name = text(account && account.name).trim();
        if (name) entry.name = name;
        if (options.includeSecrets && plain.trim()) entry.api_key = plain;
        else entry.api_key_env = providerEnvName(id, index, quotaAccounts.length);
        accounts.push(entry);
      });
    } else {
      const plain = text(raw.api_key);
      const entry = { id: 'default' };
      if (options.includeSecrets && plain.trim()) entry.api_key = plain;
      else entry.api_key_env = providerEnvName(id, 0, 1);
      accounts.push(entry);
    }

    const provider = {
      id,
      display_name: text(raw.display_name).trim() || id,
      base_url: baseUrl,
      protocol,
      default_model: defaultModel,
      models: normalizedModels,
      accounts,
    };
    const maxConcurrency = Number(raw.max_concurrency);
    if (Number.isFinite(maxConcurrency) && maxConcurrency >= 1) {
      provider.max_concurrency = Math.min(100, Math.trunc(maxConcurrency));
    }
    providers.push(provider);
  }

  return { providers, dropped };
}

function sanitizeGroupId(value, fallback) {
  const cleaned = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (/^[a-z0-9][a-z0-9_-]*$/.test(cleaned)) return cleaned;
  return fallback;
}

/** active_provider_models / model_tiers → routing.json（default + groups）。 */
function buildRouting(doc, providers) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  let def = null;

  const candidates = Array.isArray(doc.active_provider_models) ? doc.active_provider_models : [];
  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) continue;
    const providerId = text(candidate.provider_id).trim();
    const model = text(candidate.model).trim();
    if (byId.has(providerId) && model) {
      def = { provider: providerId, model };
      break;
    }
  }
  if (!def) {
    const active = text(doc.active_provider).trim();
    if (byId.has(active)) {
      const provider = byId.get(active);
      def = { provider: active };
      if (provider.default_model) def.model = provider.default_model;
    }
  }
  if (!def && providers.length > 0) {
    def = { provider: providers[0].id };
    if (providers[0].default_model) def.model = providers[0].default_model;
  }

  const groups = [];
  const tiers = isPlainObject(doc.model_tiers) ? doc.model_tiers : {};
  let fallbackIndex = 0;
  for (const [tier, members] of Object.entries(tiers)) {
    if (tier === 'roles' || !Array.isArray(members)) continue;
    const refs = [];
    for (const member of members) {
      if (!isPlainObject(member)) continue;
      const providerId = text(member.provider_id).trim();
      const model = text(member.model).trim();
      if (!byId.has(providerId) || !model) continue;
      const ref = `${providerId}/${model}`;
      if (!refs.includes(ref)) refs.push(ref);
    }
    if (refs.length === 0) continue;
    fallbackIndex += 1;
    groups.push({
      id: sanitizeGroupId(tier, `tier-${fallbackIndex}`),
      name: tier,
      strategy: 'order',
      members: refs,
    });
  }

  return {
    default: def,
    groups,
    max_attempts: 3,
    cooldown_seconds: 30,
    queue_timeout_ms: 1500,
  };
}

/** 数值字段挑出来（blueprint §3.2：context 只迁数值型）。 */
function pickNumeric(source) {
  const out = {};
  if (!isPlainObject(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * config.jsonc → settings.json 里的可运行字段 + migrated.legacy 留档。
 * @returns {{settings: object, redacted: number}}
 */
function buildSettings(doc, imessage, options) {
  const counter = { redacted: 0 };
  // 整份 config 脱敏一次；settings 里的字段直接复用脱敏后的副本，避免重复计数。
  const archived = redact(doc, '', counter);
  const settings = {};

  const promptFile = text(doc.system_prompt_file).trim();
  if (promptFile) settings.system_prompt_file = 'prompts/system-prompt.md';

  const context = pickNumeric(doc.context);
  if (Object.keys(context).length > 0) settings.context = context;

  if (isPlainObject(archived.tools)) {
    settings.tools = archived.tools;
    const toolTimeout = Number(archived.tools.default_timeout_secs);
    if (Number.isFinite(toolTimeout) && toolTimeout > 0) {
      settings.tool_timeout_s = Math.min(3600, Math.max(1, Math.trunc(toolTimeout)));
    }
  }
  if (isPlainObject(archived.voice)) settings.voice = archived.voice;
  if (isPlainObject(archived.mcp)) settings.mcp = archived.mcp;

  const platforms = isPlainObject(archived.platforms) ? { ...archived.platforms } : {};
  const archivedImessage = imessage === null ? null : redact(imessage, 'imessage', counter);
  if (archivedImessage !== null) platforms.imessage = archivedImessage;
  if (Object.keys(platforms).length > 0) settings.platforms = platforms;

  settings.migrated = {
    legacy: {
      ...archived,
      imessage: archivedImessage,
    },
    source: 'gqy-home-v0.7',
    config_version: Number(doc.config_version) || 0,
    secrets_included: options.includeSecrets === true,
  };
  return { settings, redacted: counter.redacted };
}

function mergeJson(existing, incoming) {
  if (!isPlainObject(existing)) return incoming;
  const out = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeJson(out[key], value);
    else out[key] = value;
  }
  return out;
}

function writeIfChanged(ctx, target, value) {
  const current = report.readJsonSafe(target, null);
  if (current && JSON.stringify(current) === JSON.stringify(value)) return false;
  if (ctx.backup) report.backupFile(ctx.options.home, ctx.runId, target);
  report.writeJsonPrivate(target, value);
  return true;
}

/**
 * 规划配置相关 unit（config.main / config.imessage / layout.home_marker）。
 * @returns {{units: object, warnings: string[], skipped: Array, state: object}}
 */
function plan(ctx) {
  const units = {};
  const warnings = [];
  const skipped = [];
  const state = { marker: null, providers: null, routing: null, settings: null, redacted: 0 };

  // 组没被选中：只报存在性与体积，不解析、不写目标（--kinds 语义）。
  if (!ctx.options.kinds.includes('config')) {
    const markerFile = path.join(ctx.layout.homeRoot, '.home-layout-v1');
    const configFile = path.join(ctx.layout.homeRoot, 'config', 'config.jsonc');
    const imessageFile = path.join(ctx.layout.homeRoot, 'config', 'imessage.json');
    const skippedUnit = (file) => ({
      group: 'config',
      status: 'skipped',
      reason: 'not_selected',
      files: legacy.isFile(file) ? 1 : 0,
      bytes: legacy.statSafe(file)?.size || 0,
      records: {},
    });
    units['layout.home_marker'] = skippedUnit(markerFile);
    units['config.main'] = skippedUnit(configFile);
    units['config.imessage'] = skippedUnit(imessageFile);
    for (const name of Object.keys(units)) skipped.push({ unit: name, reason: 'not_selected' });
    return { units, warnings, skipped, state };
  }

  // 1) layout.home_marker：旧值只能进 meta，新版写 gqy-1
  const markerFile = path.join(ctx.layout.homeRoot, '.home-layout-v1');
  if (legacy.isFile(markerFile)) {
    const value = (legacy.readFileText(markerFile) || '').trim();
    state.marker = value;
    units['layout.home_marker'] = {
      group: 'config',
      status: 'planned',
      files: 1,
      bytes: value.length,
      records: {},
      home_layout: { from: value, to: 'gqy-1' },
    };
  } else {
    units['layout.home_marker'] = { group: 'config', status: 'skipped', files: 0, bytes: 0, records: {} };
    skipped.push({ unit: 'layout.home_marker', reason: 'marker_missing' });
  }

  // 2) config.main
  const configFile = path.join(ctx.layout.homeRoot, 'config', 'config.jsonc');
  const configText = legacy.readFileText(configFile);
  const imessageFile = path.join(ctx.layout.homeRoot, 'config', 'imessage.json');
  const imessageDoc = legacy.isFile(imessageFile) ? legacy.readJson(imessageFile) : null;

  let doc = null;
  if (configText === null) {
    units['config.main'] = { group: 'config', status: 'skipped', files: 0, bytes: 0, records: {} };
    skipped.push({ unit: 'config.main', reason: 'config_missing' });
  } else {
    try {
      doc = parseJsonc(configText);
    } catch {
      units['config.main'] = {
        group: 'config',
        status: 'failed',
        files: 1,
        bytes: configText.length,
        records: {},
        error: 'config.jsonc 解析失败',
      };
      warnings.push('config.main: config.jsonc 解析失败，未迁 providers/routing/settings');
    }
  }

  if (doc) {
    const built = buildProviders(doc, ctx.options);
    const routing = buildRouting(doc, built.providers);
    const builtSettings = buildSettings(doc, imessageDoc, ctx.options);
    state.providers = { providers: built.providers };
    state.routing = routing;
    state.settings = builtSettings.settings;
    state.redacted = builtSettings.redacted;

    const droppedTotal =
      built.dropped.no_id + built.dropped.no_base_url + built.dropped.bad_protocol + built.dropped.no_models;
    if (droppedTotal > 0) {
      warnings.push(
        `config.main: ${droppedTotal} 个旧 provider 新版网关不支持（缺 base_url / 协议不在白名单 / 无模型），已跳过；` +
          '明细留在 settings.json.migrated.legacy 里可查',
      );
    }
    if (built.providers.length === 0) {
      warnings.push('config.main: 没有可迁移的 provider，providers.json 会是空列表（可用环境变量 provider 兜底）');
    }
    if (state.redacted > 0) {
      warnings.push(`config.main: 已脱敏 ${state.redacted} 项凭据（默认转 env 引用，--include-secrets 才迁明文）`);
    }
    units['config.main'] = {
      group: 'config',
      status: 'planned',
      files: 1,
      bytes: configText.length,
      records: {
        providers: built.providers.length,
        groups: routing.groups.length,
        dropped_providers: droppedTotal,
      },
      redacted: state.redacted,
    };
  }

  // 3) config.imessage（P2）：合并进 settings.json 的 platforms.imessage
  if (imessageDoc === null) {
    units['config.imessage'] = { group: 'config', status: 'skipped', files: 0, bytes: 0, records: {} };
    if (legacy.statSafe(imessageFile)) {
      units['config.imessage'].status = 'failed';
      units['config.imessage'].error = 'imessage.json 解析失败';
      warnings.push('config.imessage: imessage.json 解析失败，未合并');
    }
  } else {
    units['config.imessage'] = {
      group: 'config',
      status: 'planned',
      files: 1,
      bytes: legacy.statSafe(imessageFile)?.size || 0,
      records: {},
    };
  }

  return { units, warnings, skipped, state };
}

/**
 * 执行写入：providers.json + routing.json + settings.json + .home-layout-v1。
 * settings.json 与已有内容做深合并（保留用户在旧版迁移后新加的设置）。
 */
function apply(ctx, planResult) {
  const home = ctx.options.home;
  const result = { units: {}, files_written: 0 };

  if (planResult.state.marker !== null) {
    const target = path.join(home, '.home-layout-v1');
    const current = legacy.readFileText(target);
    if (current === null || current.trim() !== 'gqy-1') {
      if (ctx.backup) report.backupFile(ctx.options.home, ctx.runId, target);
      report.writeFilePrivate(target, 'gqy-1\n');
      result.files_written += 1;
      result.units['layout.home_marker'] = { status: 'applied', files_written: 1 };
    } else {
      result.units['layout.home_marker'] = { status: 'unchanged', files_written: 0 };
    }
  }

  if (planResult.state.providers && planResult.state.routing && planResult.state.settings) {
    const providersTarget = path.join(home, 'providers.json');
    const routingTarget = path.join(home, 'routing.json');
    const settingsTarget = path.join(home, 'settings.json');

    let written = 0;
    if (writeIfChanged(ctx, providersTarget, planResult.state.providers)) written += 1;
    if (writeIfChanged(ctx, routingTarget, planResult.state.routing)) written += 1;
    const existingSettings = report.readJsonSafe(settingsTarget, null);
    const mergedSettings = mergeJson(existingSettings, planResult.state.settings);
    const settingsWritten = writeIfChanged(ctx, settingsTarget, mergedSettings);
    if (settingsWritten) written += 1;

    result.files_written += written;
    result.units['config.main'] = {
      status: written > 0 ? 'applied' : 'unchanged',
      files_written: written,
      redacted: planResult.state.redacted,
    };
  }
  if (planResult.state.settings && planResult.units['config.imessage']) {
    result.units['config.imessage'] = {
      status: result.units['config.main'] && result.units['config.main'].status === 'applied' ? 'applied' : 'unchanged',
      files_written: 0,
    };
  }
  return result;
}

module.exports = {
  PROTOCOL_MAP,
  parseJsonc,
  redact,
  envNameFromPath,
  buildProviders,
  buildRouting,
  buildSettings,
  plan,
  apply,
  mergeJson,
};
