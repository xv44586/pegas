# Channel、Worker 与委派协作

> Feature：`CHANNEL-001`
>
> 状态：CHANNEL-001、NOTIFY-003、USAGE-001 Usable；其余拆分能力按 Feature Map 追踪
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

### 生命周期合同

WorkChannel 可以复用，但只复用于同一件工作的后续，不得清空历史后承载无关目标。完成结束当前工作轮次，不删除 Channel，也不结束它保存目标、授权来源、历史和关系的持久生命周期。

```text
                     同一目标的用户输入 + 当前授权复核通过
                    ┌────────────────────────────────────┐
                    ▼                                    │
Backlog → Unstarted → Started → Completed（软结束）──────┘
Backlog / Unstarted / Started ── 用户明确停止 → Cancelled（硬结束）
```

- `completed` 表示当前工作已经结束，是可恢复的软结束状态。恢复创建新 Run 和新的执行绑定，不修改或复用旧 Run。
- `cancelled` 只表示用户明确停止，是不可恢复的硬结束状态。原 Channel 永远保持只读；后续工作必须重新接单并创建新 Channel，用关系记录它与原 Channel 的来源，不能把原 Task 改回未开始。
- `archived` 只属于产品展示和保留策略，不是 Task 执行状态；归档不能撤回授权，也不能改变能否恢复。
- Run、Worker Runtime 和 Executor Session 与 Channel 分别结束。Run 进入终态后不再写入；Runtime 在无前台 turn、后台任务或交接等待时释放 slot；Session 只保留可选恢复引用。
- 同一 Channel 可以先后经历多个 Run、Assignment、Runtime 和 Session。历史身份由 Channel ID 和不可变事件维持，不由进程或 Session ID 维持。
- 当前 Run 的 Worker 可以提交结构化 `ready` 或 `dropped` Report。现有完成条件没有未满足项时，`ready` 结束为 completed，`dropped` 结束为 dropped；绑定了审批、Artifact 或外部 Thread 等完成条件时，`ready` 只进入等待，直到 Control Plane 验证条件满足。自由文本和 Runtime 正常退出不能结束 Channel。Planned 的 `GOAL-001` 会进一步要求 `ready` 引用当前 Goal revision 的 EvidenceRef，并由 Control Plane 逐项生成 Review Pack；该设计不扩大 Router 或 Worker 的完成判定权，见 `docs/goal-contract-and-evidence.md`。

#### 谁可以恢复

- 用户在已完成 Channel 内直接发送输入时，稳定的 Channel/Thread 订阅关系把输入附加给原 Channel；Control Plane 复核原 Mandate 后恢复，无需新建 Router Decision。Worker 负责处理原范围内的输入，超范围输入 hand back 给 Router。
- 用户从 Pegas 主入口发送输入时仍由 Router 判断创建新 Channel 或 `continue_task`。`continue_task` 只负责附加输入；如果目标已完成，后续恢复由同一 Mandate 状态机完成，而不是让 Router 判断授权。
- Worker、定时扫描、CI、普通 progress、上下文 note 和其他机器事件不能单独恢复已完成 Channel。
- 委派中的来源 Channel 在等待目标返回时保持 `started`，并使用 `waiting_on_dependency` 等状态原因，不得提前标记 `completed`。如果结果到达时来源已经 completed 或 cancelled，结果仍写入关系和时间线并按需进入 Outbox，但不能由机器事件静默恢复来源。
- 已 `cancelled` Channel 中的新输入不能申请恢复；服务端返回结构化拒绝并允许用户把输入复制到“新建相关 Channel”。

#### 恢复事务

Control Plane 在一个事务中完成恢复：

