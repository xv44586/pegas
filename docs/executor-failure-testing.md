# Executor Failure Testing

> Feature：`EXEC-003`
>
> 状态：Partial
>
> 更新日期：2026-11-17

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
