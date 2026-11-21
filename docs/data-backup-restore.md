# SQLite 备份、校验与恢复

> Feature：`RECOVERY-002`
>
> 状态：Usable
>
> 更新日期：2026-11-21

## 用户结果

Pegas 的权威数据（Task、Run、Event、Approval、Automation、Memory 等）可以在线备份成带校验值的独立 SQLite 文件，并能在空环境中恢复后继续处理未完成 Task。Supervisor 每次启动 Release 前自动做一次已验证备份，为发布与回滚提供数据生命线。

## 备份

- 使用 `node:sqlite` 官方 online backup API，从只读连接复制到 `.partial` 临时文件，WAL 模式下不阻塞写入进程。
- 备份完成后立即校验：`PRAGMA integrity_check` 必须为 `ok`，`schema_migrations` 必须存在且版本 ≥ 1。
- 校验通过后原子 rename 为 `pegas-<UTC 时间戳>.sqlite`，并写出 `*.manifest.json`（版本、来源路径、SHA-256、大小、schema 版本）。
- 默认保留最近 7 份，超出按时间修剪；目录默认 `<PEGAS_DATA_DIR>/backups`，可用 `PEGAS_BACKUP_DIR` 覆盖。
- 任何一步失败都会清理临时文件，不留下会被误当作有效备份的半成品。

## 校验与列举

`listVerifiedBackups` 只返回同时满足以下条件的备份：manifest 可解析、文件 SHA-256 与 manifest 一致、integrity check 通过、schema 版本与 manifest 一致。损坏或被篡改的文件会被跳过而不是被选中恢复。

## 恢复

- `restoreDatabaseBackup` 恢复前再次校验文件与 checksum。
- 目标路径已存在时默认拒绝；`allowReplace` 会把现有数据库及 `-wal`/`-shm` 移到 `.pre-restore-<ts>` 保留现场，而不是直接删除。
- 恢复后再次运行完整性校验并返回 schema 版本。
- 恢复出的数据库可以直接被 `PegasStore` 打开：schema migration 幂等推进，未领取的 Event/Run 按既有 lease 语义继续处理。

## CLI

```bash
pnpm backup create                 # 在线备份并校验
pnpm backup list                   # 列出全部已验证备份
pnpm backup verify                 # 确认存在最新已验证备份
pnpm backup restore <path>         # 恢复最新备份到目标路径（目标必须为空）
pnpm backup restore <path> --replace  # 允许替换，旧库移入 .pre-restore-*
```

生产构建使用 `node dist/backup/main.js`。路径来自 `PEGAS_DATA_DIR` 与 `PEGAS_BACKUP_DIR`，与 Supervisor 相同。

## Supervisor 集成

Supervisor 主循环在启动每个 Release 的 Control Plane 之前，若数据库已存在，则执行一次已验证备份并记录路径。备份失败会记录错误但不阻止启动——备份是防线而不是新的单点故障；连续失败应由外部健康检查告警。

## 验收证据

`test/backup.test.ts` 覆盖：写入进程持有数据库时的在线备份与重开可读；保留份数修剪；损坏/篡改备份被列举与恢复拒绝；恢复到空环境后未完成 Task 的 Run 可被新 Worker 领取继续；目标已存在时默认拒绝。

## 非目标

- 不实现远程/异地备份、加密备份或定时备份守护进程（Supervisor 启动备份已覆盖发布场景）。
- 不通过 Recovery API 暴露备份下载或恢复触发；恢复是运维操作，必须在写入进程停止后执行。
- 不备份 Release artifact 本身；Candidate 构建产物校验由 `SELF-001` 负责。