1. 锁定 Task/WorkChannel，校验用户归属和当前状态；
2. 拒绝 `cancelled`，并给出“新建相关 Channel”路径；重新接单只允许新建 Channel，不能复活原 Channel；
3. 用当前 Policy 复核原 Mandate：Source 仍监听原 Thread、Actor/接单依据仍满足原强度、推断规则仍启用且处于 auto 模式、scope 未扩大；
4. 使用输入 Event ID 作为幂等键追加 `channel.resumed` Input，清除软结束记录并创建一个新 Run；
5. 保证同一 Channel 同时最多一个会消费输入的 active Run，重复请求返回同一个恢复结果；恢复期间到达的其他输入按 Event ID 有序排队或按既有合并规则处理；
6. 根据 Session 兼容性决定恢复旧 Session 或创建新 Session；
7. 提交后再启动 Worker effect，响应丢失后的重试不得创建第二个 Run。复核失败时保持 completed，不消费输入，并把输入退回 Router/Eval；不能改写为 cancelled。

Session 兼容性至少比较 Executor 类型、模型、工作区身份、工具/权限集合、WorkerProfile 版本和运行协议版本。任一项不兼容、引用不存在或恢复被执行器明确拒绝时，保留旧引用用于审计，从持久化 Channel 摘要创建新 Session；不能为了“继续上下文”而绕过新权限。

Executor Session 只能在同一 Channel 内作为恢复候选，不能跨 Channel 复用。新的相关 Channel 可以继承经过授权筛选的目标摘要和 Worker 默认配置，但不能继承旧 Channel 的隐式会话历史、未确认工具状态或执行凭证。

#### 停止事务与竞态

用户停止必须优先于普通输入和机器结果，并在一个事务中记录 `ended: { by: "human", outcome: "stopped", at, reason }`、清空未交付输入并结束所有未终结 Run。事务提交后再执行 Worker Runtime 停止 effect。第一版直接使用当前 Run ID、状态和 worker claim 作为 Assignment fence；旧 Worker 的 Report 因 Channel/Run 已结束而被拒绝，不另造 generation 字段。

停止后的旧 Worker Report 直接以 ended Task/Run 拒绝，并只记录拒绝日志；不能把它当成新的 Channel 事实。停止前已提交到外部系统、后来由 Source 观测到的结果仍可作为独立 Trigger/审计事实保存并通知用户，但不能覆盖 stopped 状态、生成自动输入或恢复 Channel。重复停止使用稳定 command ID 幂等返回同一结果。

### WorkerProfile

WorkerProfile 保存一件事情的内部执行配置。所有事情默认继承用户开始时配置的 Pegas 全局 Agent 模型，不为每件事情复制一份默认配置。

```text
effective configuration
  = Pegas global defaults
  + task-scoped explicit settings
```

规则：

- 未覆盖字段随全局默认变化；已覆盖字段保持 Worker 值。
- 清除覆盖后立即恢复继承，不把当时的全局值复制成新覆盖。
- 每次 Run 保存有效配置快照；历史 Run 不因之后修改默认值或覆盖而变化。
- 运行中 Executor Session 不原地更换模型。影响执行的配置变化从下一 Run 或受控 Session rollover 生效。
- 工作人设是范围化执行角色，不是独立对外人格。

产品文案统一称为“事情级执行设置”。第一阶段 `WorkerProfile` 只是服务端内部对象，按权威 Task 唯一持久化；WorkChannel 不增加第二层配置，界面也不显示内部 profile ID。所有者通过 `GET /v1/tasks/:taskId/worker-profile?userId=…` 读取原始与有效配置，通过 `PUT /v1/tasks/:taskId/worker-profile` 携带 command ID 和 expected revision 更新继承或模型覆盖。覆盖模型的 Provider ID 与模型 ID 必须精确匹配当前隔离 DSH profile 的模型目录；Provider 凭证仍留在 DSH，不进入 profile 或 API 响应。

schema v17 会为既有 Task 回填 revision 1 的继承配置，并用 Task insert trigger 覆盖回滚期间旧应用写入的新 Task。新生产 DSH Run 在路由事务内解析有效配置，保存结构化模型引用、WorkerProfile ID/revision/来源、DSH profile、workspace、权限集合和协议，并标记执行契约 v2。数据库阻止旧 Worker claim v2 Run、在报告恢复阶段直接接管 v2 Run，或把它的 retry 降级为 v1；新版 Worker 在启动 Executor 前严格验证快照。后续全局设置或事情级设置变化只影响新 Run。第一阶段 Web 仅以“来源 · 版本”展示事情级执行设置，事情级编辑器、角色与工具权限覆盖仍属于 `WORKER-001` 后续缺口。

