'use strict';
// 记忆库迁移（personas.manifest / personas.memory / state.evicted_context）。
//
// 把旧库 SQLite 的 facts / episodes / memory_revisions / pending_events / skill_records /
// memory_embeddings / evicted_turns / evicted_embeddings 映射成新版的 JSONL
// （blueprint/migrate.md §3.1、blueprint/memory.md §2）。
//
// 幂等（MG3）：新记录带 `legacy_id`，重跑按差集只补新行；`source_key` / 正文 sha256 是第二层去重键。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const legacy = require('./legacy');
const report = require('./report');

const SOURCE = 'migration:legacy-0.7';

const FACT_COLUMNS = [
  'id',
  'content',
  'status',
  'confidence',
  'strength',
  'recall_count',
  'last_recalled_at',
  'last_decay_at',
  'created_at',
  'updated_at',
  'visibility',
  'owner_principal',
  'owner_display_name',
  'subjects',
  'memory_type',
  'truth_status',
  'importance',
  'tags',
  'source_episode_ids',
  'origin_session_id',
];

const EPISODE_COLUMNS = [
  ...FACT_COLUMNS,
  'retention',
  'user_message',
  'assistant_message',
  'expires_at',
  'consolidated_at',
  'promotion_pending',
  'promoted_at',
  'source_key',
  'origin_kind',
  'origin_platform',
  'origin_account_id',
  'origin_conversation_kind',
  'origin_conversation_id',
  'origin_sender_id',
  'origin_sender_display_name',
  'origin_message_id',
];

const REVISION_COLUMNS = ['id', 'memory_id', 'old_content', 'new_content', 'source_episode_ids', 'created_at'];
const PENDING_COLUMNS = ['id', 'user_message', 'assistant_message', 'created_at', 'processed_at', 'origin_session_id'];
const SKILL_COLUMNS = ['id', 'name', 'path', 'summary', 'created_at', 'updated_at'];
const META_COLUMNS = ['id', 'generation', 'database_id', 'access_schema_version'];
const EMBEDDING_COLUMNS = ['kind', 'id', 'model', 'content_sha256', 'embedding', 'embedding_json', 'created_at'];
const EVICTED_COLUMNS = [
  'id',
  'source_id',
  'timestamp',
  'role',
  'content',
  'created_at',
  'visibility',
  'owner_principal',
  'owner_display_name',
  'origin_session_id',
];
const EVICTED_EMBEDDING_COLUMNS = ['id', 'model', 'embedding', 'embedding_json', 'created_at'];

// 已知 embedding 模型的维度：用来判断 BLOB 是 int8（len == dim）还是 float32（len == 4*dim）。
// 注意：旧库 model 名会写错（bge-small-zh 存的是 int8 名，实际是 float32），所以名字只用来查维度，
// 编码一律按 BLOB 长度定（blueprint/memory.md 的「向量编码陷阱」）。
const MODEL_DIMS = [
  [/bge-small-zh/i, 512],
  [/bge-small-en/i, 384],
  [/bge-base-zh/i, 768],
  [/bge-large-zh/i, 1024],
  [/bge-base-en/i, 768],
  [/bge-large-en/i, 1024],
  [/bge-m3/i, 1024],
  [/m3e/i, 768],
  [/text-embedding-3-small/i, 1536],
  [/text-embedding-3-large/i, 3072],
  [/text-embedding-ada-002/i, 1536],
  [/nomic-embed/i, 768],
  [/qwen.*embed/i, 1024],
];

// ---------- 值归一化 ----------

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const str = text(value);
  return str === '' ? null : str;
}

function integer(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.trunc(num);
}

function real(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}

/**
 * JSON 文本列 → 值。旧库三种形状不同：
 * - `subjects` 是对象数组 `[{"name":…}]`（保持对象数组）
 * - `tags` 是字符串数组
 * - `source_episode_ids` 是整数数组
 * 所以只解析、不改写形状；解析失败给空数组。
 */
