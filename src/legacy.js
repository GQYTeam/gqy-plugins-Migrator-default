'use strict';
// 旧版 GQY_HOME 导出（v0.7.0）的只读访问层。
//
// 铁律（MG1）：
// - 旧库一律只读打开：`new DatabaseSync(file, { readOnly: true })` + `PRAGMA query_only=1` 双保险；
//   拿不到只读能力就整体失败，绝不降级成可写。
// - 备份目录只读遍历：遍历只做 lstat/readdir/readFile，绝不写源目录。
// - 符号链接一律跳过（源侧），因为它们会绕过「不写源」的边界。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** 旧库/导出目录读取失败。 */
class LegacyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LegacyError';
    this.code = 'legacy';
  }
}

// 导出根下这些目录不是「账号目录」：它们是新版布局与旧版产品目录。
const RESERVED_TOP = new Set([
  'config',
  'data',
  'extensions',
  'state',
  'home',
  'themes',
  'tmp',
  'memory',
  'kb',
  'prompts',
  'memes',
  'skills',
  'scripts',
  'identities',
  'plugins',
  'plugin-settings',
  'sessions',
  'gateway',
  'evals',
]);

// 遍历时直接跳过的目录与文件（系统垃圾，不迁也不报错太多）。
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', '.localized']);

let sqliteModule = null;
let sqliteLoadError = null;

/** 载入 node:sqlite；不可用时给可操作错误（Node ≥ 22.5，22.x 需 --experimental-sqlite）。 */
function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  if (sqliteLoadError) throw new LegacyError(sqliteLoadError);
  try {
    // eslint-disable-next-line global-require
    sqliteModule = require('node:sqlite');
  } catch (err) {
    sqliteLoadError =
      `读旧版 SQLite 库需要 node:sqlite（Node ≥ 22.5；Node 22.x 需加 --experimental-sqlite）。` +
      `当前运行时 ${process.version} 不支持：${err && err.code ? err.code : err && err.message}`;
    throw new LegacyError(sqliteLoadError);
  }
  if (!sqliteModule || typeof sqliteModule.DatabaseSync !== 'function') {
    sqliteLoadError = 'node:sqlite 缺少 DatabaseSync，无法只读打开旧库';
    throw new LegacyError(sqliteLoadError);
  }
  return sqliteModule;
}

/** node:sqlite 是否可用（测试据此决定跳过 sqlite 相关用例）。 */
function sqliteAvailable() {
  try {
    loadSqlite();
    return true;
  } catch {
    return false;
  }
}

/**
 * 只读打开旧库。先 readOnly，再 PRAGMA query_only=1 并回读确认；任一不生效就关库抛错。
 * @param {string} file
 */
function openReadOnly(file) {
  const { DatabaseSync } = loadSqlite();
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    throw new LegacyError(`旧库只读打开失败（不会降级为可写）：${path.basename(file)}`);
  }
  try {
    db.exec('PRAGMA query_only = 1');
    const row = db.prepare('PRAGMA query_only').get();
    if (!row || Number(row.query_only) !== 1) throw new Error('query_only 未生效');
  } catch {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
    throw new LegacyError(`旧库只读保护未生效，已放弃读取：${path.basename(file)}`);
  }
  return db;
}

/** 表是否存在。 */
function tableExists(db, table) {
  if (!isSafeIdentifier(table)) return false;
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return Boolean(row);
}

function isSafeIdentifier(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]+$/.test(name);
}

/** 库里全部表名。 */
function allTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

/**
 * 解析一个逻辑表：优先用约定名；约定名不存在（或旧库改过名）时按必备列找。
 * 旧版 conversation.db 的表名各版本有出入，靠列形状定位更稳。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} preferred
 * @param {string[]} requiredColumns
 */
function resolveTable(db, preferred, requiredColumns = []) {
  if (tableExists(db, preferred)) {
    const columns = tableColumns(db, preferred);
    if (requiredColumns.every((name) => columns.includes(name))) return preferred;
  }
  for (const name of allTables(db)) {
    const columns = tableColumns(db, name);
    if (columns.length === 0) continue;
    if (requiredColumns.every((column) => columns.includes(column))) return name;
  }
  return null;
}

