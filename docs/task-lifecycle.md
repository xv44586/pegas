# Task 与执行重试

Feature：`TASK-001`（现有五状态与失败重试）和 `TASK-002`（Planned，完成后恢复与用户停止）。`TASK-001` 验收保持不变：Task 只使用 backlog、unstarted、started、completed、cancelled 五个状态；Run 失败不结束目标；每次失败重试创建新 Run，保留旧 Run及 `retryOfRunId`；重复重试同一 Run 返回同一个后继；租约恢复同样新建 Run；终态 Task 不允许调用“失败重试”；旧 Worker 不能提交新 Run 的结果。

非目标：不增加定时重试策略或完整审批产品。当前 Run 的结构化 `ready` Report 在没有未满足完成条件时结束 Task；存在审批、Artifact 或外部 Thread 等条件时保持 started/awaiting condition，直到 Control Plane 验证条件满足。

边界：服务端为状态权威；重试接口沿用现有单用户 API token，并校验 userId 与 Task 归属。原输入、执行器和已保存 session 用于恢复，不新增权限。对执行产生的外部副作用不承诺 exactly-once；沿用已保存 session 的恢复边界。

迁移：schema v7 将 inbox→backlog、planning→unstarted、running/waiting/paused/failed→started，保留等待/暂停/失败的原因。历史 Run 不改写。v5 和 v6 分别属于 Provider 连接与 Agent 模型覆盖。早期 Task-only v5 候选库在启动时识别并修正迁移编号，然后应用 Provider 迁移。运行前应备份数据库；回滚需同时恢复旧版数据库备份与应用，不能让旧 Worker 与新库混跑。

恢复：事务提交前失败不产生后继；提交后响应丢失可重发。一个 Run 最多一个重试后继；任务存在 queued/running Run 时拒绝额外重试。租约到期时旧 Run 标为 failed（lease_expired），新 Run 从保存的 session 恢复。失败 Run 的错误与输出保留用于诊断。

## TASK-002 目标合同

“失败重试”和“完成后恢复”不是同一个动作：

- 失败重试以失败 Run ID 为幂等来源，只有最新 failed Run 可以重试。
- completed 恢复以用户输入 Event ID 为幂等来源，先复核当前授权，再为同一 Task 创建新的 Run；旧 Run 保持终态。
- cancelled 只表示用户明确停止，原 Task 永久不可恢复，也不能通过显式 `taskId`、重新授权或旧 Session 绕过；继续工作需要重新接单并创建带来源关系的新 Task。授权复核失败不改写为 cancelled，而是保持 completed 并把输入退回 Router/Eval。
- Run、Worker Runtime 和 Executor Session 独立结束；旧 Session 只有通过兼容性检查才作为新 Run 的恢复引用。

```text
completed + authorized user input
  → lock Task
  → revalidate scope / Policy / WorkerProfile
  → append task.resumed
  → create one queued Run
  → commit
  → wake replaceable Worker Runtime
```

第一阶段可以继续使用五个 Task 状态，不新增 `ended` 或 `stopped` 枚举；`completed` 与 `cancelled` 表达软结束和人工停止。另存 Super Agent 风格的 ended 记录（Actor、时间、by、outcome、reason）、不可变 Mandate、恢复 Input 和 Session compatibility，不能只放在 `status_reason` 自由文本中。历史 `cancelled` 保守迁移为 `by: human, outcome: stopped`；历史 `completed` 保留原 outcome 并可申请恢复，历史 Run 不改写。

用户停止是独立于 Run 取消的领域命令：事务内先永久关闭 Task、清空未交付输入并结束未终结 Run，提交后才执行终止 Worker Runtime 的 effect。旧 Worker Report 必须同时匹配仍开放的 Task、当前 Run ID 和 claim 才能提交。`ready`/`dropped` 必须是当前 Worker 的结构化 Report；Control Plane 再根据完成条件决定是否结束，进程退出和自由文本不能结束 Task。

## Mandate 与恢复

第一版复用 Super Agent 的 Mandate，而不是新增 Pegas 专属恢复授权对象：

```text
Mandate = {
  strength,       // explicit | inferred
  policyVersion,
  basis,          // source、接收范围、接单路径、sender、matched rules
  actor,
  scope
}
```

Mandate 在接单时创建且内容不可变。executor 完成不撤销它；用户停止 withdraw，恢复前复核失败 revoke。已完成 Task 收到自己 Channel/Thread 上的人类输入时，无需新的接单 Decision：输入先持久化，复核通过后清除 ended、追加 resumed Input、创建新 Run；复核失败则保持 completed，把输入释放给 Router/Eval。Bot、CI、定时扫描和 context-only 关系不能恢复。

`policyVersion` 由接单规则、accept mode 和各 Source Policy 生成；模型、并发数、暂停状态等执行设置不改变 Mandate。复核按原 basis 判断 Source 是否仍监听、sender/bot 是否仍允许、admission cell 是否仍提供不低于原来的 strength，以及 inferred Mandate 的 auto mode 和 matched rules 是否仍有效。

## 验证与剩余缺口

自动化覆盖旧 v4 数据库八种状态升级、早期 Task-only v5 与 Provider 迁移兼容、错误记录保留、迁移重复启动、重试链与输入/session 保留、重复请求幂等、越权/终态/非最新 Run 拒绝、同 Task 执行串行化、租约过期旧 Worker fencing，以及 Web 重试失败后恢复与历史展示。完整门禁为 `pnpm check` 与 `pnpm smoke`。

工作项完成/取消控制、completed 恢复命令、停止来源、授权复核、Session compatibility 和并发恢复门禁仍由 `TASK-002` 实现。当前显式 continuation 与失败重试对终态的处理不一致，`TASK-002` 必须先写回归测试再修复；在此之前不能宣称 completed/cancelled 生命周期可用。审批/自动重试调度仍未实现。实际外部工具副作用、跨机器旧 Worker 存活和真实模型恢复尚未做故障演练，不能视为 exactly-once 保证。
