# Automation 与持久时间触发

> Feature：`SCHEDULE-001`
>
> 状态：Partial
>
> 更新日期：2026-11-23（登记手动删除与触发记录分页的目标合同，标注「设计中」；实现与验收归属 DESIGN-006 第二阶段，见 `docs/sealed-ui-rebuild.md` §20）

## 用户结果

用户可以把一个明确意图保存为 Automation，并设置一次执行时间或固定间隔。到点后，Pegas 创建新事情，或把提示词附加到一个仍然开放的已有事情。每次触发都必须留下 Invocation、Inbox Event、Run 和失败原因，不能依赖调度进程的内存定时器。

Automation 是独立产品对象。它不是 Task，不是 Run，也不是 DSH session；一条 Automation 可以依次产生多个 Task，一个 Task 也可以被重复唤醒。第一版界面中的“自动化”页只能读取这里返回的事实。

### Follow-up（对话式一次性跟进）

Follow-up 是 Automation 的一个受限创建入口，而不是新的领域对象：实际 Executor 在对话中听到“明天下午再问我是否发布”这类围绕当前事情的一次性跟进时，用当前 Run 的短期 claim 调用：

```http
POST /v1/runs/:runId/follow-ups
x-pegas-run-claim-token: <current run claim>
```

```json
{
  "commandId": "stable-key",
  "prompt": "到点要执行或询问的内容",
  "at": "2026-11-22T14:00:00.000Z",
  "title": "可选短标题"
}
```

服务端把它落盘为 `once + existing_task(当前 Task)` 的 Automation：owner 取自 Run 所属 Task，不接受调用方指定其他 Task 或 new_task；`at` 必须在未来；Task 已停止/完成时拒绝（`automation_target_unavailable`）。命令按 `follow-up:<runId>:<commandId>` 幂等，重放返回冻结的 Automation，payload 冲突 409。到点由既有 Scheduler → Event Inbox → Router 链路把提示词作为机器输入送回同一事情；周期性责任仍走显式 Automation API，Follow-up 不表达周期语义。

`at` 必须携带显式时区（`Z` 或 `±HH:MM` 偏移）。裸本地墙钟时间（如 `2026-11-24T14:00:00`）会被拒绝并提示带时区重写，防止把本地时间误标成 UTC 造成整小时偏移。

### Recurring（对话式周期跟进）

周期责任（“每分钟报一个数”“每小时检查一次构建”）由实际 Executor 用当前 Run 的短期 claim 调用：

```http
POST /v1/runs/:runId/automations
x-pegas-run-claim-token: <current run claim>
```

```json
{
  "commandId": "stable-key",
  "prompt": "每次触发要做的事（自足描述进度判断与停止条件）",
  "everySeconds": 60,
  "startsAt": "2026-11-24T14:00:00+08:00",
  "title": "可选短标题"
}
```

服务端把它落盘为 `interval + existing_task(当前 Task)` 的 Automation：owner 与 target 冻结自 Run 所属 Task，payload 不接受 target/userId 字段；`everySeconds` 沿用 Automation 合同（60 秒至 366 天）；`startsAt` 可选、必须在未来且必须带显式时区。Task 已停止/完成时拒绝（`automation_target_unavailable`）。命令按 `run-automation:<runId>:<commandId>` 幂等，重放返回冻结的 Automation，payload 冲突 409。到点由既有 Scheduler → Event Inbox → Worker 链路把提示词作为机器输入送回同一事情，周期 Automation 保持 `active`。

只要 Task 上仍有 `active` 且指向它的 Automation，Run 完成不会把 Task 结算为 `completed`（保持 `started`），周期触发因此总能续接；这是既有「机器输入不复活 closed Task」边界的配套前提，不改变用户显式停止/完成的行为。

Executor 收尾或调整时用同一 claim 调用状态命令（只能操作续接当前事情的 Automation，跨 Task 返回 404）：

```http
POST /v1/runs/:runId/automations/:automationId/pause
POST /v1/runs/:runId/automations/:automationId/resume
POST /v1/runs/:runId/automations/:automationId/cancel
```

```json
{ "commandId": "stable-key", "expectedRevision": 1 }
```

`userId` 由服务端取自 Run 所属 Task，不接受调用方指定；revision 冲突、只读状态与幂等语义沿用既有 Automation 状态命令。执行合同要求 Executor 把周期性等待交给调度器，禁止在当前 Run 里用 sleep/循环模拟周期任务。

### Claim 凭证送达（capability 文件通道）

