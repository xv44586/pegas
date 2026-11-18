# Task 与执行重试

Feature：TASK-001。验收：Task 只使用 backlog、unstarted、started、completed、cancelled 五个状态；Run 失败不结束目标；每次执行重试创建新 Run，保留旧 Run 及 retryOfRunId；重复重试同一 Run 返回同一个后继，租约恢复同样新建 Run；取消或完成的 Task 不可重试；旧 Worker 不能提交新 Run 的结果。

非目标：不增加定时重试策略、审批对象或自动判断目标已完成。执行成功仍等待用户审阅，Task 保持 started，原因 awaiting_user_review。

边界：服务端为状态权威；重试接口沿用现有单用户 API token，并校验 userId 与 Task 归属。原输入、执行器和已保存 session 用于恢复，不新增权限。对执行产生的外部副作用不承诺 exactly-once；沿用已保存 session 的恢复边界。

迁移：schema v7 将 inbox→backlog、planning→unstarted、running/waiting/paused/failed→started，保留等待/暂停/失败的原因。历史 Run 不改写。v5 和 v6 分别属于 Provider 连接与 Agent 模型覆盖。早期 Task-only v5 候选库在启动时识别并修正迁移编号，然后应用 Provider 迁移。运行前应备份数据库；回滚需同时恢复旧版数据库备份与应用，不能让旧 Worker 与新库混跑。

恢复：事务提交前失败不产生后继；提交后响应丢失可重发。一个 Run 最多一个重试后继；任务存在 queued/running Run 时拒绝额外重试。租约到期时旧 Run 标为 failed（lease_expired），新 Run 从保存的 session 恢复。失败 Run 的错误与输出保留用于诊断。

## 验证与剩余缺口

自动化覆盖旧 v4 数据库八种状态升级、早期 Task-only v5 与 Provider 迁移兼容、错误记录保留、迁移重复启动、重试链与输入/session 保留、重复请求幂等、越权/终态/非最新 Run 拒绝、同 Task 执行串行化、租约过期旧 Worker fencing，以及 Web 重试失败后恢复与历史展示。完整门禁为 `pnpm check` 与 `pnpm smoke`。

工作项完成/取消的控制入口仍待实现，本轮仅提供五状态事实模型与展示；审批/自动重试调度仍未实现。实际外部工具副作用、跨机器旧 Worker 存活和真实模型恢复尚未做故障演练，不能视为 exactly-once 保证。
