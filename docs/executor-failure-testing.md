# Executor Failure Testing

> Feature：`EXEC-003`
>
> 状态：Partial（真实进程崩溃点注入已覆盖；未知副作用的自动对账仍缺）
>
> 更新日期：2026-11-21

## 用户结果

Worker、DSH 或机器在任务执行期间失败时，Pegas 可以在明确的 lease 边界接管，并保留已经获得的 DSH session，不依赖测试机器的调度速度或短暂 sleep。

## 验收条件

1. Run lease 在到期前不可接管，在精确到期点可以由新 Worker 接管。
2. lease 测试使用可注入 Clock，不等待真实时间。
3. DSH 超时后先 SIGTERM、宽限期后 SIGKILL，测试结束时子进程已经退出。
4. abort、畸形事件和超大事件都会终止 DSH，同时保留终止前拿到的 session ID。
5. 完整质量门禁和涉及进程的 smoke test 通过。

## 非目标

- 本次不增加 Action 领域对象，也不推断外部工具副作用是否成功。
- 本次不修改 Outbox 的投递重试语义或 Supervisor 的 Candidate 恢复语义。
- 本次不把测试 Clock 暴露为运行时配置。

## 数据、权限与失败行为

Clock 只改变进程内时间来源，不改变数据库格式。DSH 的权限参数和 workspace grant 保持不变。无法确定的外部副作用仍是 `EXEC-003` 的下一缺口；在该模型落地前，Pegas 不能把“session 可恢复”等同于“工具调用可以安全重试”。

## 真实进程崩溃点注入（2026-11-21）

`pnpm smoke:crash`（`scripts/smoke-crash-recovery.mjs`）用真实 Control Plane / Worker 进程和临时 SQLite 数据目录验证 MVP 场景 2。测试替身 DSH 经 `PEGAS_DSH_COMMAND` 注入，在三个持久崩溃点把 Worker 进程 SIGKILL（连同自身），随后由 harness 重启新 Worker：

1. **事件领取后**：Run 已被领取、尚无任何副作用时崩溃。事件不丢：重启后 Task 恰好完成一次，副作用计数为 1，事件终态 `processed`。
2. **工具调用后、结果写回前**：副作用已落盘、session 已持久化时崩溃。旧 Run 在真实 30s lease 到期后被结算为 `failed(lease_expired)`，retry Run 通过 `retryOfRunId` 关联旧 Run 并携带 `resumeFromRef` 恢复同一 session；副作用不重复（计数仍为 1）。
3. **final 结果后、完成写回前**：崩溃后同样经 lease 过期 + session 恢复完成，`run.completed` Outbox 消息恰好一条。

崩溃点由消息文本中的 `[crash:…]` 标记触发，每个场景以 marker 文件保证只崩溃一次；副作用计数按 Task 统计 marker 行数，任何错误恢复实现都会因重复副作用或重复完成而失败。该 smoke 走生产 lease 时长，全程约 90 秒；不进入 `pnpm check`，作为进程级恢复证据单独运行。

边界：测试替身证明的是 Pegas 自身的领取/写回/恢复边界不丢不重；真实第三方工具的“未知副作用”仍必须由 Action Protocol 的 idempotency/reconciliation 处置，session 恢复不等于工具调用可安全重试。
