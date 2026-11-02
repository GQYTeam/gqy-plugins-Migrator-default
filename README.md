# gqy-plugins-Migrator-default

GQY 的**迁移器**：把旧版 GQY v0.7.0 的 `GQY_HOME` 导出（`manifest.json` + `home/`）迁到新版数据根。做成**一次性插件**（`mode: "oneshot"`），用现成的 `gqy run` 内核执行：跑一次、跑完即清理，常驻二进制里不放迁移代码。

- **默认 dry-run**：不带 `apply` 只出报告（迁移计划），不写目标。
- **幂等**：新记录带 `legacy_id`，重跑只补差集；没有新记录时目标一个字节都不改。
- **默认脱敏**：`api_key` / token / cookie 一律不迁明文，改写为 env 引用；报告里永不出现明文。
- **只读源**：旧库 `readOnly: true` + `PRAGMA query_only=1` 双保险；拿不到只读能力直接失败，不降级成可写。
- **零依赖**：只用 Node 内置模块；读旧 SQLite 库用 `node:sqlite`（Node ≥ 22.5）。

## 怎么跑

```bash
# 1) dry-run（默认）：只出报告，不写目标
gqy run ./gqy-plugins-Migrator-default --args '{"input":"/path/to/backup"}'

# 2) 真正写入（目标 $GQY_HOME 由参数或环境变量给）
gqy run ./gqy-plugins-Migrator-default \
  --args '{"input":"/path/to/backup","home":"/tmp/gqy-home","apply":true}'

# 3) 只迁记忆与人格清单
gqy run ./gqy-plugins-Migrator-default \
  --args '{"input":"/path/to/backup","apply":true,"kinds":["personas","memory"]}'

# 4) 迁大媒体（默认不动：conversation.db / pictures / documents / ledger / 平台消息）
gqy run ./gqy-plugins-Migrator-default \
  --args '{"input":"/path/to/backup","apply":true,"kinds":["archive"]}'
```

本仓库零依赖，直接跑也行（stdio 换行 JSON-RPC）：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \
  '{"jsonrpc":"2.0","id":1,"method":"call","params":{"action":"run","arguments":{"input":"/path/to/backup"}}}' \
  '{"jsonrpc":"2.0","id":1,"method":"shutdown"}' | node index.js