function jsonColumn(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clampInt(value, min, max, fallback) {
  const num = integer(value, fallback);
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

// ---------- embedding ----------

function toBuffer(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.from(value);
  return null;
}

function knownDim(model) {
  for (const [pattern, dim] of MODEL_DIMS) {
    if (pattern.test(model)) return dim;
  }
  return null;
}

/** float32 落盘时通常 L2 归一（≈1.0）；用它判断「这串字节更像 float32 还是 int8」。 */
function looksLikeNormalizedFloat32(buf) {
  if (buf.length < 16 || buf.length % 4 !== 0) return false;
  const copy = Buffer.from(buf);
  const view = new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4);
  let sum = 0;
  let bad = 0;
  for (let i = 0; i < view.length; i += 1) {
    const value = view[i];
    if (!Number.isFinite(value) || Math.abs(value) > 8) {
      bad += 1;
      if (bad > Math.max(1, view.length * 0.02)) return false;
      continue;
    }
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  return Number.isFinite(norm) && norm > 0.5 && norm < 1.5;
}

/**
 * 解码一条向量：编码按 BLOB 长度判断，不按 model 名。
 * `len == dim` → int8；`len == 4*dim` → float32。
 */
function decodeEmbedding(row) {
  const model = text(row.model) || 'unknown';
  const raw = toBuffer(row.embedding);
  if (!raw || raw.length === 0) {
    const json = text(row.embedding_json).trim();
    if (!json) return null;
    return decodeEmbeddingArray(json, model);
  }
  const dim = knownDim(model);
  let encoding = null;
  let resolved = 0;
  if (dim) {
    if (raw.length === dim) {
      encoding = 'int8';
      resolved = dim;
    } else if (raw.length === dim * 4) {
      encoding = 'float32';
      resolved = dim;
    }
  }
  if (!encoding) {
    if (looksLikeNormalizedFloat32(raw)) {
      encoding = 'float32';
      resolved = raw.length / 4;
    } else if (raw.length % 4 === 0) {
      encoding = 'float32';
      resolved = raw.length / 4;
    } else {
      encoding = 'int8';
      resolved = raw.length;
    }
  }
  if (!resolved || resolved <= 0) return null;
  return { model, dim: resolved, encoding, data: raw.toString('base64') };
}

function decodeEmbeddingArray(textValue, model) {
  let parsed;
  try {
    parsed = JSON.parse(textValue);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const numbers = parsed.map((value) => Number(value));
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  const allInt8 = numbers.every((value) => Number.isInteger(value) && value >= -128 && value <= 127);
  if (allInt8) {
    const bytes = Buffer.alloc(numbers.length);
    for (let i = 0; i < numbers.length; i += 1) bytes[i] = numbers[i] & 0xff;
    return { model, dim: numbers.length, encoding: 'int8', data: bytes.toString('base64') };
  }
  const bytes = Buffer.alloc(numbers.length * 4);
  for (let i = 0; i < numbers.length; i += 1) bytes.writeFloatLE(numbers[i], i * 4);
  return { model, dim: numbers.length, encoding: 'float32', data: bytes.toString('base64') };
}

// ---------- TOML（只解析 persona.toml 用到的子集） ----------

function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map((item) => parseTomlValue(item))
      .filter((item) => item !== null);
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : value;
}

/** 极简 TOML：只支持 `[section]` + `key = value`（旧版 persona.toml 的实际形状）。 */
function parseToml(source) {
  const out = {};
  let section = null;
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!out[section] || typeof out[section] !== 'object' || Array.isArray(out[section])) out[section] = {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = parseTomlValue(kv[2]);
    if (section) out[section][key] = value;
    else out[key] = value;
  }
  return out;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    out[key] = item;
  }
  return out;
}

// ---------- 记录映射（blueprint/migrate.md §3.1） ----------

