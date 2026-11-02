'use strict';
// 资产迁移（原始文件复制为主）。
//
// 组：kb / prompts / memes / skills / scripts / identities / usage / archive。
// - P0/P1 组默认迁：原样复制，目录 0700、文件 0600，符号链接一律拒绝。
// - archive 组（conversation.db / pictures / documents / ledger / platforms）默认只报体积（MG7），
//   `kinds:["archive"]` 才复制；conversation.db 做 best-effort（sessions + turns 文本）。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const legacy = require('./legacy');
const report = require('./report');

function posix(rel) {
  return String(rel).split(path.sep).join('/');
}

function sumBytes(files) {
  return files.reduce((total, file) => total + (Number(file.size) || 0), 0);
}

function sameContent(src, dest, size) {
  let st;
  try {
    st = fs.lstatSync(dest);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || !st.isFile()) return false;
  if (st.size !== size) return false;
  if (size > 8 * 1024 * 1024) return true; // 大文件只比大小，避免把 200MB 读两遍
  try {
    const left = fs.readFileSync(src);
    const right = fs.readFileSync(dest);
    return crypto.createHash('sha256').update(left).digest('hex') ===
      crypto.createHash('sha256').update(right).digest('hex');
  } catch {
    return false;
  }
}

/**
 * 规划「整棵目录复制」的 unit。
 * @returns {{unit: object, job: object|null}}
 */
function planCopyTree(ctx, unitName, group, srcRoot, destRoot) {
  const selected = ctx.options.kinds.includes(group);
  const walk = legacy.walkTree(srcRoot);
  const files = walk.files.map((file) => ({
    src: file.abs,
    destRel: posix(path.posix.join(destRoot, file.rel)),
    size: file.size,
  }));
  const unit = {
    group,
    status: files.length > 0 ? 'planned' : 'skipped',
    files: files.length,
    bytes: sumBytes(files),
    records: {},
    skipped: walk.skipped.length + walk.symlinks.length,
  };
  if (!selected) {
    unit.status = 'skipped';
    unit.reason = 'not_selected';
    return { unit, job: null };
  }
  if (files.length === 0) {
    unit.reason = 'source_missing';
    return { unit, job: null };
  }
  return { unit, job: { type: 'copy', unit: unitName, files } };
}

/** 规划单个文件复制。 */
function planCopyFile(ctx, unitName, group, srcFile, destRel) {
  const selected = ctx.options.kinds.includes(group);
  const st = legacy.statSafe(srcFile);
  const present = Boolean(st && st.isFile());
  const unit = {
    group,
    status: present ? 'planned' : 'skipped',
    files: present ? 1 : 0,
    bytes: present ? st.size : 0,
    records: {},
    skipped: 0,
  };
  if (!selected) {
    unit.status = 'skipped';
    unit.reason = 'not_selected';
    return { unit, job: null };
  }
  if (!present) {
    unit.reason = 'source_missing';
    return { unit, job: null };
  }
  return { unit, job: { type: 'copy', unit: unitName, files: [{ src: srcFile, destRel: posix(destRel), size: st.size }] } };
}

// 资产 unit 表：unit 名 / 组 / 源（相对旧 home）/ 目标（相对新 home）
const TREE_UNITS = [
  { unit: 'kb.files', group: 'kb', src: 'data/kb/files', dest: 'kb/files' },
  { unit: 'config.webui_themes', group: 'config', src: 'config/webui-themes', dest: 'themes' },
  { unit: 'data.prompts', group: 'prompts', src: 'data/prompts', dest: 'prompts' },
  { unit: 'data.memes', group: 'memes', src: 'data/memes', dest: 'memes' },
  { unit: 'extensions.skills', group: 'skills', src: 'extensions/skills', dest: 'skills' },
  { unit: 'state.skill_drafts', group: 'skills', src: 'state/skill-drafts', dest: 'skills/drafts' },
  { unit: 'extensions.scripts', group: 'scripts', src: 'extensions/scripts', dest: 'scripts' },
  { unit: 'home.pictures', group: 'archive', src: 'home/<host>/pictures', dest: 'data/pictures' },
  { unit: 'home.documents', group: 'archive', src: 'home/<host>/documents', dest: 'data/documents' },
  { unit: 'platform.message_history', group: 'archive', src: 'data/platforms', dest: 'data/platforms' },
];

