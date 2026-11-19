# Channel、Worker 与委派协作

> Feature：`CHANNEL-001`
>
> 状态：CHANNEL-001 Usable；其余拆分能力 Planned
>
> 更新日期：2026-11-19

本文定义 Pegas 的 Channel 产品模型、Worker 配置继承、跨 Channel 协作协议和 Web 交互合同。它是后续 `WORKER-001`、`COLLAB-001`、`CHANNEL-002`、`CHANNEL-003`、`NOTIFY-003`、`USAGE-001`、`MEMORY-001` 与 `SCHEDULE-001` 的共同边界。

## 用户结果

用户默认只需要和一个持续存在的 Pegas 对话。Pegas 自动把输入归入持久的工作 Channel；用户需要深入查看或直接纠偏时，可以进入某个 Channel 与当前 Worker 继续对话，并查看路由、执行、工具、结果和协作记录。

Channel 之间可以受控委派、交接和传递上下文。协作必须经过 Pegas Control Plane，保留授权、因果关系、状态回传和失败恢复证据；Worker 不能建立绕过 Router、Policy、Event Inbox 和 Outbox 的私有通信链路。

## 定位边界

- **Pegas 是唯一默认入口和对外身份。** Channel 列表、Worker 设置和执行详情是按需展开的控制面，不是开始对话的前置步骤。
- **Channel 是持久工作容器，不是物理 session。** 一个 Channel 可以经历多个 Run、Executor Session、模型或运行环境，而不丢失目标、状态和历史。
- **Worker 是 Pegas 下属的工作配置，不是独立顶层 Bot。** Worker 可以有图标、工作角色、模型覆盖和范围化记忆，但不拥有绕过 Pegas 的权限或对外身份。
- **服务端对象仍使用 Task 作为权威工作生命周期。** Web 和其他客户端把 Task 投影为 WorkChannel；第一阶段不重命名数据库表，也不迁移稳定 ID。
- **普通进度保持安静。** 主对话和 Outbox 只显示可用结果、需要用户决定的问题、阻塞、失败和重要责任变化；详细活动留在 Channel。

## 领域模型

```text
Pegas
├── Conversation
├── WorkChannel (Task projection)
│   ├── WorkerProfile
│   ├── ChannelEvent
│   ├── Run
│   │   └── ExecutorSession
│   ├── ChannelRelation
│   └── Automation
└── OutboxItem
```

### WorkChannel

WorkChannel 是客户端和用户使用的名称，权威生命周期仍由服务端 Task 保存。第一阶段 `channelId === taskId`，API 同时明确返回 `taskId`，避免未来投影 ID 与领域 ID 分离时产生歧义。

WorkChannel 至少包含：

- 稳定 ID 和所属用户；
- 标题、目标、状态和状态原因；
- 创建、结束、最近活动时间；
- 当前 WorkerProfile 引用；
- Run、ChannelEvent、Artifact 和 OutboxItem 引用；
- 来源、父子、依赖、委派和交接关系；
- 搜索使用的用户可见内容索引。

### WorkerProfile

WorkerProfile 保存 Channel 的工作角色与可选覆盖。所有 Worker 默认继承用户开始时配置的 Pegas 全局 Agent 模型，不为每个 Worker 复制一份默认配置。

```text
effective configuration
  = Pegas global defaults
  + WorkerProfile explicit overrides
```

规则：

- 未覆盖字段随全局默认变化；已覆盖字段保持 Worker 值。
- 清除覆盖后立即恢复继承，不把当时的全局值复制成新覆盖。
- 每次 Run 保存有效配置快照；历史 Run 不因之后修改默认值或覆盖而变化。
- 运行中 Executor Session 不原地更换模型。影响执行的配置变化从下一 Run 或受控 Session rollover 生效。
- 工作人设是范围化执行角色，不是独立对外人格。

### ChannelEvent