#### API 合同

读取：

```http
GET /v1/tasks/task-123/worker-profile?userId=owner
```

```json
{
  "profile": {
    "revision": 2,
    "modelMode": "override",
    "modelProvider": "discovery-api",
    "modelName": "deepseek-v4.1-flash-1017"
  },
  "effective": {
    "source": "task",
    "modelMode": "override",
    "modelProvider": "discovery-api",
    "modelName": "deepseek-v4.1-flash-1017",
    "modelRef": "discovery-api/deepseek-v4.1-flash-1017"
  }
}
```

更新：

```http
PUT /v1/tasks/task-123/worker-profile
Content-Type: application/json
```

```json
{
  "userId": "owner",
  "commandId": "profile-command-123",
  "expectedRevision": 2,
  "modelMode": "inherit"
}
```

| 状态 | `error`                    | 含义                                                       |
| ---- | -------------------------- | ---------------------------------------------------------- |
| 200  | —                          | 读取、更新或仍在保留窗口内的相同命令重放成功               |
| 400  | `bad_request`              | 请求结构、长度、枚举或 revision 无效                       |
| 404  | `not_found`                | Task 不存在或不属于调用用户；两种情况故意返回相同响应      |
| 409  | `worker_profile_conflict`  | `expectedRevision` 已过期                                  |
| 409  | `worker_profile_read_only` | 事情已停止，新的设置命令被拒绝；已成功命令仍可重放         |
| 422  | `worker_model_unavailable` | 覆盖模型不在当前隔离 DSH profile 的目录                    |
| 503  | `agent_models_unavailable` | DSH 模型目录未配置或临时读取失败；新增模型覆盖 fail closed |

模型目录使用 5 秒有界缓存并合并并发读取；失败不缓存。每个 Task 只保留最近 256 条 command 响应用于重放，避免无限增长。命令重放先于 Task 可写状态和模型目录检查，因此网络响应丢失后的同一请求不会因事情后来停止或目录临时失败而改变结果。

### ChannelEvent

ChannelEvent 是不可变的用户可见或可检查事实。更正、撤销和状态变化使用新事件表达；Web 可以把同一协作对象的最新投影视为“原地更新”，但不得覆盖审计历史。

第一批事件类型：

- `channel.created`
- `channel.input.received`
- `channel.input.routed`
- `channel.completed`
- `channel.resumed`
- `channel.stopped`
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

### 第一阶段 API 与持久化合同

Worker 通过当前 Run 的短期 capability 提交请求；实例 bearer 不能替代 Run claim：

```http
POST /v1/runs/run-123/collaborations
X-Pegas-Run-Claim-Token: <current-run-capability>
Content-Type: application/json
```

请求体使用上面的四种 union，并额外携带稳定 `commandId`。幂等键的作用域是来源 Run，其他 Run 或其他 owner 可以安全使用相同字符串。同一 Run、claim、`commandId` 与完全相同 payload 的网络重放始终返回创建时冻结的 201 关系快照，保证首次响应丢失后仍可恢复；历史 claim 不能通过重放读取后来写入的状态或 result，也不能提交新的 command。相同来源 Run 内以同一 `commandId` 提交不同 payload 返回 `409 collaboration_command_conflict`。每个来源 Task 同时最多保留 8 个 `pending` 或 `active` 的委派/交接关系，超限返回 `409 collaboration_fanout_limit`。

所有者读取一件事情作为来源或目标参与的关系：

```http
GET /v1/channels/task-123/collaborations?userId=owner&limit=50&cursor=<relation-id>
```

关系按最新写入优先返回，默认 50、最大 200 条，更多结果通过 `nextCursor` 获取。查询 Task 不存在和跨 owner 均返回相同 `404 not_found`；context note 目标不存在、跨 owner、关闭或 self-target 均返回相同 `404 collaboration_target_unavailable`。普通 `/v1/events` 调用不能提交 `collaboration.*` 类型或 `collaboration` source；这些事件只能由 Control Plane 创建。