```

`stdout` 一行结果是 `{"ok":true,"output":{"applied":false,"units":{…},"warnings":[…],"report_path":"…"}}`（结果在 JSON-RPC 的 `result.content` 里，是一段 JSON 字符串）。

## `run` 动作参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `input` | string | **必填** | 旧版导出目录（含 `manifest.json` 与 `home/`） |
| `home` | string | `$GQY_HOME` → `~/.gqy` | 目标数据根 |
| `apply` | boolean | `false` | 只有 `true` 才写目标；否则 dry-run |
| `kinds` | string[] | 除 `archive` 外的全部 | 单元组：`config` / `personas` / `memory` / `kb` / `prompts` / `memes` / `skills` / `scripts` / `identities` / `usage` / `archive` |
| `persona` | string | 全部 | 只迁某个人格库（`^[a-z0-9][a-z0-9_-]{0,31}$`） |
| `include_secrets` | boolean | `false` | 迁明文凭据（目标文件仍是 `0600`，报告仍不出现明文） |
| `no_backup` | boolean | `false` | 跳过覆盖前备份 |
| `report` | string | `$GQY_HOME/.migrate-reports/<run_id>.json` | 报告输出路径 |

`kinds` 里也接受人格 id（兼容旧写法，等价于 `persona`）。

## 迁什么、迁到哪

| unit | 旧路径 | 新位置 | 组 |
| --- | --- | --- | --- |
| `layout.home_marker` | `.home-layout-v1` | `$GQY_HOME/.home-layout-v1`（写 `gqy-1`，旧值进 `memory/meta.json`） | config |
| `config.main` | `config/config.jsonc` | `providers.json` + `routing.json` + `settings.json`（脱敏） | config |
| `config.imessage` | `config/imessage.json` | `settings.json` 的 `platforms.imessage` | config |
| `config.webui_theme(s)` | `config/webui-theme*.css` | `themes/*.css` | config |
| `personas.manifest` | `<user>/<persona>/persona.toml` | `memory/personas.json` | personas |
| `personas.memory` | `<user>/<persona>/memory/memory.db` | `memory/<persona>/{facts,episodes,revisions}.jsonl` + `skills.json` | memory |
| `state.evicted_context` | `state/<user>/<persona>/memory/evicted_context.db` | `memory/<persona>/evicted.jsonl` | memory |
| `kb.*` | `data/default-kb/`、`data/kb/` | `kb/`（`kb_meta.db` → `kb/meta.json`，路径重写） | kb |
| `data.prompts` | `data/prompts/**` | `prompts/**` | prompts |
| `data.memes` | `data/memes/**` | `memes/**` | memes |
| `extensions.skills` / `state.skill_drafts` | `extensions/skills/**`、`state/skill-drafts/**` | `skills/**`、`skills/drafts/**` | skills |
| `extensions.scripts` | `extensions/scripts/**` | `scripts/**` | scripts |
| `home.identities` / `state.profile` | `home/<host>/identities/*.md`、`state/profile.md` | `identities/*.md`、`profile.md` | identities |
| `state.usage` / `state.repl_history` / `state.arch_news` / `state.imessage_contacts` | `state/*` | `state/*` | usage |
| `home.conversation` | `home/<host>/conversation.db` | `sessions/<session>/…`（best-effort） | archive |
| `home.pictures` / `home.documents` / `home.ledger` / `platform.message_history` | `home/<host>/**`、`data/platforms/**` | `data/**` | archive |

`<persona>` 与旧版人格目录同名（不合法字符归一成 `-`，重名加序号），默认 `default`。
符号链接一律拒绝（`lstat` 判断），系统垃圾（`.DS_Store` 等）跳过并计数。

## 报告

每次运行都写 `$GQY_HOME/.migrate-reports/<run_id>.json`（`--report` 可覆盖）。报告只有计数、路径、告警与指纹：

```json
{
  "schema_version": 1,
  "run_id": "20261102T220125",
  "input": "/path/to/backup",
  "home": "/tmp/gqy-home",
  "applied": false,
  "dry_run": true,
  "source_fingerprint": "sha256:…",
  "units": {
    "personas.memory": {
      "status": "planned",
      "files": 1,
      "bytes": 17313792,
      "records": {"facts": 347, "episodes": 2054, "revisions": 47, "embeddings": 2085},
      "source_embeddings": 3031,
      "orphan_vectors": 946,
      "missing_vectors": 316,
      "vector_surplus": 630,
      "missing": 3
    }
  },
  "totals": {"records": 2448, "files": 66, "redacted": 14, "…": "…"},
  "warnings": ["…"],
  "skipped": [],
  "duration_ms": 230,
  "exit_code": 0
}
```

**报告不含正文与密钥**，也不含旧库账号目录名与人格 id：只保留计数、输入/目标路径与告警。

`exit_code`：`0` 全部成功，`1` 部分 unit 失败，`2` 全部失败（单个 unit 失败不阻断其余）。

## 真实备份的验收数据

对真实旧版导出（v0.7.0，397 MB）实测：

| 指标 | 值 |
| --- | --- |
| `facts` / `episodes` / `revisions` | 347 / 2054 / 47 |
| `evicted_turns` | 0（`evicted_embeddings` 192 条全是孤儿） |
| 可挂载向量 / 源向量 | 2085 / 3031 |
| `orphan_vectors`（挂不上任何记录） | 946 |
| `missing_vectors`（记录缺向量） | 316 |
| `vector_surplus`（向量条数 − 片段条数，文档口径） | 630 |
| 缺失的人格记忆库（清单声明 4 个，磁盘 1 个） | 3 |
| 脱敏凭据 | 14 |
| dry-run 新增记录 / apply 新增记录 | 0 / 2448 |
| 二次 apply 新增记录 | 0 |

apply 到临时 `$GQY_HOME` 后：`memory/default/{facts,episodes,revisions}.jsonl` 行数 = 347 / 2054 / 47，`memory/meta.json` 带 `migrated_from.source_fingerprint`，目标目录 `0700`、文件 `0600`。

## 安全与边界

- 只读源：`new DatabaseSync(file, { readOnly: true })` + `PRAGMA query_only = 1`，并回读确认；只读保护不生效就整体失败。
- 默认 dry-run；`apply` 前把将被覆盖的目标文件备份到 `$GQY_HOME/.migrate-backup/<run_id>/`（`no_backup` 关）。
- 默认脱敏：`providers[].api_key` / `api_quota.accounts[].api_key` → `accounts[].api_key_env`；平台 token、`voice.tts.minimax.api_key`、`mcp.servers[].env` 里的 `*_COOKIE` / `*_SESSDATA` 与形似密钥的值 → `env:GQY_MIGRATED_…` 引用。
- 目标权限：目录 `0700`、文件 `0600`；符号链接一律拒绝（防穿越）。
- 迁移只写自己管辖的路径：`memory/`、根级三份配置、`.home-layout-v1`、`kb/`、`prompts/`、`memes/`、`skills/`、`scripts/`、`identities/`、`themes/`、`profile.md`、`state/`、`sessions/`、`data/`、`.migrate-reports/`、`.migrate-backup/`。

## 仓库结构

```
manifest.json          # 一次性插件清单（mode=oneshot，actions=[run]）
index.js               # JSON-RPC 主循环 + 迁移编排
src/args.js            # 参数校验与默认值
src/legacy.js          # 旧库只读访问、目录发现、路径重写
src/memory.js          # facts/episodes/revisions/evicted/embeddings → JSONL
src/config.js          # config.jsonc → settings/providers/routing（脱敏）
src/assets.js          # kb/prompts/memes/skills/scripts/identities/usage/archive 资产
src/report.js          # 报告、指纹、原子写与备份
test/                  # 运行期造最小旧库/旧配置（不提交任何 fixture 或真实数据）
docs/README.md         # 文档索引 + 完整行为契约
```

## 本地验收

```bash
node -v          # 需要 ≥ 22.5（node:sqlite）
npm test         # 四组测试，运行期造库，不碰真实数据
make check       # 语法检查 + npm test + 行尾检查
```

## 不做

- 不迁图片/文档/账本/平台消息的正文能力（只按资产归档，默认还不复制）。
- 不迁旧版 `suggest` 动作与训练管线。
- 不把迁移写进常驻服务：这是一次性插件，跑完即清理。
- 不给 HTTP 路由与控制台入口（宿主接线另开施工单）。

## 与主仓库的关系

行为契约与字段映射以主仓库 `GQYTeam/GQY` 的文档为准：

- `GQY/docs/blueprint/migrate.md`（实现契约：manifest、CLI、单元映射、报告、幂等、验收）
- `GQY/docs/blueprint/memory.md`（JSONL 记录字段、向量编码陷阱）
- `GQY/docs/designs/18-记忆与迁移.md`（MG1–MG8）
- `GQY/docs/designs/15-一次性插件.md`（NX1–NX7）
- `GQY/docs/construction/027-迁移器一次性插件.md`（施工单）

## 许可与署名

本仓库以 **PolyForm Noncommercial License 1.0.0** 授权：**禁止商用**。Fork、二次开发、借鉴代码 / 文档 / 设计，都必须标注来源与原作者，并保留 `LICENSE` 与 `NOTICE`。

```text
来源项目：GQYTeam/gqy-plugins-Migrator-default
项目地址：https://github.com/GQYTeam/gqy-plugins-Migrator-default
原作者：GQYTeam
许可证：PolyForm Noncommercial License 1.0.0
```

详见 [`NOTICE`](NOTICE) 与 [`LICENSE`](LICENSE)。第三方素材与参考项目的许可与出处记在 [`docs/third-party/`](docs/third-party/README.md)（当前无第三方代码或素材）。