ChannelEvent 是不可变的用户可见或可检查事实。更正、撤销和状态变化使用新事件表达；Web 可以把同一协作对象的最新投影视为“原地更新”，但不得覆盖审计历史。

第一批事件类型：

- `channel.created`
- `channel.input.received`
- `channel.input.routed`
- `run.started`
- `run.progressed`
- `run.waiting`
- `run.completed`
- `run.failed`
- `collaboration.requested`
- `collaboration.accepted`
- `collaboration.returned`
- `collaboration.handed_off`
- `collaboration.failed`

隐藏指令、密钥、原始凭证、受保护工具参数和未经净化的 stderr 不属于用户可见 ChannelEvent，也不能进入全文索引。

## 三种跨 Channel 协作

### 委派 Delegation

来源 Channel 保持目标责任，等待目标 Channel 返回结构化结果。

```text
Source Channel ── delegation request ──▶ Target Channel
Source Channel ◀── result delivery ──── Target Channel
```

### 交接 Handoff

责任从来源 Channel 转移到目标 Channel。来源保留审计记录，但不再等待继续执行；交接不能自动扩大授权范围。

```text
Source Channel ── ownership transfer ──▶ Target Channel
```

### 上下文传递 Context note

只传递一个带来源的事实，不创建新 Channel、不改变责任、不授予新权限。目标 Worker 可以使用，也可以标记无关。

```text
Source Channel ── scoped fact ──▶ Target Channel
```

## 协作控制协议

Worker 只能提出结构化意图，不能直接创建或私聊另一个 Worker：

```ts
type WorkerCollaborationRequest =
  | {
      kind: 'delegate'
      goal: string
      reason: string
      expectedOutput: string
      contextRefs: string[]
    }
  | {
      kind: 'handoff'
      goal: string
      reason: string
      contextRefs: string[]
    }
  | {
      kind: 'context_note'
      targetChannelId: string
      text: string
      sourceRefs: string[]
    }
  | {
      kind: 'handback'
      inputEventId: string
      reason: string
    }
```

Control Plane 负责：

1. 校验来源 Run 仍拥有协作请求；
2. 检查 Task 授权、Policy、成本和外部副作用边界；
3. 选择已有 Channel、创建新 Channel、退回 Router 或要求用户确认；
4. 原子写入 ChannelRelation、目标输入和来源状态；
5. 使用稳定 dedupe key 唤醒目标 Channel；
6. 目标结束后把结构化结果送回来源 Channel；
7. 仅在需要用户注意时写 Outbox。

不得让来源 Worker 指定目标 Executor Session、绕过目标 Channel 的输入队列，或把目标 Worker 的自由文本直接拼接进自己的隐藏上下文。

## Report、结果回传与 Watchdog

正常状态的事实来源是 Worker 主动 Report，不是外围轮询。

```text
Executor
  └─ Report(started | progress | waiting | ready | blocked | failed)
       ↓
Control Plane transaction
  ├─ update Run / WorkChannel
  ├─ append ChannelEvent
  ├─ deliver result to source Channel when related
  └─ enqueue OutboxItem when attention is required
```

### 正常路径

- Worker 在开始、阶段性进展、等待、完成和失败时提交结构化 Report。
- Control Plane 是 Run、Task/WorkChannel 和协作关系的唯一写入者。
- 委派完成时，Control Plane 在同一事务中标记关系状态、写入来源 Channel 的 `collaboration.returned` 输入，并提交目标 Channel 的最终报告。
- 来源 Channel 的下一 Run 从 Event Inbox 读取返回结果；来源 Worker 不需要常驻等待。
- Outbox 只负责用户注意力与外部投递，不承担 Channel 之间的内部事实同步。

### Watchdog 恢复路径

Watchdog 只发现异常，不宣布正常完成：

