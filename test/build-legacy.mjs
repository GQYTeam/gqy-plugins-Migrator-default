// 运行期构造「最小旧版导出」的测试夹具。
//
// 这里没有任何提交进仓库的 fixture 文件，也没有真实用户数据：
// 所有库表、配置与文本都在测试运行时用 node:sqlite / fs 现造，测试结束即删
// （随 os.tmpdir 一起走，不进仓库）。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 假凭据：只用于验证「敏感键必被脱敏」，不是真实密钥（也不带真实密钥前缀）。
export const FAKE_PROVIDER_KEY = 'TESTONLYPROVIDERKEY-alpha-0001';
export const FAKE_QQ_TOKEN = 'TESTONLYQQTOKEN-0002';
export const FAKE_MINIMAX_KEY = 'TESTONLYMINIMAXKEY-0003';
export const FAKE_COOKIE = 'TESTONLYCOOKIE-0004';
export const FAKE_BEARER = 'Bearer TESTONLYBEARERTOKEN005';

export const LEGACY_USER = 'legacyuser';
export const LEGACY_HOST = 'legacyhost';

const FACT_ROWS = [
  {
    id: 1,
    content: '单元测试事实一',
    memory_type: 'preference',
    truth_status: 'accepted',
    importance: 4,
    subjects: '[{"name":"测试对象"}]',
    tags: '["测试标签"]',
    source_episode_ids: '[10,11]',
    origin_session_id: 'sess-1',
  },
  {
    id: 2,
    content: '单元测试事实二',
    memory_type: 'fact',
    truth_status: 'reported',
    importance: 3,
    subjects: '[]',
    tags: '[]',
    source_episode_ids: '[]',
    origin_session_id: '',
  },
];

const EPISODE_ROWS = [
  {
    id: 10,
    content: '单元测试片段一',
    retention: 'long_term',
    source_key: 'test:source-key-1',
    user_message: '你好',
    assistant_message: '你好呀',
    promotion_pending: 1,
  },
  {
    id: 11,
    content: '单元测试片段二',
    retention: 'short_term',
    source_key: '',
    user_message: '再见',
    assistant_message: '慢走',
    promotion_pending: 0,
  },
];

function float32Buffer(dim, seed) {
  const buffer = Buffer.alloc(dim * 4);
  for (let i = 0; i < dim; i += 1) buffer.writeFloatLE(((seed + i) % 7) / 10 + 0.01, i * 4);
  return buffer;
}

function int8Buffer(dim, seed) {
  const buffer = Buffer.alloc(dim);
  for (let i = 0; i < dim; i += 1) buffer[i] = (seed + i * 3) % 120;
  return buffer;
}

function createMemoryDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 1.0,
      strength REAL NOT NULL DEFAULT 1.0,
      recall_count INTEGER NOT NULL DEFAULT 0,
      last_recalled_at TEXT,
      last_decay_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'privileged',
      owner_principal TEXT NOT NULL DEFAULT '',
      owner_display_name TEXT NOT NULL DEFAULT '',
      subjects TEXT NOT NULL DEFAULT '[]',
      memory_type TEXT NOT NULL DEFAULT 'fact',
      truth_status TEXT NOT NULL DEFAULT 'reported',
      importance INTEGER NOT NULL DEFAULT 3,
      tags TEXT NOT NULL DEFAULT '[]',
      source_episode_ids TEXT NOT NULL DEFAULT '[]',
      origin_session_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'episode',
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 1.0,
      strength REAL NOT NULL DEFAULT 1.0,
      recall_count INTEGER NOT NULL DEFAULT 0,
      last_recalled_at TEXT,
      last_decay_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'privileged',
      owner_principal TEXT NOT NULL DEFAULT '',
      owner_display_name TEXT NOT NULL DEFAULT '',
      subjects TEXT NOT NULL DEFAULT '[]',
      memory_type TEXT NOT NULL DEFAULT 'fact',
      truth_status TEXT NOT NULL DEFAULT 'reported',
      importance INTEGER NOT NULL DEFAULT 3,
      tags TEXT NOT NULL DEFAULT '[]',
      source_episode_ids TEXT NOT NULL DEFAULT '[]',
      origin_session_id TEXT NOT NULL DEFAULT '',
      retention TEXT NOT NULL DEFAULT 'long_term',
      user_message TEXT NOT NULL DEFAULT '',
      assistant_message TEXT NOT NULL DEFAULT '',
      expires_at TEXT,
      consolidated_at TEXT,
      promotion_pending INTEGER NOT NULL DEFAULT 0,
      promoted_at TEXT,
      source_key TEXT NOT NULL DEFAULT '',
      origin_kind TEXT NOT NULL DEFAULT '',
      origin_platform TEXT NOT NULL DEFAULT '',
      origin_account_id TEXT NOT NULL DEFAULT '',
      origin_conversation_kind TEXT NOT NULL DEFAULT '',
      origin_conversation_id TEXT NOT NULL DEFAULT '',
      origin_sender_id TEXT NOT NULL DEFAULT '',
      origin_sender_display_name TEXT NOT NULL DEFAULT '',
      origin_message_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE pending_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_message TEXT NOT NULL,
      assistant_message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      origin_session_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE memory_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id INTEGER NOT NULL,
      old_content TEXT NOT NULL,
      new_content TEXT NOT NULL,
      source_episode_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE memory_meta (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      generation INTEGER NOT NULL DEFAULT 0,
      database_id TEXT NOT NULL DEFAULT '',
      access_schema_version INTEGER NOT NULL DEFAULT 2
    );
    CREATE TABLE memory_embeddings (
      kind TEXT NOT NULL,
      id INTEGER NOT NULL,
      model TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE TABLE skill_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const insertFact = db.prepare(`INSERT INTO facts
    (id, content, created_at, updated_at, subjects, tags, source_episode_ids, memory_type, truth_status, importance, origin_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of FACT_ROWS) {
    insertFact.run(
      row.id,
      row.content,
      '2026-01-01T00:00:00+08:00',
      '2026-01-02T00:00:00+08:00',
      row.subjects,
      row.tags,
      row.source_episode_ids,
      row.memory_type,
      row.truth_status,
      row.importance,
      row.origin_session_id,
    );
  }

  const insertEpisode = db.prepare(`INSERT INTO episodes
    (id, content, created_at, updated_at, retention, source_key, user_message, assistant_message, promotion_pending)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of EPISODE_ROWS) {
    insertEpisode.run(
      row.id,
      row.content,
      '2026-01-03T00:00:00+08:00',
      '2026-01-03T00:00:00+08:00',
      row.retention,
      row.source_key,
      row.user_message,
      row.assistant_message,
      row.promotion_pending,
    );
  }

  db.prepare(`INSERT INTO memory_revisions (id, memory_id, old_content, new_content, created_at)
    VALUES (1, 1, '旧内容', '新内容', '2026-01-04T00:00:00+08:00')`).run();
  db.prepare(`INSERT INTO memory_meta (id, generation, database_id, access_schema_version) VALUES (1, 3, 'mem-testdb', 2)`).run();
  db.prepare(`INSERT INTO skill_records (id, name, path, summary, created_at, updated_at)
    VALUES (1, 'demo-skill', 'skills/demo/SKILL.md', '演示技能', '2026-01-05T00:00:00+08:00', '2026-01-05T00:00:00+08:00')`).run();

  // 向量陷阱：model 名写 int8，实际是 2048B = 512 维 float32；编码必须按长度判断。
  const insertEmbedding = db.prepare(`INSERT INTO memory_embeddings
    (kind, id, model, content_sha256, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  insertEmbedding.run('fact', 1, 'local:bge-small-zh-v1.5-int8', '', float32Buffer(512, 1), '2026-01-01T00:00:00Z');
  insertEmbedding.run('episode', 10, 'local:bge-small-zh-v1.5-int8', '', int8Buffer(512, 2), '2026-01-01T00:00:00Z');
  // 挂不上的向量：算 orphan_vectors
  insertEmbedding.run('episode', 999, 'local:bge-small-zh-v1.5-int8', '', int8Buffer(512, 3), '2026-01-01T00:00:00Z');
  // 已处理的 pending 不迁；未处理的迁成 short_term 片段。
  db.prepare(`INSERT INTO pending_events (user_message, assistant_message, created_at, processed_at)
    VALUES ('待处理问题', '待处理回答', '2026-01-06T00:00:00+08:00', NULL)`).run();
  db.prepare(`INSERT INTO pending_events (user_message, assistant_message, created_at, processed_at)
    VALUES ('已处理问题', '已处理回答', '2026-01-06T00:00:00+08:00', '2026-01-07T00:00:00+08:00')`).run();
  db.close();
}

function createEvictedDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE evicted_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT,
      timestamp TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'privileged',
      owner_principal TEXT NOT NULL DEFAULT '',
      owner_display_name TEXT NOT NULL DEFAULT '',
      origin_session_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE evicted_embeddings (
      id INTEGER PRIMARY KEY,
      model TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      embedding BLOB
    );
  `);
  db.prepare(`INSERT INTO evicted_turns (id, source_id, timestamp, role, content, created_at, origin_session_id)
    VALUES (1, 'src-1', '2026-02-01T00:00:00+08:00', 'user', '被挤出的原始轮次', '2026-02-01T00:00:00+08:00', 'sess-9')`).run();
  db.prepare(`INSERT INTO evicted_embeddings (id, model, embedding_json, created_at, embedding)
    VALUES (1, 'local:bge-small-zh-v1.5-int8', '', '2026-02-01T00:00:00Z', ?)`).run(float32Buffer(512, 4));
  // 孤儿向量：没有对应 evicted_turns
  db.prepare(`INSERT INTO evicted_embeddings (id, model, embedding_json, created_at, embedding)
    VALUES (2, 'local:bge-small-zh-v1.5-int8', '', '2026-02-01T00:00:00Z', ?)`).run(int8Buffer(512, 5));
  db.close();
}