// 单文件 unit 表
const FILE_UNITS = [
  { unit: 'kb.default_state', group: 'kb', src: 'data/default-kb/state.json', dest: 'kb/default-kb/state.json' },
  { unit: 'config.webui_theme', group: 'config', src: 'config/webui-theme.css', dest: 'themes/webui-theme.css' },
  { unit: 'home.identities', group: 'identities', src: 'home/<host>/identities', dest: 'identities', tree: true },
  { unit: 'state.profile', group: 'identities', src: 'state/profile.md', dest: 'profile.md' },
  { unit: 'state.usage', group: 'usage', src: 'state/usage.json', dest: 'state/usage.json' },
  { unit: 'state.repl_history', group: 'usage', src: 'state/repl-history.jsonl', dest: 'state/repl-history.jsonl' },
  { unit: 'state.arch_news', group: 'usage', src: 'state/arch_news_last_seen.json', dest: 'state/arch_news_last_seen.json' },
  {
    unit: 'state.imessage_contacts',
    group: 'usage',
    src: 'state/imessage-contacts.json',
    dest: 'state/imessage-contacts.json',
  },
  { unit: 'home.ledger', group: 'archive', src: 'home/<host>/ledger/ledger.db', dest: 'data/ledger/ledger.db' },
];

/** kb_meta.db（files 表）→ kb/meta.json，并把写死的绝对路径重写成相对路径。 */
function planKbMeta(ctx) {
  const source = path.join(ctx.layout.homeRoot, 'data', 'kb', 'kb_meta.db');
  const unit = {
    group: 'kb',
    status: 'planned',
    files: 1,
    bytes: legacy.statSafe(source)?.size || 0,
    records: {},
    path_rewrites: { rewritten: 0, kept: 0 },
    skipped: 0,
  };
  if (!ctx.options.kinds.includes('kb')) {
    unit.status = 'skipped';
    unit.reason = 'not_selected';
    return { unit, job: null };
  }
  if (!legacy.isFile(source)) {
    unit.status = 'skipped';
    unit.files = 0;
    unit.reason = 'source_missing';
    return { unit, job: null };
  }
  if (!legacy.sqliteAvailable()) {
    unit.status = 'failed';
    unit.error = 'node:sqlite 不可用，无法读 kb_meta.db';
    return { unit, job: null };
  }

  let rows = [];
  try {
    rows = legacy.withReadOnly(source, (db) => {
      const table = legacy.resolveTable(db, 'files', ['name', 'path']);
      if (!table) return [];
      return legacy.readTable(db, table, ['name', 'path', 'size_bytes', 'mtime', 'content_sha256', 'updated_at']);
    });
  } catch (err) {
    unit.status = 'failed';
    unit.error = err.message;
    return { unit, job: null };
  }

  const files = rows.map((row) => {
    const original = typeof row.path === 'string' ? row.path : '';
    const rewritten = legacy.rewriteLegacyPath(original);
    const entry = {
      name: typeof row.name === 'string' ? row.name : '',
      path: rewritten.path || original,
      size_bytes: Number(row.size_bytes) || 0,
      mtime: Number(row.mtime) || 0,
      content_sha256: typeof row.content_sha256 === 'string' ? row.content_sha256 : '',
      updated_at: Number(row.updated_at) || 0,
    };
    if (!rewritten.path) {
      entry.legacy_path = original;
      unit.path_rewrites.kept += 1;
    } else {
      unit.path_rewrites.rewritten += 1;
    }
    return entry;
  });

  unit.records = { tables: 1, rows: files.length };
  return {
    unit,
    job: {
      type: 'kb_meta',
      unit: 'kb.meta',
      payload: {
        schema_version: 1,
        source: 'legacy-v0.7',
        path_rewrites: { ...unit.path_rewrites },
        tables: { files },
      },
    },
  };
}

/** 时间列既可能是 INTEGER epoch，也可能是 RFC3339：统一成 ISO，认不出来就原样保留。 */
function normalizeTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    const millis = value > 1e12 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** 会话内容的展示字段：旧库混了裸文本、JSON 文本与整数，逐条容错。 */
function normalizeDisplayContent(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  return text;
}