- Worker 定期续租正在执行的 Run；
- lease 过期表示 Worker 失联或宿主停止，不表示目标失败或成功；
- 恢复器把旧 Run 标记为 `lease_expired`，创建关联旧 Run 的恢复 Run，并使用已保存 Executor Session；
- 超时、未结 effect、投递失败和长时间无 heartbeat 分别使用明确原因记录；
- Supervisor 监测进程与版本健康，不能成为业务状态事实来源；
- Watchdog 不解析 Agent 自然语言，不推测完成度，不重复投递已由 dedupe key 结算的结果。

## Web 信息架构

### 左侧导航

- Pegas 主入口固定在顶部；返回后进入跨 Channel 的主对话。
- `Channels` 是平铺列表，不使用会无限变深的树形导航。
- `Outbox` 是独立入口，显示未读和需要处理的数量。
- Channel 行展示 Worker 图标、状态颜色、标题、最新用户可见活动、时间和可选来源标记。
- 由委派创建的 Channel 使用“来自：来源 Channel”作为次要信息；父子关系不改变列表排序。
- 收缩态只保留展开按钮，延续现有交互合同。

### Pegas 主对话

- 自动委派只显示一条紧凑系统事件：来源图标、目标图标、目标标题、原因摘要和当前状态。
- 普通 progress 和上下文 note 不进入主对话。
- 等待确认、阻塞、失败、重要结果和责任交接进入主对话或 Outbox。
- 事件卡点击后先在右侧工作区预览；“进入 Channel”才切换主会话上下文。

### 来源 Channel

时间线在协作发生的位置显示委派卡。卡片是同一协作对象的当前投影，状态从 `待调度 → 运行中 → 等待确认 → 已返回` 更新；不可变事件仍保存在服务端历史中。

完成后卡片展示简短结果、返回时间和目标 Channel 入口，不复制目标 Channel 的完整工具日志。

### 目标 Channel

- 顶部显示“由来源 Channel 委派”和返回目标。
- 第一条不可修改记录展示目标、提供的上下文引用、权限范围和结果返回位置。
- 后续是目标 Worker 的完整对话与活动记录。
- 用户在目标 Channel 输入时显式携带 `channelId/taskId`，不重新猜测全局归属。

### 右侧工作区

右侧工作区展示协作详情：来源、目标、原因、状态、创建者、有效模型、权限、上下文引用、返回目标和失败恢复。存在多个下游关系时使用可读列表，不引入流程图编辑器。

### Outbox

Outbox 只收录：

- 需要用户批准的委派或交接；
- Worker 等待用户回答；
- 委派失败、超时或恢复失败；
- 重要结果已返回；
- 工作责任发生交接。

Outbox 的投递状态与产品已读状态分离；`sent` 不代表用户已经阅读。

## 搜索、排序与过滤

- 搜索字段：Channel ID、标题、目标、用户可见对话、净化后的工具摘要和 Artifact 名称。
- 默认不索引：隐藏提示词、密钥、原始工具参数、完整 stderr、已删除内容。
- 排序：最近活动、创建时间、结束时间；必须有稳定 ID 作为次级排序键。
- 过滤：工作状态、是否结束、是否由委派创建、WorkerProfile、是否需要用户处理。
- 搜索结果返回片段和稳定 event cursor，进入后定位到原始时间线位置。

## 权限、幂等与恢复

- 新 Channel 只继承来源 Mandate 中明确允许的范围；扩大范围必须重新审批。
- `collaboration.requested` 使用来源 Run ID 和请求序号生成稳定幂等键。
- 创建目标 Channel、写 ChannelRelation、写目标输入必须在同一事务中完成。
- 目标结果用关系 ID 和目标最终 Report ID 去重；响应丢失后重试不会让来源收到两次。
- 取消委派不能删除已经产生的事实或副作用；它只阻止新的自动输入，并记录取消原因。
- 来源 Channel 结束后返回的结果仍保留在关系记录中；是否重新打开来源由策略决定，不能静默丢失。
- 删除或隐藏 Channel 时必须处理未完成协作关系、Automation 和 Outbox 引用。