/** 表列名集合（旧库各版本列不一致，按实际列取）。 */
function tableColumns(db, table) {
  if (!isSafeIdentifier(table)) return [];
  if (!tableExists(db, table)) return [];
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((row) => String(row.name));
}

/**
 * 按「实际存在的列」SELECT 整表（缺列不会报错，读取侧按需给默认值）。
 * @returns {Array<Record<string, unknown>>}
 */
function readTable(db, table, wanted) {
  const columns = tableColumns(db, table);
  if (columns.length === 0) return [];
  const present = wanted.filter((name) => columns.includes(name));
  if (present.length === 0) return [];
  const sql = `SELECT ${present.map((name) => `"${name}"`).join(', ')} FROM "${table}"`;
  return db.prepare(sql).all();
}

/** 关库并吞掉 close 错误。 */
function closeQuietly(db) {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* 忽略 */
  }
}

/**
 * 台账：只读打开 → 回调 → 关闭。
 * @template T
 * @param {string} file
 * @param {(db: import('node:sqlite').DatabaseSync) => T} fn
 * @returns {T}
 */
function withReadOnly(file, fn) {
  const db = openReadOnly(file);
  try {
    return fn(db);
  } finally {
    closeQuietly(db);
  }
}

function statSafe(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function isFile(target) {
  const st = statSafe(target);
  return Boolean(st && st.isFile());
}

function isDir(target) {
  const st = statSafe(target);
  return Boolean(st && st.isDirectory());
}

function isSymlink(target) {
  const st = statSafe(target);
  return Boolean(st && st.isSymbolicLink());
}

/** 读目录下的子目录名（不跟随符号链接，排掉点目录）。 */
function listDirs(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/** 读目录下的文件名（不跟随符号链接）。 */
function listFiles(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * 只读遍历一棵树。
 * @param {string} root
 * @param {{maxFiles?: number}} [options]
 * @returns {{files: Array<{rel:string, abs:string, size:number, mtimeMs:number}>,
 *            symlinks: string[], skipped: Array<{rel:string, reason:string}>}}
 */
function walkTree(root, options = {}) {
  const maxFiles = options.maxFiles || 200000;
  const out = { files: [], symlinks: [], skipped: [] };
  if (!isDir(root)) return out;

  const stack = [{ abs: root, rel: '' }];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true });
    } catch {
      out.skipped.push({ rel: current.rel, reason: 'unreadable' });
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(current.abs, entry.name);
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        out.symlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          out.skipped.push({ rel, reason: 'dir_skipped' });
          continue;
        }
        stack.push({ abs, rel });
        continue;
      }
      if (!entry.isFile()) {
        out.skipped.push({ rel, reason: 'not_regular_file' });
        continue;
      }
      if (SKIP_FILES.has(entry.name)) {
        out.skipped.push({ rel, reason: 'junk' });
        continue;
      }
      // 复核一次：readdir 与 lstat 之间被换成符号链接也不跟。
      const st = fs.lstatSync(abs);
      if (!st.isFile()) {
        out.symlinks.push(rel);
        continue;
      }
      out.files.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
      if (out.files.length > maxFiles) {
        throw new LegacyError(`导出目录文件太多（超过 ${maxFiles}），请先确认 input 是否为旧版导出目录`);
      }
    }
  }
  out.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  out.symlinks.sort();
  return out;
}

/** 读文件（只读，失败返回 null）。 */
function readFileText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 读 JSON 文件（失败返回 null）。 */
function readJson(file) {
  const text = readFileText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 读导出清单 manifest.json；只保留结构与计数信息（不含正文）。
 * @param {string} file
 */
function readManifest(file) {
  const doc = readJson(file);
  if (!doc || typeof doc !== 'object') return null;
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const normalized = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const relPath = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!relPath) continue;
    normalized.push({
      unit: typeof entry.unit === 'string' ? entry.unit : '',
      path: relPath,
      size: Number.isFinite(Number(entry.size)) ? Number(entry.size) : 0,
      blake3: typeof entry.blake3 === 'string' ? entry.blake3.trim() : '',
    });
  }
  normalized.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    meta: {
      format_version: Number(doc.format_version) || 0,
      gqy_version: typeof doc.gqy_version === 'string' ? doc.gqy_version : '',
      exported_at: typeof doc.exported_at === 'string' ? doc.exported_at : '',
      config_version: Number(doc.config_version) || 0,
      secrets_included: doc.secrets_included === true,
      schema_versions: doc.schema_versions && typeof doc.schema_versions === 'object'
        ? Object.fromEntries(
            Object.entries(doc.schema_versions).filter(([, v]) => Number.isFinite(Number(v))),
          )
        : {},
    },
    entries: normalized,
  };
}