/** conversation.db → sessions/<session>/…（best-effort，只在 archive 组选中时执行）。 */
function planConversation(ctx) {
  const host = ctx.layout.hosts[0];
  const source = host ? path.join(host.dir, 'conversation.db') : null;
  const unit = {
    group: 'archive',
    status: 'planned',
    files: source ? 1 : 0,
    bytes: source ? legacy.statSafe(source)?.size || 0 : 0,
    records: { sessions: 0, turns: 0, artifacts: 0 },
    path_rewrites: { rewritten: 0, kept: 0 },
    skipped: 0,
  };
  if (!ctx.options.kinds.includes('archive')) {
    unit.status = 'skipped';
    unit.reason = 'not_selected';
    return { unit, job: null };
  }
  if (!source || !legacy.isFile(source)) {
    if (!source) unit.files = 0;
    unit.status = 'skipped';
    unit.reason = 'source_missing';
    return { unit, job: null };
  }
  if (!legacy.sqliteAvailable()) {
    unit.status = 'failed';
    unit.error = 'node:sqlite 不可用，无法读 conversation.db';
    return { unit, job: null };
  }

  try {
    const info = legacy.withReadOnly(source, (db) => {
      const sessionTable = legacy.resolveTable(db, 'sessions', ['session_id', 'persona', 'name']);
      const turnsTable = legacy.resolveTable(db, 'turns', ['turn_id', 'session_id', 'seq']);
      const artifactTable = legacy.resolveTable(db, 'artifact_assets', ['asset_id', 'turn_id', 'source_key']);
      const count = (table) => (table ? Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n) || 0 : 0);
      return {
        sessionCount: count(sessionTable),
        turnCount: count(turnsTable),
        artifactCount: count(artifactTable),
      };
    });
    unit.records = { sessions: info.sessionCount, turns: info.turnCount, artifacts: info.artifactCount };
  } catch (err) {
    unit.status = 'failed';
    unit.error = err.message;
    return { unit, job: null };
  }

  return {
    unit,
    job: {
      type: 'conversation',
      unit: 'home.conversation',
      source,
      unitRef: unit,
    },
  };
}

/**
 * 规划全部资产 unit。
 * @returns {{units: object, warnings: string[], skipped: Array, state: object}}
 */
function plan(ctx) {
  const units = {};
  const warnings = [];
  const skipped = [];
  const jobs = [];
  const host = ctx.layout.hosts[0] || null;

  for (const entry of TREE_UNITS) {
    const src = entry.src.includes('<host>')
      ? host
        ? path.join(host.dir, entry.src.replace('home/<host>/', ''))
        : null
      : path.join(ctx.layout.homeRoot, entry.src);
    const { unit, job } = src
      ? planCopyTree(ctx, entry.unit, entry.group, src, entry.dest)
      : {
          unit: { group: entry.group, status: 'skipped', files: 0, bytes: 0, records: {}, reason: 'source_missing' },
          job: null,
        };
    units[entry.unit] = unit;
    if (job) jobs.push(job);
    if (!ctx.options.kinds.includes(entry.group)) skipped.push({ unit: entry.unit, reason: 'not_selected' });
    if (unit.skipped > 0) {
      warnings.push(`${entry.unit}: ${unit.skipped} 项被跳过（符号链接或系统垃圾文件，一律不迁）`);
    }
  }

  for (const entry of FILE_UNITS) {
    const src = entry.src.includes('<host>')
      ? host
        ? path.join(host.dir, entry.src.replace('home/<host>/', ''))
        : null
      : path.join(ctx.layout.homeRoot, entry.src);
    let planned;
    if (src && entry.tree) {
      planned = planCopyTree(ctx, entry.unit, entry.group, src, entry.dest);
    } else if (src) {
      planned = planCopyFile(ctx, entry.unit, entry.group, src, entry.dest);
    } else {
      planned = {
        unit: { group: entry.group, status: 'skipped', files: 0, bytes: 0, records: {}, reason: 'source_missing' },
        job: null,
      };
    }
    units[entry.unit] = planned.unit;
    if (planned.job) jobs.push(planned.job);
    if (!ctx.options.kinds.includes(entry.group)) skipped.push({ unit: entry.unit, reason: 'not_selected' });
    if (planned.unit.skipped > 0) {
      warnings.push(`${entry.unit}: ${planned.unit.skipped} 项被跳过（符号链接或系统垃圾文件，一律不迁）`);
    }
  }

  const kbMeta = planKbMeta(ctx);
  units['kb.meta'] = kbMeta.unit;
  if (kbMeta.job) jobs.push(kbMeta.job);
  if (!ctx.options.kinds.includes('kb')) skipped.push({ unit: 'kb.meta', reason: 'not_selected' });
  if (kbMeta.unit.status === 'failed') warnings.push(`kb.meta: ${kbMeta.unit.error}`);

  const conversation = planConversation(ctx);
  units['home.conversation'] = conversation.unit;
  if (conversation.job) jobs.push(conversation.job);
  if (!ctx.options.kinds.includes('archive')) skipped.push({ unit: 'home.conversation', reason: 'not_selected' });

  // archive 默认不迁：把体积报出来（MG7），别让用户以为「没东西可迁」。
  if (!ctx.options.kinds.includes('archive')) {
    const archiveUnits = Object.entries(units).filter(([, unit]) => unit && unit.group === 'archive');
    const files = archiveUnits.reduce((total, [, unit]) => total + (Number(unit.files) || 0), 0);
    const bytes = archiveUnits.reduce((total, [, unit]) => total + (Number(unit.bytes) || 0), 0);
    if (files > 0) {
      warnings.push(
        `archive 组默认不迁：${files} 个文件（约 ${(bytes / 1024 / 1024).toFixed(1)} MB），` +
          '需要 --kinds 里加 archive 才复制（MG7）',
      );
    }
  }

  return { units, warnings, skipped, state: { jobs } };
}

