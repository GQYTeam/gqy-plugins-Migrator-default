#!/usr/bin/env node
// GQY 迁移器（一次性插件）：stdio 换行 JSON-RPC 2.0（gqy-jsonrpc-v1）。
//
// 生命周期（15 NX3/NX4）：initialize → call{action:"run"} → shutdown；stdin EOF 自退（最后一道防线）。
// 只做一件事：把旧版 GQY_HOME 导出迁到新数据根（MG1–MG8）。
'use strict';

const readline = require('node:readline');

const argsModule = require('./src/args');
const legacy = require('./src/legacy');
const memory = require('./src/memory');
const config = require('./src/config');
const assets = require('./src/assets');
const report = require('./src/report');

const PLUGIN = { id: 'migrator-default', name: 'migrator-default', version: '1.0.0' };

// 报告里 unit 的稳定顺序（缺的跳过），方便两次运行对比。
const UNIT_ORDER = [
  'layout.home_marker',
  'config.main',
  'config.imessage',
  'config.webui_theme',
  'config.webui_themes',
  'personas.manifest',
  'personas.memory',
  'state.evicted_context',
  'kb.default_state',
  'kb.meta',
  'kb.files',
  'data.prompts',
  'data.memes',
  'extensions.skills',
  'state.skill_drafts',
  'extensions.scripts',
  'home.identities',
  'state.profile',
  'state.usage',
  'state.repl_history',
  'state.arch_news',
  'state.imessage_contacts',
  'home.conversation',
  'home.pictures',
  'home.documents',
  'home.ledger',
  'platform.message_history',
];

function orderedUnits(units) {
  const out = {};
  for (const name of UNIT_ORDER) {
    if (units[name]) out[name] = units[name];
  }
  for (const [name, unit] of Object.entries(units)) {
    if (!out[name]) out[name] = unit;
  }
  return out;
}