schema v19 持久化 `channel_relations`。来源 Run、owner、kind、请求、冻结创建响应和 parent/root/depth provenance 写入后由数据库 trigger 保持不可变；状态、目标/返回 Event 和结果只能沿受控转换更新。委派和交接在一个 `BEGIN IMMEDIATE` 事务中创建关系、目标 Inbox Event、目标 Task 和独立 WorkerProfile；目标不继承来源 WorkerProfile、Executor Session 或 claim，但首次协作 Run 必须以来源 Run 的不可变执行快照作为模型、工作区、工具、权限、隐私与协议上界，并记录 `authoritySourceRunId`。context note 保留目标的模型和 profile，只有 Executor、协议、workspace 与 executor profile 兼容时才创建 Run，权限模式、审批策略、附加目录和隐私模式取来源与目标的最小权限交集；来源只作为 provenance，不能扩大目标授权。目标 WorkerProfile 仍为独立身份，后续由用户直接输入产生的 Run 才重新解析它自己的有效配置。context ref 必须解析到来源 Task 已有的 Event、Run、Artifact 或 Evidence；目标 ID、Session、Executor、模型、工具与权限不属于请求协议。

目标 Run 创建、Task Event 写入和关系从 `pending` 切换到 `active/completed` 位于同一事务；任一步失败时不能留下孤立 Run。handoff 创建时即写入按 relation ID 去重的责任交接 Outbox。目标正常完成时，Control Plane 在完成事务内结算关系、写来源时间线和去重 Outbox。委派来源仍开放时，`collaboration.returned` 创建新的 Run，原等待 Run 以 `continued_by:<eventId>` 结束；来源已经 completed/cancelled 时，返回事件直接记为 processed，只保留审计与通知。嵌套 handoff 的中间 Task 在最终目标结算前保持 `waiting_on_dependency`，成功后沿 parent/root 链逐层完成；下游失败时中间 Task 收到可恢复的失败输入。handback 成功重新归类 `origin` 或 `resumed` 输入后，把只因该输入启动/恢复的来源 Task 软结束为 `completed/handed_back`；活跃 Task 上的普通 `continuation` 被退回时保留原 Task，避免丢失它此前未完成的责任。context note 与 handback 的投递失败属于非责任型失败，并把来源保留在可检查、可恢复状态；即使事件被重新领取也不能凭机器事件恢复来源 Task。目标停止结算为失败；尚未送达的 context note 同样明确失败。协作 target/return Event 达到最大重试次数时，Event、关系、来源等待状态、时间线和 Outbox 原子结算，不能留下 failed Event 对应 pending/active relation；目标关闭会同时退役 pending 或 processing 的保留事件。

协作请求有持久上界：每个 owner 最多 64 条 pending/active 关系，每个来源 Run 最多 32 条命令，每个来源 Task 最多 8 个活跃委派/交接，每棵协作关系最多 32 条且深度最多 4，单个目标最多 4 条待投递 context note；self note 被拒绝。关系持久化 `parentRelationId/rootRelationId/depth`，数据库 trigger 验证真实父 Task、事件 kind、payload relation/task ID 和返回事件的来源 Task，不能把后代挂到另一棵 root 或借其他协作事件伪造关系。handback 只接受入口在认证后显式写入 `authenticatedActor=human` 的外部 `user.message`，不能根据 `source` 名称或文本内容推断人类授权；retry Run 沿 retry lineage 取回该 ID，新 Task 继承原 Mandate，内部协作/Approval/结果事件和未认证的自动化输入都不能被重新包装成用户授权。schema v19 不对历史事件追溯补写人类证明，因此迁移前的输入不能直接 handback，需要用户重新发送或通过新的认证入口确认。持有 authorized Action successor capability 的 Worker 必须先记录 Action outcome；Action 已为 `failed/unknown` 时则必须先完成人工 reconciliation，不能通过协作清除 claim 和核对生命线。