/** 旧版 config.jsonc 文本：含 // 注释、块注释、尾逗号、URL 里的 //。 */
export function legacyConfigText() {
  return `{
  // 旧版配置（测试构造）
  "config_version": 3,
  "active_provider": "alpha",
  "active_provider_models": [{"provider_id": "alpha", "model": "alpha-model-1"}],
  "providers": [
    {
      "id": "alpha",
      "display_name": "Alpha",
      "base_url": "https://api.alpha.test/v1/",
      "protocol": "openai-chat",
      "models": ["alpha-model-1"],
      "default_model": "alpha-model-1",
      "api_key": "${FAKE_PROVIDER_KEY}",
    },
    {
      "id": "beta",
      "display_name": "Beta",
      "base_url": "https://api.beta.test/v1",
      "protocol": "anthropic",
      "models": ["beta-model-1"],
      "api_key": "",
    },
    {
      "id": "cli-agent",
      "display_name": "CLI Agent",
      "base_url": "http://127.0.0.1:9999/v1",
      "protocol": "claude-code",
      "models": ["x"],
    },
    {
      "id": "no-base-url",
      "display_name": "No Base URL",
      "base_url": "",
      "protocol": "openai-chat",
      "models": ["m"],
    },
    /* 注释块：无模型的 provider 新版会拒收 */
    {"id": "no-models", "base_url": "https://api.nomodels.test/v1", "protocol": "openai-chat"}
  ],
  "context": {"default_context_window": 128000, "trim_at_ratio": 0.8, "on_overflow": "compact"},
  "tools": {"default_timeout_secs": 45, "max_rounds": 12, "command_deny": ["rm -rf"]},
  "model_tiers": {
    "standard": [{"provider_id": "alpha", "model": "alpha-model-1"}],
    "roles": {"session_title": "alpha-model-1"},
  },
  "prompt": {"prompts_dir": "prompts", "identities_dir": "identities"},
  "system_prompt_file": "system-prompt.md",
  "platforms": {
    "qq": {"enabled": true, "access_token": "${FAKE_QQ_TOKEN}"},
    "connectors": {"imessage": {"enabled": true, "token": "${FAKE_QQ_TOKEN}"}},
  },
  "voice": {"enabled": false, "tts": {"minimax": {"api_key": "${FAKE_MINIMAX_KEY}"}}},
  "mcp": {"enabled": true, "servers": [{"name": "demo", "env": {"NETEASE_COOKIE": "${FAKE_COOKIE}", "PLAIN_VAR": "ok"}}]},
  "plugins": {"api_quota": {"alpha": {"accounts": [{"id": "account-1", "name": "主账号", "api_key": "${FAKE_PROVIDER_KEY}"}]}}},
  "authorization_hint": "${FAKE_BEARER}",
}
`;
}

