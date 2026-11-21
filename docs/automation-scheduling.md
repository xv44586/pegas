# Automation 与持久时间触发

> Feature：`SCHEDULE-001`
>
> 状态：Partial
>
> 更新日期：2026-11-21

## 用户结果

用户可以把一个明确意图保存为 Automation，并设置一次执行时间或固定间隔。到点后，Pegas 创建新事情，或把提示词附加到一个仍然开放的已有事情。每次触发都必须留下 Invocation、Inbox Event、Run 和失败原因，不能依赖调度进程的内存定时器。

Automation 是独立产品对象。它不是 Task，不是 Run，也不是 DSH session；一条 Automation 可以依次产生多个 Task，一个 Task 也可以被重复唤醒。第一版界面中的“自动化”页只能读取这里返回的事实。

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

暂停清空下一次触发时间；恢复从当前时间重新计算下一次触发；取消永久结束 Automation。暂停、恢复和停止失败都返回稳定错误：

| 状态 | `error`                         | 含义                                   |
| ---- | ------------------------------- | -------------------------------------- |
| 404  | `not_found`                     | Automation 不存在或不属于该 owner      |
| 409  | `automation_command_conflict`   | 同一 command ID 用于不同 payload       |
| 409  | `automation_conflict`           | `expectedRevision` 已过期              |
| 409  | `automation_read_only`          | completed/cancelled 状态不允许该命令   |
| 409  | `automation_target_unavailable` | 已有事情不存在、已停止或不属于该 owner |

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