function copyOne(ctx, file, stats) {
  const target = path.join(ctx.options.home, file.destRel);
  if (sameContent(file.src, target, file.size)) {
    stats.unchanged += 1;
    return;
  }
  if (ctx.backup) report.backupFile(ctx.options.home, ctx.runId, target);
  report.ensurePrivateDir(path.dirname(target));
  fs.copyFileSync(file.src, target);
  try {
    fs.chmodSync(target, report.FILE_MODE);
  } catch {
    /* 忽略 */
  }
  stats.copied += 1;
}

/** 执行资产写入（只在 apply=true 时被调用）。 */
function apply(ctx, planResult) {
  const result = { units: {}, files_written: 0 };

  for (const job of planResult.state.jobs) {
    if (job.type === 'copy') {
      const stats = { copied: 0, unchanged: 0 };
      for (const file of job.files) {
        try {
          copyOne(ctx, file, stats);
        } catch (err) {
          const unit = result.units[job.unit] || (result.units[job.unit] = {});
          unit.status = 'failed';
          unit.error = `复制失败：${path.basename(file.destRel)}（${err.code || 'error'}）`;
          continue;
        }
      }
      const unit = result.units[job.unit] || (result.units[job.unit] = {});
      if (unit.status !== 'failed') {
        unit.status = stats.copied > 0 ? 'applied' : 'unchanged';
      }
      unit.files_written = stats.copied;
      unit.files_unchanged = stats.unchanged;
      result.files_written += stats.copied;
      continue;
    }

    if (job.type === 'kb_meta') {
      try {
        const target = path.join(ctx.options.home, 'kb', 'meta.json');
        const current = report.readJsonSafe(target, null);
        const value = { ...job.payload };
        if (current && JSON.stringify(current) === JSON.stringify(value)) {
          result.units['kb.meta'] = { status: 'unchanged', files_written: 0 };
          continue;
        }
        if (ctx.backup) report.backupFile(ctx.options.home, ctx.runId, target);
        report.writeJsonPrivate(target, value);
        result.units['kb.meta'] = { status: 'applied', files_written: 1 };
        result.files_written += 1;
      } catch (err) {
        result.units['kb.meta'] = { status: 'failed', error: `写 kb/meta.json 失败（${err.code || 'error'}）` };
      }
      continue;
    }

    if (job.type === 'conversation') {
      try {
        const stats = applyConversation(ctx, job);
        result.units['home.conversation'] = {
          status: stats.written > 0 ? 'applied' : 'unchanged',
          files_written: stats.written,
          records_written: stats.records,
          path_rewrites: stats.path_rewrites,
        };
        result.files_written += stats.written;
        job.unitRef.path_rewrites = stats.path_rewrites;
      } catch (err) {
        result.units['home.conversation'] = {
          status: 'failed',
          error: `会话归档失败（${err.code || 'error'}）`,
        };
      }
    }
  }

  return result;
}