`collaboration.*` Inbox Event 使用消费契约 v2。新版 Worker 只领取自己支持的事件契约，数据库 trigger 会拒绝旧 Worker 的 v1 claim；保留事件的过期 owner 必须先显式释放并清空 claim contract，再由新版 Worker 重新领取，旧 Worker 不能继承上一次 v2 claim 的版本标记。回滚到不支持 schema v19 的 Release 时，Supervisor 先使当前子进程进入受控重启并等待其全部停止，再执行最终数据库检查；存在 pending/processing 协作事件或 pending/active 关系时以 `rollback_incompatible` 拒绝切换并重新启动当前 Release，排空或结算后才允许回滚。

| 状态 | `error`                                 | 含义                                   |
| ---- | --------------------------------------- | -------------------------------------- |
| 201  | —                                       | 新关系创建或相同命令的冻结响应重放成功 |
| 400  | `bad_request`                           | union、引用或字段无效                  |
| 403  | `run_claim_required/invalid`            | 缺少、过期或错误的当前 Run capability  |
| 404  | `not_found`                             | 查询的 Task 不存在或不属于调用用户     |
| 404  | `collaboration_target_unavailable`      | note 目标不可用且不暴露存在性          |
| 409  | `collaboration_command_conflict`        | command ID 已被不同请求使用            |
| 409  | `collaboration_fanout_limit`            | 来源 Task 的活跃委派/交接已达到硬上限  |
| 409  | `collaboration_budget_limit`            | owner/Run/root/depth/note 预算已达上限 |
| 409  | `collaboration_action_outcome_required` | 必须先记录 authorized Action outcome   |
| 409  | `collaboration_reconciliation_required` | failed/unknown Action 必须先人工核对   |

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
- Channel 行展示固定蓝色 Worker 图标、形状化状态徽记、状态文字、标题、最新用户可见活动、时间和可选来源标记。
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

### CHANNEL-003 API 与索引合同

```http
GET /v1/channels/search?userId=owner&q=Telegram&status=started,completed&ended=false&needsAttention=true&workerIconId=computer&sort=updated&limit=25&cursor=<channelId>
```

- `q` 同时匹配稳定 Channel ID 和用户可见全文；最多 200 个 Unicode 字符。
- `status` 接受逗号分隔的五种 Task 状态；`ended` 区分活动与结束 Channel；`needsAttention` 只匹配未读 Outbox 或等待用户的 Approval。
- `sort` 为 `updated`、`created` 或 `ended`，并以 Channel ID 做稳定次级排序；`cursor` 是上一页最后一个 Channel ID。
- 响应返回 `channels`、最多 50 条 `matches` 片段和可选 `nextCursor`。片段标明 `sourceKind`、`sourceId` 与 `channelId`，不返回隐藏指令或原始工具参数。
- schema v18 使用 SQLite FTS5 trigram 索引标题、目标、用户输入、Run 输出、Worker Report、Artifact 名称和用户可见 Outbox 文本。事务触发器覆盖待路由的显式 Channel 输入；迁移时回填既有可见事实。
- 读取始终先按 `userId` 过滤。其他用户的 Channel、索引片段、游标和待处理状态不会出现在响应中。
- 按 WorkerProfile 与委派来源筛选依赖后续 `WORKER-001` 编辑器和 `COLLAB-001` 关系投影；Web 目前仍使用内存搜索，接入此 API 属 DESIGN-002 的后续交互工作。

自动化证据位于 `test/channel-search.test.ts`：中文 trigram 查询、其他用户隔离、跨用户 TaskEvent 拒绝索引、待路由输入、标题/片段、生命周期与注意力过滤、稳定游标、查询长度上界、HTTP 参数校验、数据库重开索引和迁移后事实保留。`pnpm check`（37 个测试文件、366 个测试，statement 84.31%、line 87.29%）与真实进程/SQLite/HTTP 的 `pnpm smoke` 通过。

## 权限、幂等与恢复

