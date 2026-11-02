// 记忆映射与幂等（src/memory.js）：运行期造最小旧库，跑真实代码路径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = require('../src/args');
const legacy = require('../src/legacy');
const memory = require('../src/memory');
const report = require('../src/report');

const { buildLegacyExport, makeTargetHome, readJsonl } = await import('./build-legacy.mjs');

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

test('memory: plan 读出旧库计数与向量挂载', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const ctx = makeCtx(fixture.input, target.home);
    const result = memory.plan(ctx);
    const unit = result.units['personas.memory'];
    const evictedUnit = result.units['state.evicted_context'];

    assert.equal(unit.records.facts, 2);
    // 2 条 episodes + 1 条未处理 pending_events（已处理的跳过）
    assert.equal(unit.records.episodes, 3);
    assert.equal(unit.records.revisions, 1);
    assert.equal(unit.records.embeddings, 2);
    assert.equal(unit.orphan_vectors, 1);
    // fact 2 / episode 11 / pending 片段都没有向量
    assert.equal(unit.missing_vectors, 3);
    // 清单声明 2 个记忆库，磁盘只有 1 个
    assert.equal(unit.missing, 1);
    assert.equal(unit.status, 'planned');

    assert.equal(evictedUnit.records.evicted, 1);
    assert.equal(evictedUnit.orphan_vectors, 1);

    const persona = result.state.memories[0];
    assert.equal(persona.id, 'default');
    assert.equal(result.state.personas[0].subsystems.memory, true);
    assert.equal(result.state.personas[0].subsystems.voice, false);
    assert.deepEqual(result.state.personas[0].plugins, { skills: [] });
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

test('memory: 字段映射（列形状、legacy_id、source）', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const ctx = makeCtx(fixture.input, target.home);
    const result = memory.plan(ctx);
    const facts = result.state.memories[0].facts;
    const episodes = result.state.memories[0].episodes;

    assert.equal(facts[0].id, 1);
    assert.equal(facts[0].legacy_id, 'legacy:facts:1');
    assert.equal(facts[0].kind, 'fact');
    assert.equal(facts[0].source, 'migration:legacy-0.7');
    assert.equal(facts[0].memory_type, 'preference');
    assert.equal(facts[0].truth_status, 'accepted');
    assert.equal(facts[0].importance, 4);
    // subjects 是对象数组、tags 是字符串数组、source_episode_ids 是整数数组
    assert.deepEqual(facts[0].subjects, [{ name: '测试对象' }]);
    assert.deepEqual(facts[0].tags, ['测试标签']);
    assert.deepEqual(facts[0].source_episode_ids, [10, 11]);
    assert.deepEqual(facts[1].subjects, []);

    assert.equal(episodes[0].legacy_id, 'legacy:episodes:10');
    assert.equal(episodes[0].retention, 'long_term');
    assert.equal(episodes[0].promotion_pending, true);
    assert.equal(episodes[0].source_key, 'test:source-key-1');
    // pending_events 迁成短期片段，id 接在旧 episodes 之后，legacy_id 保留原始主键
    const pending = episodes.find((item) => item.legacy_id === 'legacy:pending_events:1');
    assert.ok(pending, '未处理的 pending_events 应迁成 episode');
    assert.equal(pending.retention, 'short_term');
    assert.equal(pending.user_message, '待处理问题');

    const revisions = result.state.memories[0].revisions;
    assert.equal(revisions[0].legacy_id, 'legacy:memory_revisions:1');
    assert.equal(revisions[0].memory_id, 1);
    assert.equal(revisions[0].kind, 'revision');

    const evicted = result.state.memories[0].evicted.records;
    assert.equal(evicted[0].legacy_id, 'legacy:evicted_turns:1');
    assert.equal(evicted[0].role, 'user');
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

test('memory: 向量编码按 BLOB 长度判断，不信 model 名', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const ctx = makeCtx(fixture.input, target.home);
    const result = memory.plan(ctx);
    const persona = result.state.memories[0];

    // fact 1：2048B 且 model 名写 int8 —— 实际 512 维 float32
    const factVector = persona.facts[0].embedding;
    assert.equal(factVector.encoding, 'float32');
    assert.equal(factVector.dim, 512);
    assert.equal(Buffer.from(factVector.data, 'base64').length, 2048);
    // episode 10：512B = 512 维 int8
    const episodeVector = persona.episodes.find((item) => item.id === 10).embedding;
    assert.equal(episodeVector.encoding, 'int8');
    assert.equal(episodeVector.dim, 512);
    assert.equal(Buffer.from(episodeVector.data, 'base64').length, 512);
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

test('memory: apply 落盘 JSONL、meta.json、personas.json，权限 0600/0700', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const ctx = makeCtx(fixture.input, target.home, { apply: true });
    const planned = memory.plan(ctx);
    const applied = memory.apply(ctx, planned);

    assert.deepEqual(applied.units['personas.memory'].records_added, {
      facts: 2,
      episodes: 3,
      revisions: 1,
    });
    assert.equal(applied.units['state.evicted_context'].records_added.evicted, 1);

    const personaDir = path.join(target.home, 'memory', 'default');
    assert.equal(readJsonl(path.join(personaDir, 'facts.jsonl')).length, 2);
    assert.equal(readJsonl(path.join(personaDir, 'episodes.jsonl')).length, 3);
    assert.equal(readJsonl(path.join(personaDir, 'revisions.jsonl')).length, 1);
    assert.equal(readJsonl(path.join(personaDir, 'evicted.jsonl')).length, 1);
    // 旧库 skill_records 写只读索引，不进 JSONL
    const skills = report.readJsonSafe(path.join(personaDir, 'skills.json'), null);
    assert.equal(skills.records.length, 1);
    assert.equal(skills.records[0].name, 'demo-skill');

    const meta = report.readJsonSafe(path.join(target.home, 'memory', 'meta.json'), null);
    assert.equal(meta.schema_version, 1);
    assert.equal(meta.access_schema_version, 2);
    assert.match(meta.database_id, /^mem-[0-9a-f]{16}$/);
    assert.equal(meta.migrated_from.source, 'gqy-home-v0.7');
    assert.equal(meta.migrated_from.source_fingerprint, ctx.fingerprint);
    assert.equal(meta.migrated_from.legacy_home_layout, 'legacyhost');

    const personas = report.readJsonSafe(path.join(target.home, 'memory', 'personas.json'), null);
    assert.equal(personas.personas.length, 1);
    assert.equal(personas.personas[0].id, 'default');
    assert.equal(personas.personas[0].source, 'legacy');

    const factsStat = fs.statSync(path.join(personaDir, 'facts.jsonl'));
    assert.equal(factsStat.mode & 0o777, 0o600);
    const dirStat = fs.statSync(personaDir);
    assert.equal(dirStat.mode & 0o777, 0o700);
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

test('memory: 二次 apply 的 records_added 全为 0（幂等）', () => {
  const fixture = buildLegacyExport();
  const target = makeTargetHome();
  try {
    const first = makeCtx(fixture.input, target.home, { apply: true });
    const firstPlan = memory.plan(first);
    const firstApplied = memory.apply(first, firstPlan);
    assert.equal(firstApplied.units['personas.memory'].records_added.facts, 2);

    const factsBefore = fs.readFileSync(path.join(target.home, 'memory', 'default', 'facts.jsonl'), 'utf8');
    const metaBefore = report.readJsonSafe(path.join(target.home, 'memory', 'meta.json'), null);

    const second = makeCtx(fixture.input, target.home, { apply: true });
    const secondPlan = memory.plan(second);
    const secondApplied = memory.apply(second, secondPlan);

    assert.deepEqual(secondApplied.units['personas.memory'].records_added, {
      facts: 0,
      episodes: 0,
      revisions: 0,
    });
    assert.equal(secondApplied.units['state.evicted_context'].records_added.evicted, 0);
    assert.equal(secondApplied.units['personas.manifest'].records_added.personas, 0);

    const factsAfter = fs.readFileSync(path.join(target.home, 'memory', 'default', 'facts.jsonl'), 'utf8');
    assert.equal(factsAfter, factsBefore);
    const metaAfter = report.readJsonSafe(path.join(target.home, 'memory', 'meta.json'), null);
    assert.equal(metaAfter.database_id, metaBefore.database_id);
    assert.equal(metaAfter.migrated_from.source_fingerprint, metaBefore.migrated_from.source_fingerprint);
    // 没有新记录就不改写目标（幂等运行不产生副作用）
    assert.equal(metaAfter.generation, metaBefore.generation);
  } finally {
    fixture.cleanup();
    target.cleanup();
  }
});

test('memory: 源库只读打开，写入源库会失败', () => {
  const fixture = buildLegacyExport();
  try {
    const sourceDb = path.join(fixture.personaDir, 'memory', 'memory.db');
    const before = fs.statSync(sourceDb);
    const db = legacy.openReadOnly(sourceDb);
    try {
      assert.throws(() => db.prepare('DELETE FROM facts').run(), /readonly|read-only|readonly database/i);
    } finally {
      legacy.closeQuietly(db);
    }
    const after = fs.statSync(sourceDb);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    fixture.cleanup();
  }
});
