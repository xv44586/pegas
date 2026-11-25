# Task 与执行重试

Feature：`TASK-001`（现有五状态与失败重试）和 `TASK-002`（Partial，完成后恢复与用户停止的第一版闭环）。`TASK-001` 验收保持不变：Task 只使用 backlog、unstarted、started、completed、cancelled 五个状态；Run 失败不结束目标；每次失败重试创建新 Run，保留旧 Run及 `retryOfRunId`；重复重试同一 Run 返回同一个后继；租约恢复同样新建 Run；终态 Task 不允许调用“失败重试”；旧 Worker 不能提交新 Run 的结果。

非目标：不增加定时重试策略或完整审批产品。当前 Run 的结构化 `ready` Report 在没有未满足完成条件时结束 Task；存在审批、Artifact 或外部 Thread 等条件时保持 started/awaiting condition，直到 Control Plane 验证条件满足。

`GOAL-001` 的后续完成合同不会把 `ready` 扩张为 Worker 自证成功。计划中的 Goal Contract 会把 success criteria 与 EvidenceRef 绑定；`ready` 只表达 Worker 已准备交付，Control Plane 逐项验证当前 Goal revision 后才生成 Review Pack 并决定是否完成。Agent 总结、退出码、代码 diff 和过程日志不能独立满足条件。该能力尚未实现，不改变 `TASK-002` 当前 Partial 状态，权威设计见 `docs/goal-contract-and-evidence.md`。

边界：服务端为状态权威；重试接口沿用现有单用户 API token，并校验 userId 与 Task 归属。原输入、执行器和已保存 session 用于恢复，不新增权限。对执行产生的外部副作用不承诺 exactly-once；沿用已保存 session 的恢复边界。

## 完整状态迁移（2026-11-21）

Task 与 Run 的合法状态与迁移由数据库和应用层双重约束：

- **Task**：`backlog / unstarted / started / completed / cancelled`（migration 7 触发器强制）。路由创建 → `unstarted`；Run 领取 → `started`；完成门禁通过 → `completed`；用户停止 → `cancelled`（永久，重复停止幂等）。`completed` 只能经 Mandate 复核的显式续接输入回到非终态；`cancelled` 在入口与事务两层拒绝任何恢复。
- **Run**：`queued / running / waiting / completed / failed / cancelled`（schema v29 新增 `runs_status_insert/update` 触发器，非法状态直接 ABORT）。迁移路径：
  - `queued → running`（claim，含节点绑定与契约版本 fence）；
  - `running → completed`（无 Goal 合同的 completeRun，或 Goal 完成门禁通过）；
  - `running → failed`（执行失败 / lease 过期结算，后者同事务创建 `retryOfRunId` 后继）；
  - `running → waiting`（高风险 Action 停放等待审批）；`waiting → cancelled`（审批决定取代原 Run，`superseded_by_approval_decision`）+ 新 `queued` 后继；
  - `running → cancelled`（用户停止或 steering 取代，`superseded_by_steering:<successor>`）+ 新 `queued` 后继；
  - `waiting → running`（reporting phase 接管，evidence 补齐唤醒）。
- **终态不可变**：`completed / failed / cancelled` Run 拒绝一切迟到写回（claim fence + 状态检查）；重试只允许最新 failed Run 且同 Task 无活跃 Run，重复重试返回同一后继。
- **Event Inbox**：`pending → processing → processed / failed`（CHECK 约束 + claim fencing，见 ROUTE-002）；审批/协作停放使用保留 lease，结算后幂等 no-op。

自动化证据：`test/task-run-state-machine.test.ts` 覆盖非法状态拒绝（v29 触发器）、成功路径、失败重试幂等、lease 过期恢复、审批停放与后继、steering 取代、用户停止全量取消、completed 显式续接；既有 lifecycle/approval/control-intents/collaboration 回归保护其余边界。v29 为纯新增触发器，不改写历史数据，旧 Release 读取不受影响。

迁移：schema v7 将 inbox→backlog、planning→unstarted、running/waiting/paused/failed→started，保留等待/暂停/失败的原因。v10 为 Task 回填不可变 `mandate_json` 和结构化 `ended_json`，为 Run 回填保守的 `execution_context_json`，并增加停止命令幂等表；历史 cancelled 一律按人工停止迁移，历史 completed 保留可恢复结束记录。v5 和 v6 分别属于 Provider 连接与 Agent 模型覆盖。早期 Task-only v5 候选库在启动时识别并修正迁移编号，然后应用 Provider 迁移。运行前应备份数据库；回滚需同时恢复旧版数据库备份与应用，不能让旧 Worker 与新库混跑。