- 新 Channel 只继承来源 Mandate 中明确允许的范围；扩大范围必须重新审批。
- `collaboration.requested` 使用来源 Run ID 和请求序号生成稳定幂等键。
- 创建目标 Channel、写 ChannelRelation、写目标输入必须在同一事务中完成。
- 目标结果用关系 ID 和目标最终 Report ID 去重；响应丢失后重试不会让来源收到两次。
- 取消委派不能删除已经产生的事实或副作用；它只阻止新的自动输入，并记录取消原因。
- 来源 Channel 结束后返回的结果仍保留在关系记录中；是否重新打开来源由策略决定，不能静默丢失。
- completed 来源收到机器结果时保持 completed；cancelled 来源保持不可恢复。只有通过授权复核的用户输入可以恢复 completed 来源。
- 删除或隐藏 Channel 时必须处理未完成协作关系、Automation 和 Outbox 引用。

## 实现审查补充

### 必须复用的现有能力

- Event Inbox 的 Event ID 和现有 RoutingDecision 幂等边界用于恢复去重，不另建旁路队列。
- Task 与 Run 继续由 `PegasStore` 和 Control Plane 单写，不让 Web 直接改状态。
- 现有 Run lease、retry lineage、Executor ref 和 fencing 用于运行时恢复，但“失败重试”与“已完成 Channel 恢复”必须是两个显式命令。
- Outbox 继续只承载用户注意力；Channel 状态和结果关系不能以通知投递状态为准。

### 实现前必须关闭的缺口

1. 现有显式 `taskId` 路径会把 completed 和 cancelled 一并变回 `unstarted`，而 retry 路径又拒绝二者；`TASK-002` 必须让 `continue_task` 只附加输入，由单一 `wake/resume` 状态机决定 completed 能否恢复并永久拒绝 cancelled。
2. 当前没有持久 Mandate。第一阶段至少保存恢复依据、Policy/配置版本和停止来源；后续再扩展完整授权对象，不能把“用户拥有 Task”当成永久授权。
3. 当前 continuation 会直接复用最近的 Executor ref。必须引入可解释的 Session compatibility 结果，并覆盖模型变化、工作区变化、权限收窄和引用丢失。
4. Router 当前只把活跃 Task 作为模型候选。主入口恢复需要先通过 Channel 搜索/索引召回有限候选，不能把全部历史 Channel 塞进模型上下文。
5. completed、cancelled、archived 和 deleted 必须分别建模。删除仍需单独的数据保留与协作引用策略，本轮不借生命周期改造顺手实现删除。
6. 停止与 Worker 最终结果存在竞态。必须先原子写 ended/Run 状态，再异步停止 Runtime，并用当前 Run/claim 身份拒绝旧 Worker 的 Report；不能只向进程发送一个尽力而为的 SIGTERM。
7. 旧数据没有结构化停止来源或 Session 兼容性记录。迁移时历史 `cancelled` 一律保守视为不可恢复；历史 `completed` 可申请恢复，但旧 Executor ref 默认不兼容，除非适配器能用当前配置给出确定性通过。
8. `/v1/events` 是异步入口。Web 的只读状态只是预防误操作，服务端仍必须权威拒绝竞态输入，并持久化 TriggerDisposition/RoutingDecision 的拒绝原因供 Channel 时间线投影。

### 实现合同

- 领域命令必须分开：结构化 Report、内部 `wake/resume`、`stopTask` 和 `retryRun` 不共享一个“改状态并创建 Run”的通用入口。每个入口都有独立前置条件、command/event 幂等键和审计事件。
- `continue_task` 只表示把用户输入附加到已有 Task；显式 `taskId` 也必须经过同一状态机。恢复是 ended Channel 接收合格 human Input 后的领域转换，不是 Router 的授权决定。
- 第一阶段直接实现 Super Agent 的不可变 Mandate，不新增 Pegas 专属恢复授权对象：`strength`、`policyVersion`、`basis`（Source、接收范围、接单路径、sender、matched rules）、`actor` 和 `scope`。`policyVersion` 只覆盖接单规则、accept mode 和各 Source Policy，不混入模型、并发数等执行设置。结束不删除 Mandate；用户停止标记 withdrawn，复核失败记录 revoked/拒绝恢复。Task owner 不能替代 Mandate。
- Run 需要保存可比较的 execution-context fingerprint，覆盖 Executor、模型、工作区、工具权限、WorkerProfile/全局设置 revision 和协议版本。`WORKER-001` 可以扩展该快照，但 `TASK-002` 不能依赖运行时临时值猜测兼容性。
- 服务端投影至少返回 `canResume`、`canStop`、`endedKind` 和结构化拒绝原因；Web 只按投影渲染按钮，不在客户端复制状态机。
- 停止不是回滚。提交停止事务后不得产生新的自动副作用；停止前已经提交、无法撤销或结果未知的外部副作用必须保留审计并明确显示。

