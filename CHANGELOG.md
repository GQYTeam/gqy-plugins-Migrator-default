# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 无。

## [1.0.0] - 2026-11-02

### Added

- 一次性插件形态：`manifest.json`（`mode=oneshot`、`protocol=gqy-jsonrpc-v1`、单个 `run` 动作）+ `index.js` 换行 JSON-RPC 主循环（`initialize` / `call` / `shutdown`，stdin EOF 自退）。
- `src/args.js`：`input` / `home` / `apply` / `kinds` / `persona` / `include_secrets` / `no_backup` / `report` 的参数校验与默认值；`kinds` 兼容人格 id 旧写法。
- `src/legacy.js`：旧版导出发现（账号目录 / 人格库 / evicted 库 / 宿主目录）、`node:sqlite` 只读打开（`readOnly` + `PRAGMA query_only=1` 双保险）、符号链接拒绝、绝对路径重写。
- `src/memory.js`：facts / episodes / revisions / evicted / pending_events / skill_records / memory_embeddings 映射成新版 JSONL；向量编码按 BLOB 长度判断（int8 / float32）；`legacy_id` 差集幂等；`memory/meta.json` 记 `migrated_from.source_fingerprint`；`memory/personas.json` 与 `memory/<persona>/skills.json`。
- `src/config.js`：JSONC 解析（注释、尾逗号、字符串里的 `//`）、`providers.json` / `routing.json` / `settings.json` 三文件生成、14 项凭据默认脱敏为 env 引用、旧 provider 能力降级显式计数。
- `src/assets.js`：kb / prompts / memes / skills / scripts / identities / usage 资产复制；archive 组（conversation.db best-effort、pictures、documents、ledger、平台消息）默认只报体积；`kb_meta.db` → `kb/meta.json` 并重写绝对路径。
- `src/report.js`：报告与指纹、原子写（临时文件 + rename）、`0600/0700` 权限、覆盖前备份到 `.migrate-backup/<run_id>/`。
- 测试四组（`test/args.test.mjs`、`memory.test.mjs`、`config.test.mjs`、`idempotent.test.mjs`）：运行期用 `node:sqlite` 造最小旧库 / 旧配置，不提交任何 fixture 或真实数据。
- 仓库标准基线：`LICENSE`（PolyForm Noncommercial 1.0.0）、`NOTICE`、`CONTRIBUTING.md`、`SECURITY.md`、`.editorconfig`、`.gitignore`、`Makefile`、`.github/`（CI、Issue / PR 模板、dependabot）。

### Changed

- 无。

### Fixed

- 无。

### 验收数据

对真实旧版导出（v0.7.0，397 MB）实测：`facts=347`、`episodes=2054`、`revisions=47`、`evicted=0`；向量 `orphan_vectors=946`（episode 630 + evicted 192 口径分开计）、`missing_vectors=316`；缺失人格库 3 个；脱敏 14 项。dry-run `applied=false`；apply 到临时 `$GQY_HOME` 后 JSONL 行数一致；二次 apply `records_added=0`。