function errorSummary(err) {
  if (!err) return '未知错误';
  const message = typeof err.message === 'string' ? err.message : String(err);
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * 规划所有 unit。规划阶段只读源、不写目标。
 * @param {{options: object, layout: object, fingerprint: string, runId: string}} ctx
 */
function planAll(ctx) {
  const merged = { units: {}, warnings: [], skipped: [], stages: [] };
  const stages = [
    { name: 'config', run: () => config.plan(ctx) },
    { name: 'memory', run: () => memory.plan(ctx) },
    { name: 'assets', run: () => assets.plan(ctx) },
  ];
  for (const stage of stages) {
    try {
      const result = stage.run();
      Object.assign(merged.units, result.units || {});
      if (Array.isArray(result.warnings)) merged.warnings.push(...result.warnings);
      if (Array.isArray(result.skipped)) merged.skipped.push(...result.skipped);
      merged.stages.push({ name: stage.name, result });
    } catch (err) {
      // MG6：单个 unit 失败不阻断其余——这里连整个 stage 挂了也只告警。
      merged.warnings.push(`${stage.name}: 规划阶段失败，已跳过（${errorSummary(err)}）`);
      merged.stages.push({ name: stage.name, result: null, error: errorSummary(err) });
    }
  }
  return merged;
}

function applyAll(ctx, planResult) {
  const failures = [];
  for (const stage of planResult.stages) {
    if (!stage.result) continue;
    const applier = { config: config.apply, memory: memory.apply, assets: assets.apply }[stage.name];
    if (typeof applier !== 'function') continue;
    try {
      const applied = applier(ctx, stage.result);
      for (const [unitName, patch] of Object.entries(applied.units || {})) {
        const unit = planResult.units[unitName];
        if (!unit) continue;
        if (patch.status) unit.status = patch.status;
        if (patch.error) {
          unit.status = 'failed';
          unit.error = patch.error;
        }
        for (const [key, value] of Object.entries(patch)) {
          if (key === 'status' || key === 'error') continue;
          if (key === 'records_added' && unit.records_added) unit.records_added = { ...unit.records_added, ...value };
          else unit[key] = value;
        }
      }
    } catch (err) {
      failures.push(stage.name);
      planResult.warnings.push(`${stage.name}: 写入阶段失败（${errorSummary(err)}）`);
    }
  }
  return failures;
}

/**
 * run 动作：一次迁移（默认 dry-run）。
 * @param {unknown} rawArgs
 */
function runMigration(rawArgs) {
  const started = Date.now();
  const options = argsModule.parseArgs(rawArgs);
  const layout = legacy.describeInput(options.input);
  const fingerprint = report.fingerprintFor(layout);
  const runId = report.newRunId(options.home);
  const ctx = { options, layout, fingerprint, runId };

  const planResult = planAll(ctx);
  const units = planResult.units;
  const warnings = planResult.warnings;
  const skipped = planResult.skipped.slice();

  if (options.apply) {
    applyAll(ctx, planResult);
  }

  const totals = report.summarize(units);
  const considered = Object.values(units).filter((unit) => unit && unit.reason !== 'not_selected');
  const failed = considered.filter((unit) => unit.status === 'failed');
  let exitCode = 0;
  if (failed.length > 0) exitCode = failed.length === considered.length ? 2 : 1;

  const durationMs = Date.now() - started;
  const reportBody = {
    schema_version: 1,
    run_id: runId,
    input: options.input,
    home: options.home,
    applied: options.apply,
    dry_run: !options.apply,
    source_fingerprint: fingerprint,
    gqy_version: layout.manifest ? layout.manifest.meta.gqy_version : '',
    units: orderedUnits(units),
    totals,
    warnings,
    skipped,
    duration_ms: durationMs,
    exit_code: exitCode,
  };
  const reportPath = report.writeReport(options.home, runId, reportBody, options.report);

  const output = {
    applied: options.apply,
    dry_run: !options.apply,
    input: options.input,
    home: options.home,
    kinds: options.kinds,
    run_id: runId,
    source_fingerprint: fingerprint,
    units: reportBody.units,
    totals,
    warnings,
    skipped,
    report_path: reportPath,
    exit_code: exitCode,
    duration_ms: durationMs,
  };
  if (options.unknown.length > 0) {
    output.warnings = output.warnings.concat([`忽略未知参数：${options.unknown.join(', ')}`]);
  }
  return { ok: exitCode === 0, output };
}

// ---------- JSON-RPC ----------

function writeLine(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  writeLine({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  writeLine({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    replyError(null, -32600, '非法请求');
    return;
  }
  const id = message.id === undefined ? null : message.id;
  const method = typeof message.method === 'string' ? message.method : '';

  if (method === 'initialize') {
    reply(id, {
      ok: true,
      name: PLUGIN.id,
      version: PLUGIN.version,
      mode: 'oneshot',
      actions: ['run'],
    });
    return;
  }

  if (method === 'call') {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const action = params.action;
    if (action !== 'run') {
      replyError(id, -32601, `未知动作：${String(action)}`);
      return;
    }
    try {
      const result = runMigration(params.arguments || {});
      reply(id, { content: JSON.stringify(result) });
    } catch (err) {
      if (err instanceof argsModule.UsageError) {
        replyError(id, -32602, errorSummary(err));
        return;
      }
      if (err instanceof legacy.LegacyError) {
        replyError(id, -32000, errorSummary(err));
        return;
      }
      replyError(id, -32000, `迁移失败：${errorSummary(err)}`);
    }
    return;
  }

  if (method === 'shutdown') {
    reply(id, { ok: true });
    process.exit(0);
  }

  replyError(id, -32601, `未知方法：${method}`);
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      replyError(null, -32700, '非法 JSON');
      return;
    }
    handleMessage(message);
  });

  // stdin EOF：跑完即退（04 P8 的最后一道防线）。
  rl.on('close', () => process.exit(0));

  process.on('uncaughtException', (err) => {
    replyError(null, -32000, `内部错误：${errorSummary(err)}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    replyError(null, -32000, `内部错误：${errorSummary(err)}`);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = { runMigration, handleMessage, UNIT_ORDER, PLUGIN };
