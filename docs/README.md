# docs

本仓库是 GQY 的**迁移器一次性插件**（`GQYTeam/gqy-plugins-Migrator-default`）。文档保持最小：这里写完整行为契约，跨仓库的设计决定都在主仓库 `GQY/docs/`。

## 文档索引

| 文件 | 内容 |
| --- | --- |
| [`../README.md`](../README.md) | 定位、怎么跑、参数、迁什么、验收数据、安全边界、许可与署名 |
| `README.md`（本文件） | **唯一行为契约**：manifest、JSON-RPC、参数语义、单元映射、报告字段、幂等、脱敏、退出码、已知取舍 |
| [`third-party/README.md`](third-party/README.md) | 第三方代码 / 素材的许可与出处（当前无） |
| [`GQY/docs/blueprint/migrate.md`](../../GQY/docs/blueprint/migrate.md) | 实现契约：manifest、CLI、单元映射、报告、幂等、仓库结构、验收 |
| [`GQY/docs/blueprint/memory.md`](../../GQY/docs/blueprint/memory.md) | 新版记忆 JSONL 字段表与「向量编码陷阱」 |
| [`GQY/docs/designs/18-记忆与迁移.md`](../../GQY/docs/designs/18-记忆与迁移.md) | MG1–MG8（只读源、默认 dry-run、幂等、默认脱敏、可回滚、单元独立、大媒体默认不迁、证据可追溯） |
| [`GQY/docs/designs/15-一次性插件.md`](../../GQY/docs/designs/15-一次性插件.md) | NX1–NX7（一次性插件形态、来源、生命周期、清理） |
| [`GQY/docs/construction/027-迁移器一次性插件.md`](../../GQY/docs/construction/027-迁移器一次性插件.md) | 施工单与验收 |

## manifest 约定

`manifest.json` 随仓库提交，按 `GQY/docs/reference/plugin-manifest.md`（v1.1）与 `blueprint/migrate.md` §1 实现：

| 字段 | 值 |
| --- | --- |
| `id` | `migrator-default` |
| `name` / `version` | `迁移器（旧版 GQY_HOME → 新版）` / `1.0.0` |
| `mode` | `oneshot`（一次性插件；跑完由内核清理） |
| `protocol` | `gqy-jsonrpc-v1`（原生 stdio 换行 JSON-RPC 2.0） |
| `command` / `cwd` | `["node","index.js"]` / `.` |
| `timeout_ms` | `120000`（真实备份 dry-run ≈0.2s，apply ≈0.1s，留足大媒体余量） |
| `concurrency` | `exclusive`（一次只跑一个迁移，避免两个进程同时写同一目标） |
| `actions` | 只有一个 `run`，schema 见 [`../README.md`](../README.md) 参数表 |
| `provides` / `requires` | 空数组 |
| `source` | 不声明（= 本地自建/开发模式；源码仓库禁止出现 `.gqy-installed`） |

## JSON-RPC

换行分隔的 JSON-RPC 2.0；`stdin` EOF 自退（最后一道防线），`shutdown` 回 ok 后退出 0。

| 方法 | 行为 |
| --- | --- |
| `initialize` | 回 `{ok:true, name:"migrator-default", version, mode:"oneshot", actions:["run"]}` |
| `call` | `params = {action:"run", arguments:{…}}`；结果取 `result.content`（一段 JSON 字符串，见下） |
| `shutdown` | 回 `{ok:true}` 后退出 0 |

`call` 返回的 `result.content` 是：

```json
{"ok": true, "output": {"applied": false, "dry_run": true, "kinds": ["…"], "run_id": "…",
  "source_fingerprint": "sha256:…", "units": {…}, "totals": {…}, "warnings": ["…"],
  "skipped": [], "report_path": "…", "exit_code": 0, "duration_ms": 230}}
```

