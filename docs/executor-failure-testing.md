# Executor Failure Testing

> Feature：`EXEC-003`
>
> 状态：Partial（真实进程崩溃点注入已覆盖；文件写类 unknown Action 的自动对账已落地，非文件类副作用仍留人工核对）
>
> 更新日期：2026-11-24

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

## 未知写副作用自动对账（2026-11-24）

`src/observability/action-reconciliation.ts` 在对账进程内主动探测 `unknown` 文件写 Action 的外部事实：全部目标存在（有 `request.effect.contentHash` 时还要求 sha256 一致）→ 自动核对 `succeeded`；目标缺失或指纹不符 → 自动核对 `failed`（绝不判成功、绝不重试副作用）。edit/apply_patch 无指纹、非文件类或无 targets 的动作保持 `unknown` 留人工。结算复用 `reconcileAction` 同一 append-only 事务（身份 `system:auto-reconciliation`、commandId `auto-reconcile:<actionId>` 幂等，Outbox `action.reconciled` 带 `reconciledBy` 与自动核对文案），核对记录带 `automatic=1`（schema v44）；存在自动核对事实时 Rollback Guard 拒绝回滚到 schema < 44。`PEGAS_AUTO_RECONCILE=disabled` 可关闭。证据：`test/action-auto-reconciliation.test.ts` 7 个测试；语义详见 `docs/observability.md` 与 `docs/approval-lifecycle.md`。

指纹来源（2026-11-24 补齐）：审批桥在 pre-execute 捕获 `write` 的完整 content 参数计算 sha256,随 `request.effect.contentHash` 写入 Action（人工审批与自动审阅放行都带）,write 类 unknown Action 的自动对账升级为指纹判定（落盘字节 ≠ 预期内容也判失败）。剩余缺口：`edit`/`apply_patch` 只携带增量 delta,无法静态推导最终字节,仍是存在性判定或留人工;非文件类副作用（网络发布、消息发送等）无静态探测面,仍必须人工核对。