Run claim 经两条等价通道送达实际 Executor：进程环境变量 `PEGAS_RUN_CLAIM_TOKEN`，以及 `PEGAS_RUN_CAPABILITY_FILE` 指向的本机只读 JSON 文件（`{baseUrl, runId, claimToken}`，0600，位于私有临时目录，Run 结束即删除）。第二条通道存在的原因：模型 shell 工具链可能按变量名启发式过滤含 `TOKEN/KEY/SECRET` 的环境变量（如 DSH `dsh-subprocess` 的 `SENSITIVE_ENV_PATTERN`），导致 Executor 的 bash 里读不到 claim 环境变量；不含敏感词的 `PEGAS_RUN_CAPABILITY_FILE` 路径能通过过滤，Executor 在 shell 内读文件即可取回同一凭证。两条通道给出同一个短期 claim，鉴权、租约与过期语义不变；执行合同指导 Executor 在环境变量缺失时改读该文件，且不得把凭证复制到别处或输出到对话/日志/第三方。

## 领域模型

Automation 保存：

- 稳定 ID 和 owner；
- revision；
- 标题与提示词；
- `once` 或 `interval` schedule；
- `new_task` 或 `existing_task` target；
- `active`、`paused`、`completed` 或 `cancelled` 状态；
- 下一次触发时间、最近一次计划触发时间和更新时间。

Invocation 保存：

- Automation 与 owner；
- 计划触发时刻；
- 稳定 Event ID；
- `pending`、`processing`、`dispatched` 或 `failed` 状态；
- Inbox 尝试次数与最近失败原因。

展示层投影（设计中，DESIGN-006 第二阶段）：Invocation 读取响应附加两个只读派生字段，均不落盘：

- `taskId`：该次触发对应 Run 的 Task（经 `event_id → runs.origin_event_id` 关联；Run 尚未创建时缺省）；
- `summary`：该 Run 已落盘输出（`output_json`）的首行摘要（≤120 字，与对话投影同一截断口径；Run 未完成或无输出时缺省）。

它们只回答「这次触发做了什么」，不是执行确认的权威来源；权威事实仍是对话流中的 `agent.message` 与 Run 终态。

`existing_task` 只能指向同一 owner 下未完成、未停止的 Task。Automation Event 是机器输入，不能恢复 cancelled Task、恢复 completed Task，也不能被普通 `/v1/events` 调用伪造。

## API

### 创建

```http
POST /v1/automations
Content-Type: application/json
```

```json
{
  "userId": "owner",
  "commandId": "automation-create-1",
  "automation": {
    "title": "晨间简报",
    "prompt": "整理今天需要处理的事情。",
    "schedule": {
      "kind": "interval",
      "everySeconds": 3600
    },
    "target": {
      "kind": "new_task"
    }
  }
}
```

`commandId` 在 owner 内唯一。相同 command 与相同 payload 重放返回第一次冻结的 201 响应；不同 payload 返回 `409 automation_command_conflict`。

### 查询与编辑

```http
GET /v1/automations?userId=owner
GET /v1/automations/:automationId?userId=owner
GET /v1/automations/:automationId/invocations?userId=owner&limit=100
PUT /v1/automations/:automationId
```

编辑必须携带 `userId`、`commandId`、`expectedRevision` 和完整 `automation`。旧 revision 返回 `409 automation_conflict`；不增加数量化的“last write wins”。

### 触发记录分页（设计中，DESIGN-006 第二阶段）

```http
GET /v1/automations/:automationId/invocations?userId=owner&limit=25&cursor=<invocationId>
```

- 排序固定为 `scheduled_for DESC, rowid DESC`（最新计划触发在前），与既有查询一致。
- `limit` 缺省 50（兼容既有调用方），上限 200；`cursor` 是上一页最后一条 Invocation 的 id，按排序键 seek，不依赖 OFFSET。非法 cursor（不存在或不属于该 Automation/owner）返回 400。
- 还有下一页时响应携带 `nextCursor`（本页最后一条 id）；没有则省略。响应形状：`{ invocations: [...], nextCursor?: string }`。
- 分页读取是只读操作，无幂等/revision 语义；owner 隔离与 404 语义沿用既有查询。

### 状态命令

```http
POST /v1/automations/:automationId/pause
POST /v1/automations/:automationId/resume
POST /v1/automations/:automationId/cancel
```

三者都携带：

```json
{
  "userId": "owner",
  "commandId": "automation-pause-1",
  "expectedRevision": 2
}
```

暂停清空下一次触发时间；恢复从当前时间重新计算下一次触发；取消永久结束 Automation。删除仅适用于已结束状态（见下节）。这些命令失败都返回稳定错误（见「状态命令错误表」）。

### 删除（设计中，DESIGN-006 第二阶段）

```http
POST /v1/automations/:automationId/delete
```

携带与状态命令相同的 `{ userId, commandId, expectedRevision }`。删除是用户显式清理入口，语义与「结束」不同：