### 非目标

- 不在本 Feature 实现完整 Mandate/Approval 产品、全文搜索、删除/保留策略或跨 Channel Session 复用。
- 不让 Router 用模型自行判定权限、Session 兼容性、完成证据或停止是否成功。
- 不保证外部副作用 exactly-once，也不把停止解释为撤销已经发生的现实世界动作。

### 验证矩阵

| 场景                                 | 预期结果                                        | 测试层级                      |
| ------------------------------------ | ----------------------------------------------- | ----------------------------- |
| completed Channel 内用户继续         | 原子追加 resume 事件并创建一个新 Run            | Store + Control Plane 集成    |
| 同一 Event 重复提交                  | 返回同一 Run，不重复恢复                        | Store 幂等回归                |
| 两个客户端并发恢复                   | 只有一个 active Run；另一输入排队或合并         | SQLite 并发集成               |
| cancelled Channel 内发送             | 服务端拒绝静默恢复，Web 提供新建相关 Channel    | API + Web E2E                 |
| started/completed 时用户停止         | 原子取消活动 Run 并永久关闭原 Channel           | Store + Control Plane 集成    |
| 停止命令重复或响应丢失               | 返回同一停止结果，不重复写事件                  | Store 幂等回归                |
| 停止后旧 Worker/工具结果晚到         | fenced；只保留审计事实且不改变状态              | Worker 并发 + smoke           |
| Policy 或权限已经收窄                | 保持 completed，输入回到 Router/Eval 并显示原因 | Policy 集成                   |
| 模型或工作区不兼容                   | 新建 Session，旧引用保留审计                    | Executor Adapter 单元 + smoke |
| 历史 cancelled/completed 数据迁移    | cancelled 永久关闭；completed 安全新会话恢复    | migration 回归                |
| 来源等待委派结果                     | 结果唤醒仍 started 的来源                       | 协作集成                      |
| completed/cancelled 来源收到机器结果 | 只记录和通知，不恢复来源                        | 协作回归                      |
| Worker 在恢复提交后、启动前崩溃      | 新 Worker 领取同一 queued Run                   | lease/restart smoke           |

### 性能边界

- Channel 内显式恢复按稳定 ID 查询，事务内不得扫描历史事件。
- Pegas 主入口只向 Router 提供搜索召回的固定上限候选；排序使用最近活动时间和稳定 ID，不能随历史 Channel 数量线性增长模型输入。
- Runtime 释放后，Session、工作区和 Artifact 使用独立保留策略；垃圾回收不得删除仍被 Channel、Run、协作关系或审计事件引用的对象。
- active Run 的唯一性必须由索引或事务约束保证，不能先查询再在无锁窗口中插入；输入队列按 Event ID/接收序稳定排序。

## Feature 拆分与依赖

### CHANNEL-002 第一阶段：隔离时间线投影

本阶段先修复 Channel 读取边界，使现有 Inbox、Run 和 Outbox 事实按权威
`taskId` 投影，避免 Web 把 Pegas 主对话的全局快照误当成任意 Channel 的历史。

验收条件：

1. 进入或深链到 Channel 后，只显示该 Channel 关联的用户输入、Run 和 Outbox
   结果；切换 Channel 时不能短暂回退显示上一份全局历史。
2. 显式发送到 Channel、但 Router 尚未处理的 pending 输入，仍能按 payload 中的
   `taskId` 出现在该 Channel 时间线。
3. 服务端先校验 Channel 归属，再返回隔离投影；其他用户得到 404，不能通过 ID
   枚举时间线。
4. Pegas 主入口继续使用跨 Channel 的主对话快照；Channel 投影加载失败时显示错误
   或空态，不能回退到全局事件和消息。