function mapFact(row) {
  const id = integer(row.id);
  return {
    id,
    legacy_id: `legacy:facts:${id}`,
    kind: 'fact',
    content: text(row.content),
    memory_type: text(row.memory_type) || 'fact',
    truth_status: text(row.truth_status) || 'reported',
    status: text(row.status) || 'active',
    importance: clampInt(row.importance, 1, 5, 3),
    confidence: real(row.confidence, 1),
    strength: real(row.strength, 1),
    recall_count: Math.max(0, integer(row.recall_count)),
    last_recalled_at: nullableText(row.last_recalled_at),
    last_decay_at: nullableText(row.last_decay_at),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
    visibility: text(row.visibility) || 'privileged',
    owner_principal: text(row.owner_principal),
    owner_display_name: text(row.owner_display_name),
    subjects: jsonColumn(row.subjects),
    tags: jsonColumn(row.tags),
    source_episode_ids: jsonColumn(row.source_episode_ids),
    origin_session_id: text(row.origin_session_id),
    source: SOURCE,
  };
}

function mapEpisode(row) {
  const id = integer(row.id);
  const fact = mapFact(row);
  return {
    ...fact,
    legacy_id: `legacy:episodes:${id}`,
    kind: 'episode',
    retention: text(row.retention) || 'long_term',
    user_message: text(row.user_message),
    assistant_message: text(row.assistant_message),
    expires_at: nullableText(row.expires_at),
    consolidated_at: nullableText(row.consolidated_at),
    promotion_pending: bool(row.promotion_pending),
    promoted_at: nullableText(row.promoted_at),
    source_key: text(row.source_key),
    origin_kind: text(row.origin_kind),
    origin_platform: text(row.origin_platform),
    origin_account_id: text(row.origin_account_id),
    origin_conversation_kind: text(row.origin_conversation_kind),
    origin_conversation_id: text(row.origin_conversation_id),
    origin_sender_id: text(row.origin_sender_id),
    origin_sender_display_name: text(row.origin_sender_display_name),
    origin_message_id: text(row.origin_message_id),
  };
}

function mapPendingEpisode(row) {
  const id = integer(row.id);
  const userMessage = text(row.user_message);
  const assistantMessage = text(row.assistant_message);
  const createdAt = text(row.created_at);
  return {
    id,
    legacy_id: `legacy:pending_events:${id}`,
    kind: 'episode',
    content: [userMessage, assistantMessage].filter(Boolean).join('\n\n'),
    memory_type: 'fact',
    truth_status: 'reported',
    status: 'active',
    importance: 3,
    confidence: 1,
    strength: 1,
    recall_count: 0,
    last_recalled_at: null,
    last_decay_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    visibility: 'privileged',
    owner_principal: '',
    owner_display_name: '',
    subjects: [],
    tags: [],
    source_episode_ids: [],
    origin_session_id: text(row.origin_session_id),
    source: SOURCE,
    retention: 'short_term',
    user_message: userMessage,
    assistant_message: assistantMessage,
    expires_at: null,
    consolidated_at: null,
    promotion_pending: false,
    promoted_at: null,
    source_key: '',
    origin_kind: '',
    origin_platform: '',
    origin_account_id: '',
    origin_conversation_kind: '',
    origin_conversation_id: '',
    origin_sender_id: '',
    origin_sender_display_name: '',
    origin_message_id: '',
  };
}

function mapRevision(row) {
  const id = integer(row.id);
  return {
    id,
    legacy_id: `legacy:memory_revisions:${id}`,
    kind: 'revision',
    memory_id: integer(row.memory_id),
    old_content: text(row.old_content),
    new_content: text(row.new_content),
    source_episode_ids: jsonColumn(row.source_episode_ids),
    created_at: text(row.created_at),
  };
}

function mapEvicted(row) {
  const id = integer(row.id);
  return {
    id,
    legacy_id: `legacy:evicted_turns:${id}`,
    kind: 'evicted',
    source_id: nullableText(row.source_id),
    timestamp: text(row.timestamp),
    created_at: text(row.created_at),
    role: text(row.role),
    content: text(row.content),
    visibility: text(row.visibility) || 'privileged',
    owner_principal: text(row.owner_principal),
    owner_display_name: text(row.owner_display_name),
    origin_session_id: text(row.origin_session_id),
  };
}

