'use strict';
// 迁移器 run 动作的参数校验与默认值（manifest.actions[run].schema 的落地实现）。
// 只做纯校验/归一化，不碰文件系统；路径解析在这里完成，后续模块拿到的是绝对路径。

const os = require('node:os');
const path = require('node:path');

// unit 组（--kinds 的合法值，对应 blueprint/migrate.md §3 的「组」列）。
const KINDS = [
  'config',
  'personas',
  'memory',
  'kb',
  'prompts',
  'memes',
  'skills',
  'scripts',
  'identities',
  'usage',
  'archive',
];

// P2 archive 组默认不迁（MG7）：大媒体只报体积。
const DEFAULT_KINDS = KINDS.filter((k) => k !== 'archive');

// personas 的目录名/人格 id：^[a-z0-9][a-z0-9_-]{0,31}$（blueprint/memory.md §1）。
const PERSONA_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const KNOWN_KEYS = new Set([
  'input',
  'home',
  'apply',
  'kinds',
  'persona',
  'include_secrets',
  'no_backup',
  'report',
]);

/** 参数错误：JSON-RPC 层映射为 -32602。 */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'invalid_params';
  }
}

function expandTilde(value, env) {
  const home = env.HOME || os.homedir();
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function readBool(args, key, fallback) {
  const raw = args[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') throw new UsageError(`${key} 必须是布尔值`);
  return raw;
}

function readString(args, key) {
  const raw = args[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !raw.trim()) throw new UsageError(`${key} 必须是非空字符串`);
  return raw.trim();
}

/**
 * 解析 run 动作入参。
 * @param {unknown} raw JSON-RPC 的 arguments 对象
 * @param {{env?: NodeJS.ProcessEnv, cwd?: string}} [options]
 * @returns {{input:string, home:string, apply:boolean, kinds:string[], persona:string|null,
 *            includeSecrets:boolean, noBackup:boolean, report:string|null, unknown:string[]}}
 */
function parseArgs(raw, options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();

  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new UsageError('run 的 arguments 必须是 JSON 对象');
  }
  const args = raw || {};

  const inputRaw = readString(args, 'input');
  if (!inputRaw) throw new UsageError('缺少必填参数 input：旧版 GQY_HOME 导出目录');
  const input = path.resolve(cwd, expandTilde(inputRaw, env));

  // home：显式参数 > 环境变量 GQY_HOME > ~/.gqy
  let home;
  const homeRaw = readString(args, 'home');
  const envHome = typeof env.GQY_HOME === 'string' ? env.GQY_HOME.trim() : '';
  if (homeRaw) {
    home = path.resolve(cwd, expandTilde(homeRaw, env));
  } else if (envHome) {
    home = path.resolve(expandTilde(envHome, env));
  } else {
    home = path.join(env.HOME || os.homedir(), '.gqy');
  }

  const apply = readBool(args, 'apply', false);
  const includeSecrets = readBool(args, 'include_secrets', false);
  const noBackup = readBool(args, 'no_backup', false);

  // kinds：缺省 = 全部 P0/P1 组（不含 archive）；兼容把人格 id 当 kinds 项的旧写法。
  let kinds;
  const personaFromKind = [];
  if (args.kinds === undefined || args.kinds === null) {
    kinds = DEFAULT_KINDS.slice();
  } else {
    if (!Array.isArray(args.kinds)) throw new UsageError('kinds 必须是字符串数组');
    const picked = [];
    for (const item of args.kinds) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new UsageError('kinds 里每一项都必须是非空字符串');
      }
      const kind = item.trim();
      if (KINDS.includes(kind)) {
        if (!picked.includes(kind)) picked.push(kind);
        continue;
      }
      if (PERSONA_RE.test(kind)) {
        if (!personaFromKind.includes(kind)) personaFromKind.push(kind);
        continue;
      }
      throw new UsageError(
        `kinds 含未知单元组 ${JSON.stringify(kind)}；可选：${KINDS.join(', ')}（或某个人格 id）`,
      );
    }
    if (picked.length === 0 && personaFromKind.length === 0) {
      throw new UsageError('kinds 不能是空数组');
    }
    kinds = picked;
  }

  // persona：只迁某个人格库
  let persona = null;
  const personaRaw = readString(args, 'persona');
  if (personaRaw !== null) {
    if (!PERSONA_RE.test(personaRaw)) {
      throw new UsageError('persona 必须匹配 ^[a-z0-9][a-z0-9_-]{0,31}$');
    }
    persona = personaRaw;
  } else if (personaFromKind.length === 1) {
    persona = personaFromKind[0];
  } else if (personaFromKind.length > 1) {
    throw new UsageError('kinds 里出现多个人格 id，请改用 persona 参数只指定一个');
  }

  // report：默认 $GQY_HOME/.migrate-reports/<run>.json（由调用方补全）
  let reportPath = null;
  const reportRaw = readString(args, 'report');
  if (reportRaw) reportPath = path.resolve(cwd, expandTilde(reportRaw, env));

  const unknown = Object.keys(args).filter((key) => !KNOWN_KEYS.has(key));

  return {
    input,
    home,
    apply,
    kinds,
    persona,
    includeSecrets,
    noBackup,
    report: reportPath,
    unknown,
  };
}

/** 某个 unit 组是否被本次选中。 */
function wants(options, group) {
  return options.kinds.includes(group);
}

module.exports = { KINDS, DEFAULT_KINDS, PERSONA_RE, UsageError, parseArgs, wants };