function safeDirName(value) {
  const cleaned = String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(0, 96);
  return cleaned || `session-${legacy.sha256Hex(String(value || '')).slice(0, 12)}`;
}

function applyConversation(ctx, job) {
  const stats = { written: 0, records: { sessions: 0, turns: 0, artifacts: 0 }, path_rewrites: { rewritten: 0, kept: 0 } };
  const sessions = new Map();
  const turns = [];
  const artifacts = [];

  legacy.withReadOnly(job.source, (db) => {
    const sessionTable = legacy.resolveTable(db, 'sessions', ['session_id', 'persona', 'name']);
    const turnsTable = legacy.resolveTable(db, 'turns', ['turn_id', 'session_id', 'seq']);
    const artifactTable = legacy.resolveTable(db, 'artifact_assets', ['asset_id', 'turn_id', 'source_key']);

    if (sessionTable) {
      for (const row of legacy.readTable(db, sessionTable, [
        'session_id',
        'persona',
        'name',
        'kind',
        'created_at',
        'updated_at',
        'archived',
        'owner',
        'model',
        'provider_id',
        'total_tokens',
      ])) {
        const id = String(row.session_id || '');
        if (!id) continue;
        sessions.set(id, {
          session_id: id,
          persona: String(row.persona || ''),
          name: String(row.name || ''),
          kind: String(row.kind || 'user'),
          archived: Number(row.archived) > 0,
          owner: String(row.owner || ''),
          model: String(row.model || ''),
          provider_id: String(row.provider_id || ''),
          total_tokens: Number(row.total_tokens) || 0,
          created_at: normalizeTimestamp(row.created_at),
          updated_at: normalizeTimestamp(row.updated_at),
        });
      }
    }
    if (turnsTable) {
      for (const row of legacy.readTable(db, turnsTable, [
        'turn_id',
        'session_id',
        'seq',
        'user_content',
        'user_timestamp',
        'assistant_content',
        'assistant_reasoning',
        'assistant_timestamp',
        'status',
        'hidden',
        'is_summary',
        'display_content',
        'token_total',
        'assistant_provider_id',
        'assistant_model',
        'workspace',
      ])) {
        const sessionId = String(row.session_id || '');
        if (!sessionId) continue;
        turns.push({
          turn_id: String(row.turn_id || ''),
          session_id: sessionId,
          seq: Number(row.seq) || 0,
          user_content: String(row.user_content ?? ''),
          user_timestamp: normalizeTimestamp(row.user_timestamp),
          assistant_content: String(row.assistant_content ?? ''),
          assistant_reasoning: row.assistant_reasoning === null ? null : String(row.assistant_reasoning ?? ''),
          assistant_timestamp: normalizeTimestamp(row.assistant_timestamp),
          status: String(row.status || ''),
          hidden: Number(row.hidden) > 0,
          is_summary: Number(row.is_summary) > 0,
          display_content: normalizeDisplayContent(row.display_content),
          token_total: Number(row.token_total) || 0,
          assistant_provider_id: String(row.assistant_provider_id || ''),
          assistant_model: String(row.assistant_model || ''),
          workspace: String(row.workspace || ''),
        });
      }
    }
    if (artifactTable) {
      for (const row of legacy.readTable(db, artifactTable, [
        'asset_id',
        'turn_id',
        'tool_id',
        'source_key',
        'file_name',
        'mime',
        'kind',
        'size_bytes',
        'data',
        'created_at',
        'updated_at',
      ])) {
        const rewritten = legacy.rewriteLegacyPath(String(row.source_key || ''));
        const entry = {
          asset_id: String(row.asset_id || ''),
          turn_id: String(row.turn_id || ''),
          tool_id: row.tool_id === null ? null : String(row.tool_id ?? ''),
          source_key: rewritten.path || String(row.source_key || ''),
          file_name: String(row.file_name || ''),
          mime: String(row.mime || ''),
          kind: String(row.kind || ''),
          size_bytes: Number(row.size_bytes) || 0,
          created_at: normalizeTimestamp(row.created_at),
          updated_at: normalizeTimestamp(row.updated_at),
        };
        if (!rewritten.path) {
          entry.legacy_path = String(row.source_key || '');
          stats.path_rewrites.kept += 1;
        } else {
          stats.path_rewrites.rewritten += 1;
        }
        const blob = row.data;
        if (blob && entry.asset_id) {
          const safeName = safeDirName(`${entry.asset_id}-${entry.file_name}`);
          entry.local_path = `assets/${safeName}`;
          const target = path.join(ctx.options.home, 'sessions', safeDirName(entry.turn_id), 'assets', safeName);
          try {
            report.ensurePrivateDir(path.dirname(target));
            if (!fs.existsSync(target)) {
              fs.writeFileSync(target, Buffer.from(blob), { mode: report.FILE_MODE });
              stats.written += 1;
            }
          } catch {
            entry.local_path = null;
          }
        }
        artifacts.push(entry);
      }
    }
  });

  const bySession = new Map();
  for (const session of sessions.values()) {
    bySession.set(session.session_id, { ...session, turns: [], artifacts: [] });
  }
  for (const turn of turns) {
    const bucket = bySession.get(turn.session_id);
    if (bucket) bucket.turns.push(turn);
  }
  for (const artifact of artifacts) {
    const turn = turns.find((item) => item.turn_id === artifact.turn_id);
    const bucket = turn ? bySession.get(turn.session_id) : null;
    if (bucket) bucket.artifacts.push(artifact);
  }

  for (const bucket of bySession.values()) {
    const dirRel = path.posix.join('sessions', safeDirName(bucket.session_id));
    const sessionTarget = path.join(ctx.options.home, dirRel, 'session.json');
    const turnsTarget = path.join(ctx.options.home, dirRel, 'turns.jsonl');
    const artifactsTarget = path.join(ctx.options.home, dirRel, 'artifacts.jsonl');

    const sessionValue = {
      session_id: bucket.session_id,
      persona: bucket.persona,
      name: bucket.name,
      kind: bucket.kind,
      archived: bucket.archived,
      owner: bucket.owner,
      model: bucket.model,
      provider_id: bucket.provider_id,
      total_tokens: bucket.total_tokens,
      created_at: bucket.created_at,
      updated_at: bucket.updated_at,
      migrated_from: 'gqy-home-v0.7',
      counts: { turns: bucket.turns.length, artifacts: bucket.artifacts.length },
    };
    if (writeIfChangedRaw(ctx, sessionTarget, `${JSON.stringify(sessionValue, null, 2)}\n`)) {
      stats.written += 1;
      stats.records.sessions += 1;
    }
    if (bucket.turns.length > 0) {
      const body = `${bucket.turns.map((turn) => JSON.stringify(turn)).join('\n')}\n`;
      if (writeIfChangedRaw(ctx, turnsTarget, body)) {
        stats.written += 1;
        stats.records.turns += bucket.turns.length;
      }
    }
    if (bucket.artifacts.length > 0) {
      const body = `${bucket.artifacts.map((artifact) => JSON.stringify(artifact)).join('\n')}\n`;
      if (writeIfChangedRaw(ctx, artifactsTarget, body)) {
        stats.written += 1;
        stats.records.artifacts += bucket.artifacts.length;
      }
    }
  }
  return stats;
}

function writeIfChangedRaw(ctx, target, data) {
  let current = null;
  try {
    current = fs.readFileSync(target, 'utf8');
  } catch {
    current = null;
  }
  if (current === data) return false;
  if (ctx.backup) report.backupFile(ctx.options.home, ctx.runId, target);
  report.writeFilePrivate(target, data);
  return true;
}

module.exports = {
  TREE_UNITS,
  FILE_UNITS,
  normalizeTimestamp,
  normalizeDisplayContent,
  plan,
  apply,
  planKbMeta,
  planConversation,
};