- **前置条件**：仅 `completed` / `cancelled` 可删；`active` / `paused` 返回 `409 automation_read_only`（先结束再删除，防止误删仍在履行责任的自动化）。
- **删除范围**：同一事务内删除 Automation 定义、其全部 Invocation 行、以及这些 Invocation 对应且仍处于 `pending` 的 `automation.due` Inbox Event（防止已排队未处理的触发在定义消失后结算失败）。`processing` / 已结算 Event 不动：Worker 对缺失 Invocation 的更新是 no-op，Run 一旦创建即独立存在。
- **保留边界**：已产生的 Task、Run、对话消息与 `agent.message` 历史全部保留——删除清理的是「未来的责任与调度记录」，不是「已经发生的事实」。对话里的数数气泡不因删除消失。
- **幂等**：按 `(userId, commandId)` 冻结首次响应重放；同 command 不同 payload 返回 `409 automation_command_conflict`；旧 `expectedRevision` 返回 `409 automation_conflict`。删除后同 command 重放仍返回冻结的删除回执（命令账本保留，不随定义删除）。
- **回执**：`{ deletion: { id, deleted: true, deletedAt } }`。删除后 `GET` 该 Automation 返回 404。
- **schema**：`automation_commands.automation_id` 的外键改为 `ON DELETE SET NULL`（列放宽为可空），命令账本在定义删除后仍可重放； additive 迁移，旧版本代码不读该列的空值场景，回滚无兼容负担。

### 状态命令错误表

| 状态 | `error`                         | 含义                                                                                      |
| ---- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| 404  | `not_found`                     | Automation 不存在或不属于该 owner                                                         |
| 409  | `automation_command_conflict`   | 同一 command ID 用于不同 payload                                                          |
| 409  | `automation_conflict`           | `expectedRevision` 已过期                                                                 |
| 409  | `automation_read_only`          | 状态不允许该命令：pause/resume/cancel 拒绝 completed/cancelled；delete 拒绝 active/paused |
| 409  | `automation_target_unavailable` | 已有事情不存在、已停止或不属于该 owner                                                    |

## Scheduler 事务

Scheduler 是独立进程，只调用 Control Plane 的 Store，不直接启动 Agent。

每轮在 `BEGIN IMMEDIATE` 中：

1. 选择 `active` 且 `next_fire_at <= now` 的 Automation；
2. 以 `automationId + scheduledFor` 创建稳定 dedupe key；
3. 写入 `automation.due` Durable Inbox Event；
4. 写入 Invocation；
5. 推进下一次触发时间；
6. 一次性 Automation 变为 `completed`，周期 Automation 保持 `active`；
7. 提交事务。

任何一步失败都回滚 Event、Invocation 和 schedule 推进。已有 Event 的 Scheduler 崩溃时由 Inbox lease 重新领取，不重复创建 Invocation。

周期任务错过多个时刻时只投递一个最早已到期 Invocation，并把下一次触发推进到当前时间之后，避免机器休眠或长故障后产生通知风暴。

## Event 处理

Worker 对 `automation.due` 先验证 Invocation/Event provenance，然后使用 Automation 快照中冻结的目标和提示词：

- `new_task` 确定性创建 Task 与 queued Run；
- `existing_task` 确定性续接指定 Task 与 queued Run。

此路径不调用 Router 猜测归属。Router 仍只负责未指定目标的人类输入。实际 Executor 继续按 Run 的 execution snapshot、Mandate、Policy 和权限执行。

## 失败与恢复

- Inbox 领取失败、处理异常和重试沿用既有 lease 与 attempts；Invocation 同步显示 `processing`、退回 `pending` 或进入 `failed`。
- Event 已处理但响应丢失时，稳定 Event ID 和 Invocation 唯一约束阻止重复触发。
- 目标 Task 在计划触发后关闭时，Event 按 Inbox retry 结算为失败；不能由机器 Event 复活 completed/cancelled Task。
- Scheduler 进程退出由 Supervisor 作为受管子进程处理；重启后从 SQLite 的 `next_fire_at` 继续。
- schema v20 新增表不修改旧 Task、Run 或 Event。回滚目标不支持 v20 且仍有活跃 Automation 或 pending/processing Automation Event 时，Rollback Guard 拒绝切换；暂停/取消并结算 Event 后才允许回滚。

## 非目标

- 第一版不实现 cron、自然语言时区解析和复杂日历。
- 不实现外部 Webhook、天气、RSS 或任意条件表达式。
- 不共享 Automation 给其他用户，不实现组织级审批。
- 不无限补做历史触发，也不把每次触发复制成长期后台 session。

这些缺口完成前，`SCHEDULE-001` 保持 `Partial`，不能标记为完整 Scheduler。