5. 自动化至少使用两个同用户 Channel 和一个其他用户 Channel，证明正向内容可见、
   相邻内容不可见，并覆盖 Web 从全局对话切换到 Channel 的反向隔离。

非目标：

- 本阶段不新增完整 ChannelEvent schema，不伪造尚未由 Executor 持久化的工具调用。
- 不实现跨 Channel 协作卡、全文搜索、游标、数据迁移或历史回填。
- 不改变 Pegas 主对话的信息降噪策略，也不把 Outbox 投递状态作为 Channel 权威状态。

数据、权限与失败边界：

- 现有 `task_events`、`runs.task_id` 和 `outbox_messages.task_id` 是第一阶段事实来源；
  pending 显式输入只在 payload 为合法 JSON 且 `taskId` 精确匹配时补入投影。
- 接口必须同时按 `channelId` 和 `userId` 校验，不能依赖客户端过滤。
- 本阶段只新增兼容查询索引，不改字段、不重写事实数据；回滚应用代码时索引可以安全
  保留，也可以随后删除。接口失败不会污染或删除历史，恢复连接后重新拉取即可。

| Feature        | 用户闭环                                                                                | 依赖                                                               | 本轮状态 |
| -------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------- |
| `CHANNEL-001`  | 服务端 Task 以 WorkChannel 投影供 Web 使用；主入口与 Channel 直接对话边界明确           | `TASK-001`, `CONV-002`                                             | Usable   |
| `TASK-002`     | completed Channel 可经授权复核恢复；用户停止后原 Channel 永久关闭；Run/Runtime 独立结束 | `TASK-001`, `CHANNEL-001`, `EXEC-003`, `WORKER-001` 的执行快照边界 | Partial  |
| `CHANNEL-002`  | Channel 时间线显示结构化输入、路由、Run、工具摘要和结果                                 | `CHANNEL-001`, `EXEC-001`                                          | Partial  |
| `WORKER-001`   | 事情继承全局模型并支持显式覆盖、配置快照和受控 Session rollover                         | `CHANNEL-001`, `SETTINGS-001`                                      | Partial  |
| `COLLAB-001`   | 委派、交接、context note、handback 和结果回送形成持久闭环                               | `CHANNEL-002`, `WORKER-001`, `ROUTE-002`                           | Partial  |
| `CHANNEL-003`  | 按 ID/对话搜索，并按创建/结束时间和状态排序过滤                                         | `CHANNEL-002`                                                      | Usable   |
| `NOTIFY-003`   | Web Outbox 提供列表、详情、已读和来源 Channel 跳转                                      | `NOTIFY-001`, `CHANNEL-001`                                        | Usable   |
| `USAGE-001`    | 按 Worker、Channel、Run 记录供应商真实 token、cache、延迟和费用来源                     | `WORKER-001`, `CHANNEL-002`                                        | Usable   |
| `MEMORY-001`   | 全局、Worker 范围和 Channel 局部记忆可查看、纠正和删除                                  | `WORKER-001`, `CHANNEL-001`                                        | Partial  |
| `SCHEDULE-001` | Automation 独立保存；Invocation 经 Event Inbox 唤醒当前或新 Channel                     | `CHANNEL-001`, `WORKER-001`                                        | Planned  |

推荐交付顺序：

```text
CHANNEL-001
  ├─ WORKER-001 execution snapshot ── TASK-002
  │                                └─ USAGE-001
  ├─ CHANNEL-002 ── CHANNEL-003
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
- 不实现真实委派、交接、全文搜索、记忆或定时任务；已读 Outbox 与模型用量已分别由后续 `NOTIFY-003`、`USAGE-001` 独立实现。
- 不重命名 Task 数据表、Router schema、Run 外键或外部 webhook 字段。
- 不修改正在进行的品牌图标 Feature，不引入临时图标替代品。

## 回滚

`CHANNEL-001` 只增加兼容 API 投影并修改 Web 读取与文案。回滚时 Web 恢复读取 `/v1/tasks`，服务端可移除 `/v1/channels`；Task、Run、Inbox 和 Outbox 数据无需迁移或回写。