function mapSkill(row) {
  return {
    id: integer(row.id),
    legacy_id: `legacy:skill_records:${integer(row.id)}`,
    name: text(row.name),
    path: text(row.path),
    summary: text(row.summary),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}

// ---------- 读一个旧库 ----------

function readPersonaMemory(persona) {
  const out = {
    id: persona.id,
    facts: [],
    episodes: [],
    revisions: [],
    skills: [],
    meta: null,
    embeddings: 0,
    orphanVectors: 0,
    missingVectors: 0,
    episodeVectors: 0,
    factVectors: 0,
    error: null,
  };
  if (!persona.memoryDb) {
    out.error = null;
    return out;
  }
  let db = null;
  try {
    db = legacy.openReadOnly(persona.memoryDb);
  } catch (err) {
    out.error = err.message;
    return out;
  }
  try {
    // 向量按 (kind,id) 挂到记录上；挂不上的只计数（blueprint §3.1）。
    const vectors = new Map();
    if (legacy.tableExists(db, 'memory_embeddings')) {
      for (const row of legacy.readTable(db, 'memory_embeddings', EMBEDDING_COLUMNS)) {
        const kind = text(row.kind);
        const id = integer(row.id);
        if (!kind || !Number.isFinite(id)) continue;
        const vector = decodeEmbedding(row);
        if (vector) vectors.set(`${kind}:${id}`, vector);
      }
    }

    out.facts = legacy
      .readTable(db, 'facts', FACT_COLUMNS)
      .map(mapFact)
      .sort((a, b) => a.id - b.id);
    for (const record of out.facts) {
      const vector = vectors.get(`fact:${record.id}`);
      if (vector) {
        record.embedding = vector;
        vectors.delete(`fact:${record.id}`);
        out.embeddings += 1;
        out.factVectors += 1;
      } else {
        out.missingVectors += 1;
      }
    }

    out.episodes = legacy
      .readTable(db, 'episodes', EPISODE_COLUMNS)
      .map(mapEpisode)
      .sort((a, b) => a.id - b.id);
    for (const record of out.episodes) {
      const vector = vectors.get(`episode:${record.id}`);
      if (vector) {
        record.embedding = vector;
        vectors.delete(`episode:${record.id}`);
        out.embeddings += 1;
        out.episodeVectors += 1;
      } else {
        out.missingVectors += 1;
      }
    }

    // 未处理的事件当短期片段迁；已处理的跳过。
    const pendingRows = legacy
      .readTable(db, 'pending_events', PENDING_COLUMNS)
      .filter((row) => row.processed_at === null || row.processed_at === undefined || text(row.processed_at) === '');
    if (pendingRows.length > 0) {
      let nextId = out.episodes.reduce((max, record) => Math.max(max, record.id), 0);
      for (const row of pendingRows) {
        nextId += 1;
        const record = mapPendingEpisode(row);
        record.id = nextId;
        record.legacy_id = `legacy:pending_events:${integer(row.id)}`;
        out.episodes.push(record);
        out.missingVectors += 1;
      }
      out.episodes.sort((a, b) => a.id - b.id);
    }

    out.revisions = legacy
      .readTable(db, 'memory_revisions', REVISION_COLUMNS)
      .map(mapRevision)
      .sort((a, b) => a.id - b.id);

    out.skills = legacy
      .readTable(db, 'skill_records', SKILL_COLUMNS)
      .map(mapSkill)
      .sort((a, b) => a.id - b.id);

    if (legacy.tableExists(db, 'memory_meta')) {
      const row = legacy.readTable(db, 'memory_meta', META_COLUMNS)[0];
      if (row) {
        out.meta = {
          generation: integer(row.generation),
          database_id: text(row.database_id),
          access_schema_version: integer(row.access_schema_version),
        };
      }
    }

    out.orphanVectors = vectors.size;
    for (const key of vectors.keys()) {
      if (key.startsWith('episode:')) out.episodeVectors += 1;
      else out.factVectors += 1;
    }
  } catch (err) {
    out.error = err.message;
  } finally {
    legacy.closeQuietly(db);
  }
  return out;
}

function readPersonaEvicted(persona) {
  const out = { records: [], embeddings: 0, orphanVectors: 0, error: null };
  if (!persona.evictedDb) return out;
  let db = null;
  try {
    db = legacy.openReadOnly(persona.evictedDb);
  } catch (err) {
    out.error = err.message;
    return out;
  }
  try {
    const vectors = new Map();
    if (legacy.tableExists(db, 'evicted_embeddings')) {
      for (const row of legacy.readTable(db, 'evicted_embeddings', EVICTED_EMBEDDING_COLUMNS)) {
        const vector = decodeEmbedding(row);
        if (vector) vectors.set(integer(row.id), vector);
      }
    }
    out.records = legacy
      .readTable(db, 'evicted_turns', EVICTED_COLUMNS)
      .map(mapEvicted)
      .sort((a, b) => a.id - b.id);
    for (const record of out.records) {
      const vector = vectors.get(record.id);
      if (vector) {
        record.embedding = vector;
        vectors.delete(record.id);
        out.embeddings += 1;
      }
    }
    out.orphanVectors = vectors.size;
  } catch (err) {
    out.error = err.message;
  } finally {
    legacy.closeQuietly(db);
  }
  return out;
}

// ---------- plan ----------

function selectPersonas(personas, persona) {
  if (!persona) return personas.slice();
  return personas.filter((item) => item.id === persona);
}

/**
 * 规划记忆相关 unit（不写目标）。
 * @returns {{units: object, warnings: string[], skipped: Array, state: object}}
 */
function plan(ctx) {
  const groups = new Set(ctx.options.kinds);
  const units = {};
  const warnings = [];
  const skipped = [];
  const state = { personas: null, memories: [], homeMarker: ctx.layout.homeMarker };
  const personas = selectPersonas(ctx.layout.personas, ctx.options.persona);

  if (ctx.options.persona && personas.length === 0) {
    warnings.push(`persona=${ctx.options.persona} 在导出里没有对应人格库，未迁任何记忆`);
  }
  if (ctx.layout.extraEvicted.length > 0) {
    warnings.push(
      `state.evicted_context: ${ctx.layout.extraEvicted.length} 个 evicted 库没有对应的记忆库，已跳过`,
    );
  }

  // 1) personas.manifest：persona.toml → memory/personas.json
  if (groups.has('personas')) {
    const list = [];
    let files = 0;
    let bytes = 0;
    for (const persona of personas) {
      let doc = {};
      if (persona.personaToml) {
        files += 1;
        doc = parseToml(legacy.readFileText(persona.personaToml) || '');
      }
      const entry = { id: persona.id, source: 'legacy' };
      const subsystems = plainObject(doc.subsystems);
      if (Object.keys(subsystems).length > 0) entry.subsystems = subsystems;
      const plugins = plainObject(doc.plugins);
      if (Object.keys(plugins).length > 0) entry.plugins = plugins;
      list.push(entry);
    }
    if (personas.some((persona) => persona.idRenamed)) {
      warnings.push('personas.manifest: 有旧人格目录名不合新版 id 规则，已按 [a-z0-9_-] 归一');
    }
    state.personas = list;
    units['personas.manifest'] = {
      group: 'personas',
      status: list.length > 0 ? 'planned' : 'skipped',
      files,
      bytes,
      records: { personas: list.length },
      records_added: { personas: 0 },
    };
    if (list.length === 0) skipped.push({ unit: 'personas.manifest', reason: 'no_persona' });
  }

  // 2) personas.memory / 3) state.evicted_context
  if (groups.has('memory')) {
    const memoryUnit = {
      group: 'memory',
      status: 'planned',
      files: 0,
      bytes: 0,
      records: { facts: 0, episodes: 0, revisions: 0, embeddings: 0 },
      records_added: { facts: 0, episodes: 0, revisions: 0 },
      source_embeddings: 0,
      orphan_vectors: 0,
      missing_vectors: 0,
      vector_surplus: 0,
      missing: ctx.layout.missingPersonas,
      skipped: 0,
    };
    const evictedUnit = {
      group: 'memory',
      status: 'planned',
      files: 0,
      bytes: 0,
      records: { evicted: 0 },
      records_added: { evicted: 0 },
      source_embeddings: 0,
      orphan_vectors: 0,
      skipped: 0,
    };

    for (const persona of personas) {
      const memory = readPersonaMemory(persona);
      const evicted = readPersonaEvicted(persona);
      const entry = { ...memory, evicted, id: persona.id };

      if (memory.error) {
        memoryUnit.status = 'failed';
        memoryUnit.error = memory.error;
        warnings.push(`personas.memory: 有旧库读取失败（${memory.error}），该库未迁`);
      }
      if (evicted.error) {
        evictedUnit.status = 'failed';
        evictedUnit.error = evicted.error;
        warnings.push(`state.evicted_context: 有旧库读取失败（${evicted.error}），该库未迁`);
      }
      if (persona.memoryDb) {
        memoryUnit.files += 1;
        memoryUnit.bytes += legacy.statSafe(persona.memoryDb)?.size || 0;
      }
      if (persona.evictedDb) {
        evictedUnit.files += 1;
        evictedUnit.bytes += legacy.statSafe(persona.evictedDb)?.size || 0;
      }

      memoryUnit.records.facts += memory.facts.length;
      memoryUnit.records.episodes += memory.episodes.length;
      memoryUnit.records.revisions += memory.revisions.length;
      memoryUnit.records.embeddings += memory.embeddings;
      memoryUnit.source_embeddings += memory.embeddings + memory.orphanVectors;
      memoryUnit.orphan_vectors += memory.orphanVectors;
      memoryUnit.missing_vectors += memory.missingVectors;
      // 文档口径：旧库向量条数超出片段条数的差额（2684 - 2054 = 630）。
      memoryUnit.vector_surplus += Math.max(0, memory.episodeVectors - memory.episodes.length);

      evictedUnit.records.evicted += evicted.records.length;
      evictedUnit.source_embeddings += evicted.embeddings + evicted.orphanVectors;
      evictedUnit.orphan_vectors += evicted.orphanVectors;

      state.memories.push(entry);
    }

    if (memoryUnit.orphan_vectors > 0) {
      warnings.push(
        `personas.memory: ${memoryUnit.orphan_vectors} 条向量挂不到任何记录（旧库已删除对应记录），已计入 orphan_vectors`,
      );
    }
    if (memoryUnit.missing_vectors > 0) {
      warnings.push(
        `personas.memory: ${memoryUnit.missing_vectors} 条记录没有向量（旧库未算或写入失败），已计入 missing_vectors`,
      );
    }
    if (memoryUnit.missing > 0) {
      warnings.push(
        `personas.memory: 导出清单声明了 ${memoryUnit.missing + memoryUnit.files} 个记忆库，磁盘只有 ${memoryUnit.files} 个；缺失的 ${memoryUnit.missing} 个记入 missing（不造空库）`,
      );
    }
    if (evictedUnit.orphan_vectors > 0) {
      warnings.push(
        `state.evicted_context: evicted_turns=${evictedUnit.records.evicted}，evicted_embeddings 有 ${evictedUnit.orphan_vectors} 条孤儿，已计入 orphan_vectors`,
      );
    }
    if (memoryUnit.files === 0) {
      memoryUnit.status = 'skipped';
      skipped.push({ unit: 'personas.memory', reason: 'no_memory_db' });
    }
    if (evictedUnit.files === 0) {
      evictedUnit.status = 'skipped';
      skipped.push({ unit: 'state.evicted_context', reason: 'no_evicted_db' });
    }
    units['personas.memory'] = memoryUnit;
    units['state.evicted_context'] = evictedUnit;
  }

  return { units, warnings, skipped, state };
}

// ---------- 目标读写 ----------

function readJsonlIndex(target) {
  const index = { lines: [], legacyIds: new Set(), contentHashes: new Set(), sourceKeys: new Set() };
  let content = null;
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch {
    return index;
  }
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    index.lines.push(raw);
    let record = null;
    try {
      record = JSON.parse(raw);
    } catch {
      continue; // 用户手改坏的行原样保留，不做去重依据
    }
    if (!record || typeof record !== 'object') continue;
    if (typeof record.legacy_id === 'string' && record.legacy_id) index.legacyIds.add(record.legacy_id);
    if (typeof record.content === 'string') index.contentHashes.add(legacy.sha256Hex(record.content));
    if (typeof record.source_key === 'string' && record.source_key) index.sourceKeys.add(record.source_key);
  }
  return index;
}

