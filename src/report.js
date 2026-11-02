'use strict';
// 报告、指纹与「安全落盘」工具（MG5/MG8）。
//
// 报告里只放计数、路径、告警：**绝不含正文与密钥**，也不含旧库账号目录名、人格 id
// 与文件名，避免把真实数据带进可外发的证据文件。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** 跑一次的唯一 id：本地时间 YYYYMMDDTHHMMSS（同秒重复时加序号）。 */
function runIdAt(now = new Date(), taken = null) {
  const pad = (value) => String(value).padStart(2, '0');
  const base =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  if (typeof taken !== 'function') return base;
  let candidate = base;
  let counter = 2;
  while (taken(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

/** 新 run id：报告/备份目录用它做区分。 */
function newRunId(home) {
  const reports = path.join(home, '.migrate-reports');
  const backups = path.join(home, '.migrate-backup');
  return runIdAt(new Date(), (id) => {
    return fs.existsSync(path.join(reports, `${id}.json`)) || fs.existsSync(path.join(backups, id));
  });
}

/** 递归建目录（0700，幂等）。 */
function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {
    /* 某些文件系统不支持，忽略 */
  }
  return dir;
}

/** 原子写（临时文件 + rename），文件权限 0600。 */
function writeFilePrivate(target, data) {
  ensurePrivateDir(path.dirname(target));
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data, { mode: FILE_MODE });
  try {
    fs.chmodSync(tmp, FILE_MODE);
  } catch {
    /* 忽略 */
  }
  fs.renameSync(tmp, target);
  return target;
}

/** 原子写 JSON（缩进 2 + 结尾换行）。 */
function writeJsonPrivate(target, value) {
  return writeFilePrivate(target, `${JSON.stringify(value, null, 2)}\n`);
}

/** 读 JSON（不存在/坏 JSON 返回 fallback）。 */
function readJsonSafe(target, fallback) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 源指纹：对导出清单的 `entries[].path + blake3` 排序后做 sha256（MG3）。
 * 没有清单时退回目录树（相对路径 + 大小 + mtime）的指纹。
 * @param {import('./legacy').describeInput extends Function ? any : any} layout
 */
function fingerprintFor(layout) {
  const hash = crypto.createHash('sha256');
  const manifest = layout && layout.manifest;
  if (manifest && manifest.entries.length > 0) {
    hash.update('gqy-home-v0.7/manifest\n');
    for (const entry of manifest.entries) {
      hash.update(`${entry.path}\t${entry.blake3}\n`);
    }
    return `sha256:${hash.digest('hex')}`;
  }
  hash.update('gqy-home-v0.7/tree\n');
  const root = layout && layout.homeRoot ? layout.homeRoot : '';
  const walk = require('./legacy').walkTree(root || '.');
  for (const file of walk.files) {
    hash.update(`${file.rel}\t${file.size}\t${Math.round(file.mtimeMs)}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

function toPosix(rel) {
  return String(rel).split(path.sep).join('/');
}

/**
 * 覆盖前备份单个目标文件到 `$GQY_HOME/.migrate-backup/<run_id>/<相对路径>`。
 * @returns {'missing'|'copied'|'skipped_same'}
 */
function backupFile(home, runId, target, sameContentChecker) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink()) return 'missing'; // 符号链接一律不跟（MG5）
  if (!st.isFile()) return 'missing';
  if (typeof sameContentChecker === 'function' && sameContentChecker()) return 'skipped_same';

  const rel = toPosix(path.relative(home, target));
  const dest = path.join(home, '.migrate-backup', runId, rel);
  ensurePrivateDir(path.dirname(dest));
  fs.copyFileSync(target, dest);
  try {
    fs.chmodSync(dest, FILE_MODE);
  } catch {
    /* 忽略 */
  }
  return 'copied';
}

/**
 * 写迁移报告到 `$GQY_HOME/.migrate-reports/<run_id>.json`（或 `report` 覆盖路径）。
 * @returns {string} 实际写入的路径
 */
function writeReport(home, runId, report, overridePath) {
  const target = overridePath || path.join(home, '.migrate-reports', `${runId}.json`);
  writeJsonPrivate(target, report);
  return target;
}

/** 从 unit 表汇总 totals（报告 §4）。 */
function summarize(units) {
  const totals = {
    records: 0,
    records_added: 0,
    files: 0,
    files_copied: 0,
    bytes: 0,
    redacted: 0,
    orphan_vectors: 0,
    missing_vectors: 0,
    vector_surplus: 0,
    missing: 0,
    path_rewrites: { rewritten: 0, kept: 0 },
  };
  const byKind = { facts: 0, episodes: 0, revisions: 0, evicted: 0 };
  for (const unit of Object.values(units)) {
    if (!unit || typeof unit !== 'object') continue;
    if (unit.reason === 'not_selected') continue;
    totals.files += Number(unit.files) || 0;
    totals.files_copied += Number(unit.files_written) || 0;
    totals.bytes += Number(unit.bytes) || 0;
    totals.redacted += Number(unit.redacted) || 0;
    totals.orphan_vectors += Number(unit.orphan_vectors) || 0;
    totals.missing_vectors += Number(unit.missing_vectors) || 0;
    totals.vector_surplus += Number(unit.vector_surplus) || 0;
    totals.missing += Number(unit.missing) || 0;
    if (unit.path_rewrites) {
      totals.path_rewrites.rewritten += Number(unit.path_rewrites.rewritten) || 0;
      totals.path_rewrites.kept += Number(unit.path_rewrites.kept) || 0;
    }
    const records = unit.records || {};
    for (const [kind, value] of Object.entries(records)) {
      if (!Object.prototype.hasOwnProperty.call(byKind, kind)) continue;
      totals.records += Number(value) || 0;
      byKind[kind] += Number(value) || 0;
    }
    const added = unit.records_added || {};
    for (const [kind, value] of Object.entries(added)) {
      if (!Object.prototype.hasOwnProperty.call(byKind, kind)) continue;
      totals.records_added += Number(value) || 0;
    }
  }
  totals.records_by_kind = byKind;
  return totals;
}

module.exports = {
  DIR_MODE,
  FILE_MODE,
  sha256Hex,
  runIdAt,
  newRunId,
  ensurePrivateDir,
  writeFilePrivate,
  writeJsonPrivate,
  readJsonSafe,
  fingerprintFor,
  backupFile,
  writeReport,
  summarize,
};
