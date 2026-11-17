# Supervisor Release State Recovery

> Feature：`RECOVERY-001`
>
> 状态：Partial
>
> 更新日期：2026-11-17

## 用户结果

Supervisor 的主状态损坏或写入中断时，Pegas 不会把未知状态误当成首次启动。存在已验证备份时使用 last-known-good 并报告 degraded；主备都不可读时停止启动 Release，但独立 Recovery API 继续提供健康和诊断状态。

## 状态格式与写入

- 状态文件使用带版本和 SHA-256 校验值的 envelope；读取仍兼容旧版裸 `SupervisorState`。
- 每次覆盖前把当前已验证主状态原子写入 `.last-good`。
- 新状态写入唯一临时文件，flush 后 rename，并在 POSIX 系统同步父目录。
- 主文件无法验证时不会覆盖已有备份。

## 验收条件

1. 截断的主状态可以从 last-known-good 读取，并在 Recovery API 标记 `degraded`。
2. 主备都损坏时状态为 `unavailable`，`ensure` 不会用默认 Release 覆盖现场。
3. 状态 unavailable 时 Recovery API `/healthz` 仍可访问，状态接口返回 503 和诊断元数据。
4. Supervisor 不会在状态 unavailable 时启动未知 Release。
5. 完整质量门禁和 smoke test 通过。

## 非目标与回滚

- 本 Feature 不提供通过 Recovery API 上传、编辑或选择任意 Release 的能力。
- 本 Feature 不替代数据库、Release artifact 或用户数据备份。
- 回滚代码时，新的 envelope 仍可由本实现读取；旧版本只认识裸状态，因此降级前应从 Recovery API 确认 active Release，并由新版本写出或人工导出兼容状态。