function serialize(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

/**
 * 追加写（幂等）：按 legacy_id 差集 + 第二层去重键只补新行；覆盖前备份目标。
 * @returns {{added:number, written:boolean}}
 */
function appendRecords(ctx, target, records) {
  const index = readJsonlIndex(target);
  const added = [];
  for (const record of records) {
    if (record.legacy_id && index.legacyIds.has(record.legacy_id)) continue;
    if (record.kind === 'fact' && typeof record.content === 'string') {
      const hash = legacy.sha256Hex(record.content);
      if (index.contentHashes.has(hash)) continue;
    }
    if (record.kind === 'episode' && record.source_key && index.sourceKeys.has(record.source_key)) continue;
    added.push(record);
    if (record.legacy_id) index.legacyIds.add(record.legacy_id);
  }
  if (added.length === 0) return { added: 0, written: false };
  if (!ctx.options.apply) return { added: added.length, written: false };

  if (ctx.backup) report.backupFile(ctx.options.home, ctx.runId, target);
  const data = `${index.lines.concat(added.map((record) => JSON.stringify(record))).join('\n')}\n`;
  report.writeFilePrivate(target, data);
  return { added: added.length, written: true };
}

function mergePersonas(existing, entries) {
  const list = Array.isArray(existing && existing.personas) ? existing.personas.slice() : [];
  for (const entry of entries) {
    const index = list.findIndex((item) => item && item.id === entry.id);
    if (index >= 0) list[index] = { ...list[index], ...entry };
    else list.push(entry);
  }
  return { ...(existing || {}), personas: list };
}

function writeIfChanged(ctx, target, value) {
  const current = report.readJsonSafe(target, null);
  if (current && JSON.stringify(current) === JSON.stringify(value)) return false;
  if (ctx.backup) report.backupFile(ctx.options.home, ctx.runId, target);
  report.writeJsonPrivate(target, value);
  return true;
}

/**
 * 执行写入（只在 apply=true 时被调用）。
 * @returns {{units: object, files_written: number}}
 */
function apply(ctx, planResult) {
  const home = ctx.options.home;
  const memoryDir = path.join(home, 'memory');
  report.ensurePrivateDir(memoryDir);

  const result = { units: {}, files_written: 0 };
  const now = new Date().toISOString();

  // 1) personas.json
  if (planResult.state.personas) {
    const target = path.join(memoryDir, 'personas.json');
    const existing = report.readJsonSafe(target, null);
    const merged = mergePersonas(existing, planResult.state.personas);
    const written = writeIfChanged(ctx, target, merged);
    result.units['personas.manifest'] = {
      records_added: { personas: written ? planResult.state.personas.length : 0 },
      files_written: written ? 1 : 0,
      status: written ? 'applied' : 'unchanged',
    };
    if (written) result.files_written += 1;
  }

  const memoryAdded = { facts: 0, episodes: 0, revisions: 0 };
  let memoryFiles = 0;
  let memoryWritten = 0;
  const evictedAdded = { evicted: 0 };
  let evictedFiles = 0;
  let evictedWritten = 0;
  const skillsWritten = { count: 0 };

  for (const persona of planResult.state.memories) {
    const personaDir = path.join(memoryDir, persona.id);
    report.ensurePrivateDir(personaDir);

    if (persona.facts.length > 0) {
      const res = appendRecords(ctx, path.join(personaDir, 'facts.jsonl'), persona.facts);
      memoryAdded.facts += res.added;
      if (res.added > 0) memoryFiles += 1;
      if (res.written) memoryWritten += 1;
    }
    if (persona.episodes.length > 0) {
      const res = appendRecords(ctx, path.join(personaDir, 'episodes.jsonl'), persona.episodes);
      memoryAdded.episodes += res.added;
      if (res.added > 0) memoryFiles += 1;
      if (res.written) memoryWritten += 1;
    }
    if (persona.revisions.length > 0) {
      const res = appendRecords(ctx, path.join(personaDir, 'revisions.jsonl'), persona.revisions);
      memoryAdded.revisions += res.added;
      if (res.added > 0) memoryFiles += 1;
      if (res.written) memoryWritten += 1;
    }
    if (persona.evicted.records.length > 0) {
      const res = appendRecords(ctx, path.join(personaDir, 'evicted.jsonl'), persona.evicted.records);
      evictedAdded.evicted += res.added;
      if (res.added > 0) evictedFiles += 1;
      if (res.written) evictedWritten += 1;
    }
    if (persona.skills.length > 0) {
      // 只读索引：不进 JSONL，单独一份 skills.json（MEM7：记忆与身份不合并语义）。
      const target = path.join(personaDir, 'skills.json');
      const current = report.readJsonSafe(target, null);
      const unchanged =
        current &&
        current.source === 'legacy-v0.7' &&
        JSON.stringify(current.records) === JSON.stringify(persona.skills);
      if (!unchanged) {
        const value = {
          schema_version: 1,
          source: 'legacy-v0.7',
          updated_at: now,
          records: persona.skills,
        };
        if (writeIfChanged(ctx, target, value)) {
          skillsWritten.count += 1;
          memoryWritten += 1;
        }
      }
    }
  }

  // 2) 库级 meta.json：记 migrated_from.source_fingerprint（MG3）
  //    没有新记录且 meta 已存在时不动它 —— 幂等运行不该改写目标。
  const metaTarget = path.join(memoryDir, 'meta.json');
  const existingMetaRaw = report.readJsonSafe(metaTarget, null);
  const existingMeta = existingMetaRaw || {};
  const addedTotal =
    memoryAdded.facts + memoryAdded.episodes + memoryAdded.revisions + evictedAdded.evicted;
  const skipMeta = existingMetaRaw !== null && addedTotal === 0;
  const databaseId =
    typeof existingMeta.database_id === 'string' && existingMeta.database_id
      ? existingMeta.database_id
      : `mem-${crypto.randomBytes(8).toString('hex')}`;
  const meta = {
    ...existingMeta,
    schema_version: 1,
    database_id: databaseId,
    generation: (Number(existingMeta.generation) || 0) + 1,
    access_schema_version: 2,
    updated_at: now,
    migrated_from: {
      ...(existingMeta.migrated_from && typeof existingMeta.migrated_from === 'object'
        ? existingMeta.migrated_from
        : {}),
      source: 'gqy-home-v0.7',
      source_fingerprint: ctx.fingerprint,
      at: now,
      run_id: ctx.runId,
      ...(planResult.state.homeMarker ? { legacy_home_layout: planResult.state.homeMarker } : {}),
    },
  };
  const metaWritten = skipMeta ? false : writeIfChanged(ctx, metaTarget, meta);
  if (metaWritten) result.files_written += 1;

  result.units['personas.memory'] = {
    records_added: memoryAdded,
    files_written: memoryWritten,
    skills_index: skillsWritten.count,
    status: memoryWritten > 0 ? 'applied' : 'unchanged',
  };
  result.units['state.evicted_context'] = {
    records_added: evictedAdded,
    files_written: evictedWritten,
    status: evictedWritten > 0 ? 'applied' : 'unchanged',
  };
  result.files_written += memoryWritten + evictedWritten;
  return result;
}

module.exports = {
  SOURCE,
  parseToml,
  decodeEmbedding,
  jsonColumn,
  mapFact,
  mapEpisode,
  mapRevision,
  mapEvicted,
  readPersonaMemory,
  readPersonaEvicted,
  plan,
  apply,
  appendRecords,
  readJsonlIndex,
  mergePersonas,
};