/** 旧库目录名 → 目标人格 id（不合法的字符压成 `-`，重名加序号）。 */
function uniquePersonaId(name, used) {
  let base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);
  if (!/^[a-z0-9]/.test(base)) base = `persona-${base || 'default'}`.slice(0, 32);
  base = base.replace(/-+$/, '') || 'default';
  let id = base;
  let counter = 2;
  while (used.has(id)) {
    const suffix = `-${counter}`;
    id = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    counter += 1;
  }
  used.add(id);
  return { id, changed: id !== String(name) };
}

/**
 * 发现导出里的账号目录/人格目录（`<user>/<persona>/`）与 evicted 库。
 * @param {string} homeRoot 旧版 GQY_HOME 根（导出里的 home/）
 */
function discoverPersonas(homeRoot) {
  const personas = [];
  const used = new Set();
  const extraEvicted = [];
  const extraEvictedDbs = [];

  for (const userName of listDirs(homeRoot)) {
    if (RESERVED_TOP.has(userName) || userName.startsWith('.')) continue;
    const userDir = path.join(homeRoot, userName);
    for (const personaName of listDirs(userDir)) {
      const dir = path.join(userDir, personaName);
      const memoryDb = path.join(dir, 'memory', 'memory.db');
      const personaToml = path.join(dir, 'persona.toml');
      const hasMemory = isFile(memoryDb);
      const hasToml = isFile(personaToml);
      if (!hasMemory && !hasToml) continue;
      const { id, changed } = uniquePersonaId(personaName, used);
      personas.push({
        id,
        legacyUser: userName,
        legacyName: personaName,
        dir,
        memoryDb: hasMemory ? memoryDb : null,
        personaToml: hasToml ? personaToml : null,
        evictedDb: null,
        idRenamed: changed,
      });
    }
  }

  // 被挤出上下文的原始轮次库：state/<user>/<persona>/memory/evicted_context.db
  const stateRoot = path.join(homeRoot, 'state');
  for (const userName of listDirs(stateRoot)) {
    const userState = path.join(stateRoot, userName);
    for (const personaName of listDirs(userState)) {
      const db = path.join(userState, personaName, 'memory', 'evicted_context.db');
      if (!isFile(db)) continue;
      const hit = personas.find((p) => p.legacyUser === userName && p.legacyName === personaName);
      if (hit) {
        hit.evictedDb = db;
      } else {
        extraEvictedDbs.push(db);
        extraEvicted.push({ legacyUser: userName, legacyName: personaName });
      }
    }
  }

  return { personas, extraEvicted, extraEvictedDbs };
}

/** 发现 `home/<host>/` 宿主目录（多个取第一个，其余只报计数）。 */
function discoverHosts(homeRoot) {
  const hostsRoot = path.join(homeRoot, 'home');
  const hosts = listDirs(hostsRoot).map((name) => ({ name, dir: path.join(hostsRoot, name) }));
  return hosts;
}

/** manifest 里声明了、磁盘上却没有的记忆库数（缺失即缺失，不造空库）。 */
function countMissingPersonaDbs(manifest, homeRoot) {
  if (!manifest || manifest.entries.length === 0) return 0;
  let missing = 0;
  for (const entry of manifest.entries) {
    if (entry.unit !== 'personas.memory') continue;
    if (!entry.path.endsWith('/memory/memory.db')) continue;
    if (!isFile(path.join(homeRoot, entry.path))) missing += 1;
  }
  return missing;
}

/**
 * 描述一个旧版导出目录。
 * @param {string} inputPath
 */
