# Pegas MVP 计划

> 状态：In Progress
> 更新日期：2026-11-16

## MVP 验证目标

一个用户只通过单一对话入口连续提出多个事项，Pegas 能够正确分流、持久执行、跨重启恢复，并在需要时通过手机完成确认。Pegas 修改自身时，失败不能同时破坏唯一的恢复入口。

## 已建立的工程地基

- [x] Node.js / TypeScript / pnpm 工程；
- [x] format、lint、typecheck、unit test、build 和 smoke test；
- [x] GitHub Actions CI 门禁；
- [x] SQLite 初始 schema；
- [x] 持久 Event Inbox、来源去重和 Worker lease；
- [x] 最小 HTTP Event API 与 bearer token 边界；
- [x] 用户消息创建 Task 和 Outbox 记录的纵向闭环；
- [x] 持久 Routing Decision 和幂等 Run 创建；
- [x] Run lease、并发执行和过期接管；
- [x] DSH headless Adapter、NDJSON 结果判定和 session ID 持久化；
- [x] 显式 Task continuation 复用原 DSH session；
- [x] 独立 Supervisor 进程；
- [x] Release 状态、候选观察期和回滚模型；
- [x] 独立 Recovery API 的状态、重启和回滚端点；
- [x] 自动化测试与端到端 smoke test。

这些能力目前是可运行骨架，不代表完整产品功能。Control Plane 默认只允许本机访问，尚未提供可直接使用的移动端界面。

## 第一条真实产品闭环

- [ ] Channel & Identity Gateway；
- [ ] 单用户认证和移动端设备登录；
- [ ] 同一用户的 Router lease / fencing；
- [ ] 新建、补充、纠正和取消 Task 的路由；
- [ ] Task 与 Run 完整状态迁移；
- [x] 第一版 DSH headless Executor Adapter；
- [x] Run 与 DSH session 映射及租约过期恢复；
- [ ] Outbox dispatcher 与一个真实投递渠道；
- [ ] Activity/Task 只读视图；
- [ ] 结构化日志、指标和错误追踪。

## 长期运行闭环

- [ ] Follow-up 和 Schedule；
- [ ] Scheduler 事务性写入 Event Inbox；
- [ ] Approval 持久等待、释放 Worker 和事件恢复；
- [ ] Action idempotency 与未知副作用处理；
- [ ] Memory 来源、修正、删除和按需加载；
- [ ] SQLite 备份、校验与恢复演练；
- [ ] Worker、网络和数据库故障注入测试；
- [ ] Outbox 的重试、合并、静默时段和未知投递处理。

## 自我修改闭环

- [ ] SelfChange Task 类型与风险策略；
- [ ] 隔离 worktree / sandbox 创建和清理；
- [ ] Pegas 生成修改后强制运行完整 CI；
- [ ] 将 commit 构建成不可变 Release；
- [ ] Release manifest、产物校验值和 schema 兼容范围；
- [ ] 发布前自动备份；
- [ ] Candidate readiness 和关键路径 smoke test；
- [ ] Supervisor 原子切换、观察期和自动回滚；
- [ ] 发布后从持久 Task 恢复并向用户汇报；
- [ ] 破坏性 migration 的单独审批。

## 手机长期使用闭环

- [ ] 响应式 Web/PWA 或第一种消息渠道；
- [ ] 推送或可靠主动通知；
- [ ] 对话、任务状态和审批跨设备一致；
- [ ] Mac 执行节点注册、心跳和离线状态；
- [ ] Remote Sandbox 执行节点；
- [ ] 独立 Recovery API 的移动端状态、重启和回滚界面；
- [ ] 主机级外部健康检查和离线告警。

## MVP 完成定义

以下场景必须自动化验证：

1. 用户连续发送多个话题，系统正确新建或更新对应 Task；
2. 在事件领取、工具调用和结果写回的不同位置杀死进程，重启后不丢任务、不重复副作用；
3. 用户在手机端完成 Approval，原 Task 从持久恢复点继续；
4. Mac 执行节点离线时，本地 Action 明确等待，其他 Task 不被阻塞；
5. Pegas 在隔离环境修改自身，候选版本通过后接管服务；
6. 候选版本无法启动时，Supervisor 自动回滚且 Recovery API 始终可用；
7. 数据备份能够在空环境中恢复并继续处理未完成 Task。