`ok` 只表示「迁移完成且没有 unit 失败」；`output.exit_code` 是 MG6 的三档退出码（`0` 全成功 / `1` 部分失败 / `2` 全失败）。插件进程本身始终以 0 退出——内核把非 0 视作协议失败，会丢掉结果。

错误码分层（与其它 GQY 插件一致）：

| 码 | 场景 |
| --- | --- |
| `-32700` | 非法 JSON |
| `-32601` | 未知方法 / 未知动作 |
| `-32602` | 参数非法（缺 `input`、类型不对、未知 `kinds`、`persona` 格式错、`input` 目录不存在） |
| `-32000` | 运行期错误（`node:sqlite` 不可用、只读保护不生效、内部异常） |

错误消息里只有路径与错误码，不含正文与凭据。

## 参数语义

- `input`：必须存在且可读的目录。导出根下有 `home/` 时以 `home/` 为旧数据根，否则把 `input` 本身当旧数据根（兼容直接给 `GQY_HOME` 的情况）。
- `home`：参数 > `GQY_HOME` 环境变量 > `~/.gqy`。dry-run 也会写报告到 `home/.migrate-reports/`（MG8 要求每次运行都有证据），但**不会**创建 `memory/`、`providers.json` 等数据。
- `apply`：缺省 `false`；只有 `true` 才写目标。
- `kinds`：组级选择。缺省 = 除 `archive` 外全部（MG7）。未知值报 `-32602`；合法的「人格 id 形状」值按 `persona` 过滤处理（兼容蓝图里的旧写法）。
- `persona`：只迁该人格库；导出里没有该人格时只告警、不报错。
- `include_secrets`：`true` 才把明文凭据写进目标（仍是 `0600`）；报告无论如何都不出现明文。
- `no_backup`：关掉覆盖前备份。
- `report`：覆盖报告路径；相对路径按进程 cwd 解析。

## 单元映射与计数口径