function describeInput(inputPath) {
  const st = statSafe(inputPath);
  if (!st || !st.isDirectory()) {
    throw new LegacyError(`input 目录不存在或不可读：${inputPath}`);
  }
  const nested = path.join(inputPath, 'home');
  const homeRoot = isDir(nested) ? nested : inputPath;
  const manifest = readManifest(path.join(inputPath, 'manifest.json'));
  const { personas, extraEvicted } = discoverPersonas(homeRoot);
  const hosts = discoverHosts(homeRoot);
  const missingPersonas = countMissingPersonaDbs(manifest, homeRoot);
  const homeMarker = readFileText(path.join(homeRoot, '.home-layout-v1'));
  return {
    inputPath,
    homeRoot,
    manifest,
    personas,
    extraEvicted,
    hosts,
    missingPersonas,
    homeMarker: homeMarker === null ? null : homeMarker.trim(),
  };
}

/**
 * 把旧版绝对路径（`/Users/<user>/.gqy/…`）重写成「旧版根之后的相对路径」。
 * 重写不了返回 null，由调用方保留 legacy_path。
 * @param {string} absPath
 */
const LEGACY_ROOTS = new Set(['config', 'data', 'extensions', 'state', 'home', 'personas']);

function legacyRelative(absPath) {
  const normalized = String(absPath || '').replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (LEGACY_ROOTS.has(parts[i])) return parts.slice(i).join('/');
  }
  return null;
}

const RELATIVE_REWRITES = [
  [/^data\/kb\/files\/(.+)$/, (m) => `kb/files/${m[1]}`],
  [/^data\/kb\/(.+)$/, (m) => `kb/${m[1]}`],
  [/^data\/prompts\/(.+)$/, (m) => `prompts/${m[1]}`],
  [/^data\/memes\/(.+)$/, (m) => `memes/${m[1]}`],
  [/^data\/platforms\/(.+)$/, (m) => `data/platforms/${m[1]}`],
  [/^home\/[^/]+\/documents\/(.+)$/, (m) => `data/documents/${m[1]}`],
  [/^home\/[^/]+\/pictures\/(.+)$/, (m) => `data/pictures/${m[1]}`],
  [/^home\/[^/]+\/identities\/(.+)$/, (m) => `identities/${m[1]}`],
  [/^home\/[^/]+\/ledger\/(.+)$/, (m) => `data/ledger/${m[1]}`],
  [/^extensions\/skills\/(.+)$/, (m) => `skills/${m[1]}`],
  [/^extensions\/scripts\/(.+)$/, (m) => `scripts/${m[1]}`],
  [/^state\/skill-drafts\/(.+)$/, (m) => `skills/drafts/${m[1]}`],
  [/^state\/profile\.md$/, () => 'profile.md'],
  [/^state\/usage\.json$/, () => 'state/usage.json'],
  [/^state\/repl-history\.jsonl$/, () => 'state/repl-history.jsonl'],
  [/^config\/webui-theme\.css$/, () => 'themes/webui-theme.css'],
  [/^config\/webui-themes\/(.+)$/, (m) => `themes/${m[1]}`],
];

/**
 * 旧版绝对路径 → 新版相对路径。
 * @param {string} absPath
 * @returns {{path: string|null, legacy_path: string|null}}
 */
function rewriteLegacyPath(absPath) {
  if (typeof absPath !== 'string' || !absPath.trim()) {
    return { path: null, legacy_path: null };
  }
  const rel = legacyRelative(absPath.trim());
  if (!rel) return { path: null, legacy_path: absPath.trim() };
  for (const [re, fn] of RELATIVE_REWRITES) {
    const match = rel.match(re);
    if (match) return { path: fn(match), legacy_path: null };
  }
  return { path: null, legacy_path: absPath.trim() };
}

/** sha256 十六进制。 */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

module.exports = {
  LegacyError,
  loadSqlite,
  sqliteAvailable,
  openReadOnly,
  withReadOnly,
  tableExists,
  tableColumns,
  allTables,
  resolveTable,
  readTable,
  closeQuietly,
  statSafe,
  isFile,
  isDir,
  isSymlink,
  listDirs,
  listFiles,
  walkTree,
  readFileText,
  readJson,
  readManifest,
  describeInput,
  uniquePersonaId,
  rewriteLegacyPath,
  legacyRelative,
  sha256Hex,
  SKIP_FILES,
};