## Feature 拆分与依赖

| Feature        | 用户闭环                                                                      | 依赖                                     | 本轮状态 |
| -------------- | ----------------------------------------------------------------------------- | ---------------------------------------- | -------- |
| `CHANNEL-001`  | 服务端 Task 以 WorkChannel 投影供 Web 使用；主入口与 Channel 直接对话边界明确 | `TASK-001`, `CONV-002`                   | Usable   |
| `CHANNEL-002`  | Channel 时间线显示结构化输入、路由、Run、工具摘要和结果                       | `CHANNEL-001`, `EXEC-001`                | Planned  |
| `WORKER-001`   | Worker 继承全局模型并支持显式覆盖、配置快照和受控 Session rollover            | `CHANNEL-001`, `SETTINGS-001`            | Planned  |
| `COLLAB-001`   | 委派、交接、context note、handback 和结果回送形成持久闭环                     | `CHANNEL-002`, `WORKER-001`, `ROUTE-002` | Planned  |
| `CHANNEL-003`  | 按 ID/对话搜索，并按创建/结束时间和状态排序过滤                               | `CHANNEL-002`                            | Planned  |
| `NOTIFY-003`   | Web Outbox 提供列表、详情、已读和 Attention 操作                              | `NOTIFY-001`, `CHANNEL-001`              | Planned  |
| `USAGE-001`    | 按 Worker、Channel、Run 记录供应商真实 token、cache、延迟和费用来源           | `WORKER-001`, `CHANNEL-002`              | Planned  |
| `MEMORY-001`   | 全局、Worker 范围和 Channel 局部记忆可查看、纠正和删除                        | `WORKER-001`, `CHANNEL-001`              | Planned  |
| `SCHEDULE-001` | Automation 独立保存；Invocation 经 Event Inbox 唤醒当前或新 Channel           | `CHANNEL-001`, `WORKER-001`              | Planned  |

推荐交付顺序：

```text
CHANNEL-001
  ├─ CHANNEL-002 ── CHANNEL-003
  ├─ WORKER-001 ── USAGE-001
  ├─ NOTIFY-003
  └─ CHANNEL-002 + WORKER-001 ── COLLAB-001
                                   ├─ MEMORY-001
                                   └─ SCHEDULE-001
```

每个 Feature 使用独立 branch、worktree、验收证据和提交，不把后续 Planned 能力伪装成 `CHANNEL-001` 已实现。

## CHANNEL-001 验收条件

1. 新增服务端 WorkChannel 只读投影，稳定映射现有 Task，不复制权威状态。
2. Web 快照使用 Channel 投影；发送到选中 Channel 时仍显式携带权威 `taskId`。
3. 左侧导航和用户可见文案把工作容器称为 Channel，同时保留 Pegas 主入口。
4. 选择 Channel 后可以查看现有 Run/结果并直接继续；返回 Pegas 后新输入恢复自动路由。
5. 老客户端 `/v1/tasks` 与现有 Task/Run 数据继续工作；无需数据库迁移即可回滚。
6. 自动化覆盖 Channel 投影、用户隔离、兼容 API、显式 Channel 输入和 Web 选择行为。
7. `pnpm check` 与 `pnpm smoke` 通过；桌面、窄桌面和移动关键状态无横向溢出或不可达控件。

## CHANNEL-001 非目标

- 不实现 WorkerProfile 持久化或模型覆盖。
- 不实现真实委派、交接、全文搜索、已读 Outbox、用量、记忆或定时任务。
- 不重命名 Task 数据表、Router schema、Run 外键或外部 webhook 字段。
- 不修改正在进行的品牌图标 Feature，不引入临时图标替代品。

## 回滚

`CHANNEL-001` 只增加兼容 API 投影并修改 Web 读取与文案。回滚时 Web 恢复读取 `/v1/tasks`，服务端可移除 `/v1/channels`；Task、Run、Inbox 和 Outbox 数据无需迁移或回写。