完整表格见 [`../README.md`](../README.md#迁什么迁到哪)，此处只记口径：

- `personas.memory.records`：`facts` / `episodes`（含 `pending_events` 里未处理的短期片段）/ `revisions` / `embeddings`（**成功挂到记录上的**向量数）。
- `source_embeddings`：旧库里该 unit 的向量总数（含孤儿）。
- `orphan_vectors`：挂不到任何记录的向量。`personas.memory` 与 `state.evicted_context` 分别计，`totals.orphan_vectors` 是两者之和。
- `missing_vectors`：有记录但没有向量的条数。
- `vector_surplus`：文档口径的「向量条数超出片段条数」差额（episode 向量 − episode 条数）。
- `missing`：导出清单声明了但磁盘上不存在的记忆库数。**缺失即缺失**：不报错、不造空库。
- `totals.records`：只汇总 `facts` / `episodes` / `revisions` / `evicted`（不含 `embeddings`、`personas` 等非记录字段）。
- `totals.files` / `bytes`：参与本次迁移的 unit 的文件数与源字节数；`not_selected` 的 unit 不计入（但仍在 `units` 里报体积，方便判断 archive 有多大）。
- `redacted`：被改写成 env 引用的凭据项数（一个非空值算一项）。

## 幂等与指纹

- `legacy_id = legacy:<表>:<旧主键>`；重跑时读目标 JSONL 已有的 `legacy_id` 做差集，只追加新行，不覆盖用户改过的行。
- 第二层去重：`facts.content` 的 sha256、`episodes.source_key`。
- `memory/meta.json.migrated_from.source_fingerprint` = 导出清单 `entries[].path + blake3` 排序后的 sha256；没有清单时退回「相对路径 + 大小 + mtime」的树指纹。
- 没有新记录且 `meta.json` 已存在时**不改写** `meta.json`（幂等运行无副作用）；有新增才 `generation + 1`。
- `memory/personas.json` 与各 `skills.json` 只有内容变化时才重写。
- 覆盖已有目标文件前，把原件备份到 `$GQY_HOME/.migrate-backup/<run_id>/<相对路径>`（`no_backup` 关）。

## 脱敏规则

默认（`include_secrets=false`）把下列位置全部改写成引用：

| 旧位置 | 新位置 |
| --- | --- |
| `providers[].api_key` | `providers.json.providers[].accounts[].api_key_env`（`GQY_PROVIDER_<ID>_API_KEY`） |
| `plugins.api_quota.<provider>.accounts[].api_key` | 归并到同 id provider 的 `accounts[].api_key_env`（多账号时带 `_ACCOUNT_<n>`） |
| `voice.tts.minimax.api_key` | `settings.json.voice.tts.minimax.api_key` → `env:GQY_MIGRATED_…` |
| `platforms.qq.access_token`、`platforms.connectors.imessage.token`、`config/imessage.json` 的 `token` | 同形状 → `env:GQY_MIGRATED_…` |
| `mcp.servers[].env` 里的 `*_COOKIE` / `*_SESSDATA` / `*_TOKEN` 等 | 同形状 → `env:GQY_MIGRATED_…`（其它键原样保留） |
| 形似密钥的字符串值（`Bearer …`、`sk[-]…`、`ghp_…`、`hf_…`、`AIza…`） | 命中即脱敏，不看键名 |

判定按「整键名 + 后缀」精确匹配，`show_token_usage`、`compact_tail_tokens` 这类计数字段不会被误伤。报告里只出现「已脱敏 N 项」的计数。

## 已知取舍（实测）

1. **旧 provider 会掉一批**：旧版支持 `claude-code` / `antigravity` / `codex` / `cline` 这些 CLI 代理协议，以及一批没有 `models` 的 provider；新版网关白名单只有 `openai-chat` / `anthropic-messages` / `gemini` 且要求 `base_url` + 非空模型。实测 16 个旧 provider 里 11 个无法映射，迁移保留 5 个，其余留在 `settings.json.migrated.legacy` 里可查（报告只有计数，不列 id）。
2. **向量编码按 BLOB 长度判断**：旧库 `model` 名写 `…-int8`，实际 2048 字节 = 512 维 `float32`。`len == dim` → `int8`，`len == 4*dim` → `float32`；未知模型用 L2 归一启发式兜底。按名字反量化会静默产出垃圾。
3. **孤儿/缺失向量不丢只计数**：实测 episode 向量 2684 > episodes 2054（多 630）、另有 316 条 episode 没有向量、`evicted_embeddings` 192 条全是孤儿。报告分别给出 `vector_surplus`(630) / `orphan_vectors`(946) / `missing_vectors`(316) / evicted 的 `orphan_vectors`(192)，口径见上。
4. **`artifact_assets.source_key` / `kb_meta.files.path` 是绝对路径**：按「旧版根之后的相对路径」重写；重写不了的保留原值并写 `legacy_path`，计入 `path_rewrites`。
5. **`conversation.db` 只做 best-effort**：`sessions` 表 + `turns` 文本 + `artifact_assets`，`turns.display_content` 兼容裸文本 / JSON 文本 / 整数，时间列兼容 epoch 与 RFC3339。journal 事件与 redo 备份不迁。
6. **`state/*.json`（usage、imessage-contacts 等）原样复制**：它们是用户数据，不属于配准脱敏范围；`sk-` 之类的字符串若出现在**记忆正文**里，是用户自己写过的东西，照迁不改（报告不含正文）。

## 退出码（MG6）

`0` 全部成功；`1` 部分 unit 失败（例如某个旧库损坏）；`2` 全部失败。单个 unit 失败不影响其余 unit 继续迁移，失败原因写进 `units.<unit>.error` 与 `warnings`。

## 清理与残留

内核（`oneshot.Run`）跑完会删掉 `$GQY_HOME/tmp/oneshot/<run>`；`--keep` 才保留。插件自己不在插件目录写任何东西（目标数据只写 `home`）。