恢复：事务提交前失败不产生后继；提交后响应丢失可重发。一个 Run 最多一个重试后继；任务存在 queued/running Run 时拒绝额外重试。租约到期时旧 Run 标为 failed（lease_expired），新 Run 从保存的 session 恢复。失败 Run 的错误与输出保留用于诊断。

## TASK-002 目标合同

“失败重试”和“完成后恢复”不是同一个动作：

- 失败重试以失败 Run ID 为幂等来源，只有最新 failed Run 可以重试。
- completed 恢复以用户输入 Event ID 为幂等来源，先复核当前授权，再为同一 Task 创建新的 Run；旧 Run 保持终态。
- cancelled 只表示用户明确停止，原 Task 永久不可恢复，也不能通过显式 `taskId`、重新授权或旧 Session 绕过；继续工作需要重新接单并创建带来源关系的新 Task。授权复核失败不改写为 cancelled，而是保持 completed 并把输入退回 Router/Eval。
- Run、Worker Runtime 和 Executor Session 独立结束；旧 Session 只有通过兼容性检查才作为新 Run 的恢复引用。

会话兼容检查以持久化的 Executor、模型、权限、工作区、节点、协议和执行档案为准。全局设置 revision 保留在新 Run 快照中以便审计，单独变化时不影响恢复引用。具体执行条件有变化时仍按不兼容处理。

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

### 当前来源授权

schema v56 增加按 owner 与来源保存的恢复策略。Web 和 Mobile 默认为已授权的人工入口，可在两端之间继续同一事情。续接尚未归类的输入时，事务内重新校验原始接单事件、人类身份、sender、owner、两端策略和明确的 Task 或回复引用。来源撤权后，仍未归类的输入以可重试失败保留，原事情维持结束；调整授权后可重发原输入。来源或身份无法证实的历史及机器输入可以通过新建相关事情继续。已提交的 Run 沿用既有执行和审批边界。

`GET /v1/task-resume-sources/{web|mobile}?userId=...` 读取策略及 revision，`PUT` 同地址接收 `{userId, enabled, expectedRevision}`，沿用实例认证。默认 revision 为 0，更新按 revision 比较，并支持同一更新的响应重放。旧版本会忽略新表，撤权期间不得切回不支持该策略的版本。

## 验证与剩余缺口

自动化覆盖旧 v4 数据库八种状态升级、早期 Task-only v5 与 Provider 迁移兼容、schema v10 的 Mandate/ended/执行快照回填、错误记录保留、迁移重复启动、重试链与输入/session 保留、重复请求幂等、越权/终态/非最新 Run 拒绝、同 Task 执行串行化、租约过期旧 Worker fencing，以及 Web 重试失败后恢复与历史展示。`TASK-002` 新增 completed 恢复、同 Event 幂等、执行上下文不兼容时换 Session、连续输入不提前结束 Channel、重复停止不改写 ended、停止后旧 Worker 结果拒绝、Worker Runtime 退出后保留 Run、停止后 API 拒绝和 Web 永久停止确认/只读回归。完整门禁为 `pnpm check` 与 `pnpm smoke`。

第一版的权威边界如下：

- 当前 Web 单用户 Source 使用显式 Mandate，按 actor、输入类型和 policy version 复核；completed 复核通过后清除 ended 并创建新 Run，cancelled 在入口与事务状态机两层永久拒绝。
- Run 保存 Executor、模型、工作区、权限、协议和设置 revision；只有快照完全一致才复用 Executor Session。历史 Run 的保守快照不会被新 Worker 配置误判为兼容。
- 用户停止以 command ID 幂等，在一个事务内写 human/stopped ended 并取消未终结 Run。旧 Worker 必须仍拥有 running Run 才能写 session、进度或最终结果。
- Worker Runtime 正常退出不会把 Run 误判为业务失败；Run 保留到 lease 到期，由替代 Runtime 走既有恢复链。停止后的 Executor 通过租约心跳观察 fencing 并中止。
- Web 使用服务端 `canStop` 投影，永久停止由原生模态确认；停止后输入、附件和语音入口只读，并提供“新建相关 Channel”。

仍未完成的硬化项是多 Source Policy 撤销后把输入释放给 Router/Eval 的完整 disposition、`dropped` 与外部完成条件、进程内即时 Runtime Controller、停止前未知外部副作用的结构化审计，以及跨机器真实模型 Session 故障演练。因此 `TASK-002` 保持 Partial，不承诺 exactly-once。