/**
 * 在 os.tmpdir 下造一份最小旧版导出。
 * @param {{withMissingPersona?: boolean}} [options]
 */
export function buildLegacyExport(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gqy-migrator-test-'));
  const homeRoot = path.join(root, 'home');
  const configDir = path.join(homeRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  fs.writeFileSync(path.join(homeRoot, '.home-layout-v1'), 'legacyhost\n');
  fs.writeFileSync(path.join(configDir, 'config.jsonc'), legacyConfigText());
  fs.writeFileSync(path.join(configDir, 'imessage.json'), JSON.stringify({ enabled: true, token: FAKE_QQ_TOKEN }));

  const personaDir = path.join(homeRoot, LEGACY_USER, 'default');
  fs.mkdirSync(path.join(personaDir, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(personaDir, 'persona.toml'),
    '[subsystems]\nmemory = true\nskills = true\nvoice = false\n\n[plugins]\nskills = []\n',
  );
  createMemoryDb(path.join(personaDir, 'memory', 'memory.db'));

  const evictedDir = path.join(homeRoot, 'state', LEGACY_USER, 'default', 'memory');
  fs.mkdirSync(evictedDir, { recursive: true });
  createEvictedDb(path.join(evictedDir, 'evicted_context.db'));

  // 资产：小文件即可
  const files = {
    'data/default-kb/state.json': '{"release_hash":"test"}\n',
    'data/prompts/system-prompt.md': '# 系统提示（测试）\n',
    'data/prompts/hints/default.md': 'hint\n',
    'data/memes/demo/index.json': '{"memes":[]}\n',
    'extensions/skills/demo/SKILL.md': '# demo skill\n',
    'extensions/scripts/legacyuser/default/index.json': '{"scripts":[]}\n',
    'extensions/scripts/legacyuser/default/demo.py': 'print("demo")\n',
    'state/skill-drafts/draft-1/draft.json': '{"id":"draft-1"}\n',
    'state/profile.md': '# 个人档案（测试）\n',
    'state/usage.json': '{"requests":1}\n',
    'state/repl-history.jsonl': '{"line":1}\n',
    'state/arch_news_last_seen.json': '{"seen":"x"}\n',
    'state/imessage-contacts.json': '{"contacts":[]}\n',
    'config/webui-theme.css': ':root{--a:1}\n',
    'config/webui-themes/selene.css': ':root{--b:2}\n',
    [`home/${LEGACY_HOST}/identities/Test Cat.md`]: '# Test Cat\n',
    [`home/${LEGACY_HOST}/ledger/ledger.db`]: 'not-a-real-db\n',
    [`home/${LEGACY_HOST}/pictures/album/default/p.png`]: 'png-bytes\n',
    [`home/${LEGACY_HOST}/documents/doc.md`]: '# 文档\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(homeRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }

  // kb_meta.db：kb.meta 的源（表结构 + 一行绝对路径）
  const kbDir = path.join(homeRoot, 'data', 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  const kbDb = new DatabaseSync(path.join(kbDir, 'kb_meta.db'));
  kbDb.exec(`CREATE TABLE files (
    name TEXT PRIMARY KEY, path TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    mtime REAL NOT NULL, content_sha256 TEXT NOT NULL, updated_at REAL NOT NULL);
    INSERT INTO files VALUES ('demo/kb/x.md', '/Users/legacyuser/.gqy/data/kb/files/demo/kb/x.md', 12, 1.5, 'abc', 2.5);
    INSERT INTO files VALUES ('demo/kb/y.md', '/opt/outside/y.md', 20, 1.5, 'def', 2.5);`);
  kbDb.close();

  // conversation.db：archive 组的 best-effort 源
  const convDb = new DatabaseSync(path.join(homeRoot, 'home', LEGACY_HOST, 'conversation.db'));
  convDb.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, persona TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0, owner TEXT NOT NULL DEFAULT '');
    CREATE TABLE turns (
      turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
      user_content TEXT NOT NULL, user_timestamp TEXT NOT NULL,
      assistant_content TEXT NOT NULL, assistant_timestamp TEXT, status TEXT NOT NULL DEFAULT 'running',
      hidden INTEGER NOT NULL DEFAULT 0, is_summary INTEGER NOT NULL DEFAULT 0,
      display_content TEXT NOT NULL DEFAULT '', token_total INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE artifact_assets (
      asset_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, tool_id TEXT,
      source_key TEXT NOT NULL, file_name TEXT NOT NULL, mime TEXT NOT NULL,
      kind TEXT NOT NULL, size_bytes INTEGER NOT NULL, data BLOB NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  convDb.prepare(`INSERT INTO sessions VALUES ('sess-1','default','测试会话','user',
    '2026-03-01T00:00:00+08:00','2026-03-01T01:00:00+08:00',0,'')`).run();
  convDb.prepare(`INSERT INTO turns (turn_id, session_id, seq, user_content, user_timestamp,
    assistant_content, assistant_timestamp, status, display_content, token_total)
    VALUES ('turn-1','sess-1',1,'问','2026-03-01T00:00:00+08:00','答','2026-03-01T00:00:01+08:00','ok','纯文本展示',10)`).run();
  convDb.prepare(`INSERT INTO turns (turn_id, session_id, seq, user_content, user_timestamp,
    assistant_content, status, display_content)
    VALUES ('turn-2','sess-1',2,'问2',1700000000,'答2','ok','42')`).run();
  convDb.prepare(`INSERT INTO artifact_assets VALUES ('asset-1','turn-1','tool',
    '/Users/legacyuser/.gqy/home/legacyhost/documents/doc.md','doc.md','text/markdown','markdown',
    8, ?, '2026-03-01T00:00:00+08:00','2026-03-01T00:00:00+08:00')`).run(Buffer.from('doc-bytes'));
  convDb.close();

  // 导出清单：声明 2 个记忆库，其中 1 个磁盘上不存在（记 missing）
  const entries = [
    { unit: 'personas.memory', path: `${LEGACY_USER}/default/memory/memory.db`, size: 1, blake3: 'a'.repeat(64) },
    { unit: 'personas.memory', path: `${LEGACY_USER}/ghost/memory/memory.db`, size: 1, blake3: 'b'.repeat(64) },
    { unit: 'config.main', path: 'config/config.jsonc', size: 1, blake3: 'c'.repeat(64) },
  ];
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify(
      {
        format_version: 1,
        gqy_version: '0.7.0-test',
        exported_at: '2026-01-01T00:00:00+08:00',
        config_version: 3,
        schema_versions: {},
        scope: { index: false, platforms: true },
        secrets_included: true,
        entries,
      },
      null,
      2,
    ),
  );

  return { root, homeRoot, input: root, personaDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** 新 home（测试目标），测试结束删除。 */
export function makeTargetHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gqy-home-test-'));
  return { home: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 读 JSONL 并返回解析后的记录。 */
export function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
