# Supervisor Release State Recovery

> Feature：`RECOVERY-001`
>
> 状态：Partial
>
> 更新日期：2026-11-20

## 用户结果

Supervisor 的主状态损坏或写入中断时，Pegas 不会把未知状态误当成首次启动。存在已验证备份时使用 last-known-good 并报告 degraded；主备都不可读时停止启动 Release，但独立 Recovery API 继续提供健康和诊断状态。

## 状态格式与写入

- 状态文件使用带版本和 SHA-256 校验值的 envelope；读取仍兼容旧版裸 `SupervisorState`。
- 每次覆盖前把当前已验证主状态原子写入 `.last-good`。
- 新状态写入唯一临时文件，flush 后 rename，并在 POSIX 系统同步父目录。
- 主文件无法验证时不会覆盖已有备份。
- Candidate 的 `minimumSchema`/`maximumSchema` 会随 ReleaseRef 一起进入状态文件；旧状态没有该字段时保持可读。
- Supervisor 在自身工作目录中把 `PEGAS_DATA_DIR` 解析为绝对路径，再把同一路径传给每个 Candidate；回滚兼容检查与全部写入进程因此始终指向同一个权威数据库，不受 Release 工作目录变化影响。
- 手动回滚先把当前循环标记为受控重启并停止 Control Plane、Worker、Scheduler 与 Dispatcher；Supervisor 主循环在生命周期转换屏障释放前不能启动新子进程，全部写入进程停止后才执行最终只读兼容检查和 release 切换。检查失败时 active Release 不变，并由 Supervisor 重新启动。
- 回滚到 `maximumSchema < 19` 的 Release 前，最终检查发现 pending/processing 的 `collaboration.*` 事件或 pending/active 关系时拒绝切换；Recovery API 只在停机后复核和切换均成功后返回 202。
- 回滚到 `maximumSchema < 20` 的 Release 前，最终检查发现活跃 Automation schedule 或 pending/processing 的 `automation.*` 事件时拒绝切换；暂停/取消并结算 Event 后才允许回滚。

## 验收条件

1. 截断的主状态可以从 last-known-good 读取，并在 Recovery API 标记 `degraded`。
2. 主备都损坏时状态为 `unavailable`，`ensure` 不会用默认 Release 覆盖现场。
3. 状态 unavailable 时 Recovery API `/healthz` 仍可访问，状态接口返回 503 和诊断元数据。
4. Supervisor 不会在状态 unavailable 时启动未知 Release。
5. 完整质量门禁和 smoke test 通过。
6. 无 Previous Release 返回 `409 rollback_unavailable`；存在活跃 schema v19 协作状态或 schema v20 Automation 状态返回 `409 rollback_incompatible`；已有回滚正在进行时返回 `409 rollback_in_progress`；数据库或检查器故障返回不泄露内部路径的 `503 rollback_check_failed`。
7. 手动回滚的顺序固定为受控重启标记、停止全部子进程、最终兼容检查、切换 Release；检查失败不得启动旧 Release，也不得把当前 Release 留在永久停机状态。
8. Candidate staging（`POST /v1/recovery/candidates`，SELF-001）需要 Bearer 鉴权和绝对路径；manifest、目录 attestation、commit 一致性与 schema 兼容全部通过才进入 verifying 并受控重启；无 `onStage` 支持返回 `409 staging_unavailable`，已有转换进行中返回 `409 transition_in_progress`，校验失败返回 `409 candidate_rejected` 且 active Release 不变。
9. 破坏性 migration 单独审批（SELF-001）：候选将首次执行登记表（`src/storage/migration-policy.ts`）中的破坏性迁移时，staging 必须携带 `migrationApproval: {actionId, approvalId}`，指向同一数据库中 approved 的 `self_change.migration`（critical）Action，且其 request 绑定该 releaseId 与精确迁移集合；缺失或不匹配返回 `409 migration_approval_required`（携带待执行 versions），active Release 不变。批准后 Supervisor 先创建已验证备份并在副本上演练真实迁移代码（integrity_check 通过）再切换；启动路径重复校验，重启不能绕过审批。普通 `self_change.publish` 批准不能替代迁移批准。

## 非目标与回滚

- 本 Feature 不提供通过 Recovery API 上传、编辑或选择任意 Release 的能力。
- 本 Feature 不替代数据库、Release artifact 或用户数据备份。
- `rollback_incompatible` 不会自动取消正在运行的协作或 Automation；应先让目标完成、停止相关事情、暂停/取消 Automation，或正常投递剩余事件，再重试回滚。
- Recovery API 同一时刻只执行一个回滚转换；并发请求不会重复翻转 active/previous Release。
- 回滚代码时，新的 envelope 仍可由本实现读取；旧版本只认识裸状态，因此降级前应从 Recovery API 确认 active Release，并由新版本写出或人工导出兼容状态。
