# Pegas 系统架构

> 状态：Draft 0.3
> 更新日期：2026-11-17

## 架构决策

第一阶段采用以下方向：

> DSH-first、Task-first、单一人格、内部多执行单元、执行后端可替换、恢复平面独立。

具体含义：

- **DSH-first**：使用 DSH 承载模型、Agent session、工具、技能、调度和执行能力。
- **Task-first**：Pegas 自己维护用户目标和任务生命周期，不能用聊天 session 代替 Task。
- **单一人格**：用户默认只和 Pegas 对话，内部 worker、sub-agent 和 session 不成为用户必须理解的概念。
- **内部多执行单元**：Pegas 可以为不同 Task 创建独立 Run，并按需并行或委派。
- **执行后端可替换**：DSH 是第一种 Run Executor，不进入 Pegas 核心领域模型。
- **恢复平面独立**：Pegas 主进程不负责守护和发布自己；小而稳定的 Supervisor 独立管理启动、健康检查、版本切换和回滚。

## 架构目标

系统需要保证：

1. 用户可以在同一段对话中随时插入不同事项。
2. 每个事项拥有独立、持久、可恢复的生命周期。
3. 对话端、任务端和执行端可以分别演进。
4. 长任务不依赖某个客户端或 session 一直在线。
5. 进程重启后不会丢失正在运行或等待中的事情。
6. 外部副作用可追溯，并尽量避免因重试而重复发生。
7. 用户可以随时查询、纠正、暂停、继续或取消任何事项。
8. 权限和审批由代码执行的策略控制，而不是只依赖模型遵守提示词。
9. Pegas 修改自身后可以通过候选版本验证安全接管，失败时自动回滚。
10. 即使 Control Plane 无法启动，用户仍有独立的状态查询、重启和回滚通道。

## 系统分层

```text
Web / App / macOS / Messaging
                │
                ▼
     Channel & Identity Gateway
                │
                ▼
       Durable Event Inbox
                │
                ▼
         Intent / Task Router
                │
                ▼
       Pegas Task Control Plane
     ┌──────────┼───────────┐
     ▼          ▼           ▼
  Memory     Scheduler     Outbox
     │          │           │
     └──────────┼───────────┘
                ▼
        Policy & Approval Engine
                │
                ▼
          Executor Adapter
                │
                ▼
              DSH
                │
                ▼
    Local / Sandbox / Remote Worker

Independent Recovery Plane
  Supervisor ── Health Check ── Release Registry
       │                              │
       ├── Restart                    ├── Active Release
       ├── Promote Candidate          └── Previous Release
       └── Rollback
```

主执行平面处理用户目标，恢复平面只维护 Pegas 的生命线。两者不能共享同一个进程生命周期，也不能要求 Control Plane 正常运行后才能执行回滚。

### 0. Supervisor 与 Recovery API

Supervisor 是独立于 Pegas Control Plane 的最小守护进程，负责：

- 启动和停止 Control Plane 与 Worker；
- 监测进程退出、`healthz` 和 `readyz`；
- 对候选版本执行启动验证和观察期；
- 候选版本失败时原子切回上一可用版本；
- 暴露独立、强认证、能力受限的 Recovery API；
- 防止同一节点同时运行两个主 Control Plane。

Recovery API 第一阶段只提供状态、重启和回滚，不提供任意命令执行。它应使用与 Pegas 主 API 不同的凭证，并在生产环境限制来源网络。

### 1. Channel & Identity Gateway

统一接收 Web、桌面端、移动端和消息渠道的输入，并将它们转换为相同的 Conversation Event。

职责包括：

- 识别用户与设备；
- 保留来源渠道和回复地址；
- 对输入进行去重；
- 处理附件和多媒体引用；
- 将通知投递到用户当前适合的渠道；
- 保证不同渠道面对的是同一个 Pegas 身份。

渠道只负责收发消息，不保存 Task 的权威状态。

语音是 Channel 输入适配，不是新的任务类型。Web 输入器使用浏览器 `MediaRecorder` 捕获一段用户主动发起的录音，Control Plane 通过可替换的 `SpeechRecognitionProvider` 调用独立模型服务。听写接口只把最终文字返回输入器供用户校对；用户明确发送后，文字才作为普通 `user.message` 进入 Durable Event Inbox。无输入器客户端也可使用幂等的直接语音消息接口。音频和流式 partial transcript 默认不持久化，ASR 失败时不能创建半成品用户消息。模型服务与 Pegas 进程分离，以便独立选择运行节点、升级模型和控制 GPU 资源。

### 2. Conversation Event Stream

记录用户、Pegas、工具和外部系统产生的事实事件。

每个事件至少包含：

- 稳定 ID；
- 事件类型；
- 来源身份与渠道；
- 时间；
- 内容或 artifact 引用；
- 可见范围；
- 关联的 Task 和 Run；
- 回复目标。

事件一旦写入便不应被原地改写。更正和撤销通过新的事件表达。

所有唤醒来源先写入 Durable Event Inbox。Inbox 使用稳定事件 ID、来源去重键、领取租约和失败次数；Worker 崩溃后，过期租约可以被其他 Worker 重新领取。同一用户的 Router 归属需要单写者或 fencing token，不同 Task 在归属后可以并行执行。

### 3. Intent / Task Router

Router 只负责确定一条新输入属于哪个 Task 或控制对象，例如：

- 创建新 Task；
- 补充或纠正现有 Task；
- steer 某个正在运行的 Run；
- 保存为 Idea；
- 创建或修改 Trigger；
- 回答一个 Approval。

Router 不直接回答任务内容，不判断某个工具是否存在，也不因为自己看不到 Executor 的工具而向用户索要安装或配置。工具能力、权限是否足够以及任务本身是否需要澄清，只能由加载了真实运行环境的 Agent 判断。Router 只有在“输入究竟属于哪个 Task”无法可靠确定时，才可以提出归属澄清。

Router 可以使用模型进行归属判断，但结果必须写入结构化数据。已有 Task 的执行单元也可以把不属于自身目标的消息退回 Router 重新分配。

第一版提供两级策略：显式 `taskId` 和无候选任务时使用确定性规则；存在多个活跃候选 Task 时可启用 Model Router。模型只返回 `create_task` 或引用候选 ID 的 `continue_task` 结构，输出无法解析、引用越权或 Provider 不可用时自动退回确定性新建策略，不能阻塞 Durable Inbox。

Pegas 的 Model Provider 是小型控制面边界，不依赖本机 Agent 客户端或其登录态。第一版提供常见厂商、聚合网关、本地模型服务和自定义连接目录，通过 OpenAI Chat Completions 或 Anthropic Messages 协议完成结构化判断。Provider API key 由服务端实例密钥加密保存，读取接口只暴露是否已配置；它不承载工具调用和长期执行。DSH Runtime 的模型路由、凭证和 Provider 保持在 DSH profile 内，避免 Pegas 核心与某个执行模型协议耦合。

### 4. Task Control Plane

Task Control Plane 是 Pegas 的核心，也是 Task 状态的唯一事实来源。

它负责：

- Task 创建、合并、拆分和关联；
- 状态迁移；
- 完成条件与约束；
- Run 创建、恢复、替换和终止；
- Task 间依赖；
- Trigger 唤醒；
- Approval 等待；
- Artifact 归属；
- 进度与完成事件；
- 用户纠偏和取消。

第一版状态：

```text
Inbox → Planning → Running → Waiting → Completed
                     ↘ Failed

任意未结束状态均可进入 Paused 或 Cancelled
```

状态需要同时保存原因，例如 Waiting 必须明确是在等待用户、时间、外部系统还是其他 Task。

### 5. Memory

Memory 为 Pegas 提供跨任务的长期认知，但不替代 Task 数据库。

至少分为：

- 用户偏好；
- 长期事实；
- 近期情境；
- 任务经验；
- 可复用过程；
- 受保护的敏感信息引用。

每条长期记忆需要包含来源、可见范围、更新时间和删除路径。Task 的当前状态、deadline 和审批不能只保存在 Memory 中。

### 6. Scheduler

Scheduler 管理：

- 指定时间执行；
- 周期性事项；
- 延迟重试；
- 超时；
- 外部事件触发；
- Task 依赖完成后的唤醒。

Trigger 属于 Pegas Task，而不是某个临时 session。更换 Run 或 session 后，Trigger 仍然有效。

Scheduler 不直接调用 Agent。它在事务中推进 Trigger 的下一次时间，并向 Event Inbox 写入稳定、可去重的唤醒事件。

### 7. Policy & Approval Engine

模型可以提出动作，Policy Engine 决定动作是否可以执行。

判断依据包括：

- 用户和来源身份；
- Task 的授权范围；
- 工具和资源；
- 数据敏感度；
- 动作是否对外产生副作用；
- 是否可撤销；
- 用户已经建立的长期授权规则。

Approval 是持久对象，可以跨进程和设备等待。审批通过只授权描述中的动作，不能自动扩大整个 Task 的权限。

### 8. Notification

Notification 根据 Task 事件决定是否以及在哪里联系用户。

默认只投递：

- 阶段性成果；
- 需要用户判断或授权；
- 无法自行解决的阻塞；
- 重要风险或目标变化；
- Task 完成或失败；
- 用户订阅的外部变化。

普通运行日志留在 Activity 中，不主动打扰用户。

Notification 从持久 Outbox 领取待投递消息，处理重试、顺序、合并、静默时段、目标渠道和未知投递结果。Control Plane 提交任务状态与待发消息后即可释放当前 Run，不依赖客户端保持在线。

第一版 Dispatcher 使用独立进程和 SQLite lease。每次投递增加尝试次数，失败后指数退避，超过上限进入 Failed；Webhooks 同时携带稳定 delivery ID 与 idempotency key，使接收端可以消除网络重试造成的重复通知。Supervisor 在启用推送时一并守护 Dispatcher。Webhook 是首个真实通道，后续 Web Push、APNs 或消息平台适配器复用同一接口。

### 9. Executor Adapter

Pegas 通过统一接口调度执行后端。第一阶段只有 DSH Adapter。

建议的最小接口：

```text
createRun(task, context) → run
send(run, input, mode) → receipt
inspect(run) → status
resume(run) → status
cancel(run, reason) → status
events(run, cursor) → run events
artifacts(run) → artifact refs
```

`mode` 至少区分：

- `start`：开始新的执行；
- `steer`：修正当前执行；
- `follow_up`：当前步骤结束后继续；
- `context`：只补充上下文，不要求采取新动作。

适配层把 DSH session、turn、tool call 和 Agent 状态转换为 Pegas Run Event。Pegas 核心领域不得直接保存或依赖 DSH 内部对象。

第一版 Adapter 使用 DSH headless 的进程边界：每个 Run 读取 NDJSON 事件流，收到 opening session event 后立即持久化 session ID，只有进程退出码为零且 final reason 为 completed 时才完成 Run。Worker 崩溃或租约过期后，新 Worker 使用已保存的 session ID 在同一 workspace 恢复，而不是创建一个无法关联的新 session。

用户消息写入 Inbox 后，HTTP 层只返回协议接收结果，Web 可以把 Inbox 状态显示为消息元数据，但不能生成一条冒充 Pegas 的固定回复。Router 完成归属后也不发送模板化“已开始”消息。真正的 Agent 加载当前工具、权限和工作区后，如果即将进行实质工具调用，应先生成一次具体确认，说明处理对象和预期结果，然后立即继续执行；直接回答则不额外制造确认。普通工具日志留在 Task Activity，只有结果、需要用户决策的问题和无法自行解决的阻塞进入 Conversation。

Adapter 对执行时间、stderr 和单条事件大小设置上限；中止或超时先发送 SIGTERM，宽限期后再 SIGKILL。额外可写目录通过重复的 `--add-dir` 显式传递，每次恢复都重新声明。即使 opening session event 缺失，terminal final event 中的 session ID 也会被持久化。

Headless 是第一版可验证实现，不是长期领域边界。未来切换为 DSH 进程内 Session Controller 时，仍需保持相同的 Executor Adapter、Run lease 和持久恢复语义。

## 核心领域对象

### Conversation

用户与 Pegas 的连续关系。它可以跨端、跨渠道，并允许任意话题进入。Conversation 不是任务隔离边界。

### Conversation Event

Conversation 中的一条不可变事实记录。

### Task

用户想完成的一件事情，拥有目标、完成条件、约束、状态、关系和长期生命周期。

### Run

Task 的一次具体执行。Run 可以失败、重试、替换或并行存在；Task 不因某个 Run 结束而自动结束。

### Trigger

使 Task 在未来重新进入可运行状态的条件。

### Approval

等待用户确认的结构化决定或动作授权。

### Action

一次可能读取或改变外部世界的工具调用。Action 必须有稳定 ID、风险等级和结果记录。

### Artifact

任务产生或使用的文件、文档、代码、链接、图片、报告和其他交付物。

### Memory

Pegas 对用户、环境和工作方式的长期认知。

### Release

Pegas 的一个不可变构建版本，包含 Git commit、构建产物校验值、兼容的 schema 范围、CI 结果和创建时间。正在运行的 Release 不允许原地修改。

### Deployment

一次 Release 切换尝试，记录旧版本、候选版本、健康检查、观察期、结果和回滚原因。

### Node

可以承载 Control Plane 或 Run 的执行节点。Node 记录能力、位置、心跳、当前版本和租约；手机客户端不是状态事实来源，也不是执行节点。

## Task、Run 与 Session 的关系

```text
Task A
├── Run A1 ── DSH Session 1（失败）
└── Run A2 ── DSH Session 2（恢复并完成）

Task B
└── Run B1 ── DSH Session 3（等待用户审批）
```

约束：

1. 一个 Task 可以有多个 Run。
2. 一个 Run 第一阶段对应一个主要 DSH session。
3. Run 可以创建内部执行单元，但这些不成为新的用户 Task，除非 Router 明确拆分。
4. session 被压缩、替换或丢失时，Task 仍然存在。
5. Task 完成由完成条件判断，不能仅凭模型回复“完成了”。

## 消息路由示例

用户连续输入：

```text
帮我研究个人知识库方案。
下周提醒我续费服务器。
知识库最好支持 Telegram。
记一个想法：Pegas 可以有情绪状态。
```

Router 应产生：

```text
Task A：个人知识库方案
  └── 更新约束：支持 Telegram

Task B：续费服务器
  └── Trigger：下周

Idea C：Pegas 情绪状态
```

Task A 和 Task B 可以分别创建独立 Run，但所有结果仍通过同一个 Pegas 返回。

## 持久化与恢复

### 事实来源

Pegas 需要自己的持久存储，至少保存：

- Conversation Event；
- Task；
- Run；
- Trigger；
- Approval；
- Action；
- Artifact metadata；
- Notification delivery；
- Memory metadata；
- DSH 对象映射。

### 写入原则

1. 先记录意图和即将执行的 Action，再调用外部系统。
2. Action 使用稳定 ID；可以支持幂等键的外部系统必须使用它。
3. 执行结果写回后才能推进 Run 状态。
4. 状态更新和待执行工作应尽量在同一事务内提交。
5. 无法确认是否已产生副作用时，进入 Waiting 或 Failed，不能盲目重试。
6. 重启恢复从结构化状态开始，不依赖模型回忆聊天内容。

### Outbox

发送消息、通知和可重试的外部写入使用持久 Outbox：

```text
Pending → Sending → Sent
                  ↘ Failed
                  ↘ Unknown
```

相同 Action ID 不应产生两个独立发送任务。

## 自我修改与发布

用户要求 Pegas 修改自身时，Router 创建普通 Task，并将目标资源标记为 Pegas Repository。执行过程必须使用隔离 worktree 或 sandbox，不得修改当前 Active Release：

```text
SelfChange Task
  → 创建隔离 worktree
  → 修改代码与文档
  → format / lint / typecheck / test
  → 构建不可变 Release
  → 备份状态并检查 migration 兼容性
  → Supervisor 启动 Candidate
  → readiness 与关键路径 smoke test
  → 原子切换 Active Release
  → 稳定观察期
     ├── 通过：确认新版本并保留上一版本
     └── 失败：回滚上一版本并恢复原 Task
```

### 发布门禁

候选版本至少通过：

1. 格式、lint 和类型检查；
2. 单元与集成测试；
3. 数据库 migration 检查；
4. 构建和依赖完整性检查；
5. 启动 readiness；
6. Event Inbox → Task → Worker → Outbox 的 smoke test；
7. Recovery API 与回滚路径测试。

Pegas 可以生成和验证候选版本，但不能绕过这些门禁，也不能直接修改 Supervisor 的授权策略。

### 数据与 migration

- 发布前创建可验证备份并记录恢复点；
- 优先使用 expand/contract migration，使新旧 Release 在观察期内都能读取数据；
- 删除字段、不可逆数据重写和降低兼容范围必须单独审批；
- migration 失败时不得切换 Active Release；
- 代码回滚不等于数据回滚，二者必须分别记录和验证。

### 恢复层级

| 故障                         | 恢复主体           | 默认动作                                     |
| ---------------------------- | ------------------ | -------------------------------------------- |
| Worker 异常退出              | Supervisor / lease | 重启 Worker，过期事件重新领取                |
| Control Plane 异常退出       | Supervisor         | 重启当前 Release                             |
| 候选版本无法启动或观察期失败 | Supervisor         | 自动回滚 Previous Release                    |
| 数据库损坏或 migration 失败  | Backup / Recovery  | 停止自动推进，恢复到已验证恢复点             |
| Mac 离线                     | Control Plane      | 将本地 Action 标记为 Waiting，其他 Task 继续 |
| Control Plane 所在主机失联   | 外部监控或备用节点 | 告警或通过租约接管；同一时刻只能有一个主节点 |

Supervisor 无法恢复宿主机断电、磁盘完全损坏或网络整体中断，因此长期运行还需要主机级进程守护、备份和外部健康监测。

## DSH 边界

### DSH 负责

- 模型与 provider；
- Agent session；
- 模型上下文与压缩；
- Tool、Skill 和 MCP；
- Agent turn 与 streaming；
- 内部执行单元；
- 第一阶段的调度与运行能力；
- 运行时产生的原始事件。

### Pegas 负责

- 唯一对外身份；
- 跨端 Conversation；
- Intent 与 Task Router；
- Task、Run 和 Trigger；
- 权限策略与 Approval；
- 用户级 Memory；
- Notification；
- Artifact 归属；
- Activity 与任务中心；
- 跨 Run、跨 session 和跨设备恢复。

## 模型出站隐私边界

Conversation、Task 和 Run 中的用户原文仍由服务端数据库保存为权威状态。开启
`PRIVACY-001` 后，Worker 只在受控的出站边界创建脱敏视图：Router 的模型 provider
与 DSH Executor 在收到内容前替换高置信度敏感值，响应回到 Pegas 可信边界后再恢复
稳定占位符。脱敏失败时调用不会继续，避免把未处理原文降级发送给外部服务。

第一阶段的反向映射仅驻留 Worker 内存，不写入 Conversation、日志或数据库。DSH 在
执行过程中读取文件、调用工具而产生的后续模型流量仍属于 DSH provider gateway 的
责任；Pegas 的 Executor wrapper 不能替代这层保护。完整规则、失败与回滚行为见
`docs/privacy-masking.md`。

## 运行设置边界

Router 模式、模型 Provider 与模型名、脱敏策略和输入改写策略由 Control Plane 通过
鉴权 API 写入 SQLite 单例记录。Web 与未来原生客户端只呈现这份服务端权威状态；
Worker 在每条事件和每个 Run 开始时读取完整 revision，因此变更无需重启，但不会中途
改变已经开始的调用。

Provider Base URL、API key、隐私 HMAC key、DSH profile 与可执行命令仍属于部署密钥
和运行能力，只能由服务端环境或密钥存储提供。设置 API 仅返回某项能力是否可用，
不能返回、修改或推断凭证。输入改写产生临时执行视图，Conversation Event 原文不变。
完整 schema、冲突与回滚行为见 `docs/runtime-settings.md`。

## 部署形态

开发阶段先支持单用户、本地闭环：

```text
Host Supervisor
├── Recovery API
├── Pegas Control Plane
├── Local Database
├── DSH Runtime
└── Local Tools
```

面向长期手机使用的目标形态是小型常在线控制面加可离线执行节点：

```text
Always-on Control Plane
├── Durable Inbox / Task / Outbox
├── Scheduler / Approval / Memory
└── Supervisor + Recovery API
          │
          ├── Mac DSH Node（本地文件与 App）
          └── Remote Sandbox Node（通用代码任务）
```

Task、Pegas 身份和发布状态属于 Control Plane，执行节点可以离线、更换或销毁。手机只作为经过认证的对话、审批和恢复终端，不保存权威任务状态。

## 第一阶段验证范围

原型只验证以下闭环：

1. 单一 Pegas 对话入口；
2. 从混合对话自动建立或更新多个 Task；
3. 每个 Task 使用独立 DSH Run；
4. Run 可以并行、steer、暂停和取消；
5. 进程重启后恢复 Task、Run 和等待条件；
6. 一个持久 Approval；
7. 一个时间 Trigger；
8. 一个具有幂等保护的外部 Action；
9. 结构化进度和最终交付；
10. 只读优先的 Activity 视图。
11. 独立 Supervisor 对异常退出自动重启；
12. 一个候选 Release 的健康验证和自动回滚；
13. 手机可访问但独立鉴权的恢复入口；
14. SelfChange Task 在隔离 worktree 中完成修改并通过 CI。

第一阶段不以接入大量工具、渠道或模型作为成功标准。

## 架构约束

- 不用一个无限增长的 session 表示整个 Pegas。
- 不用聊天摘要作为 Task 数据库。
- 不把 DSH session ID 暴露为用户概念。
- 不让模型直接修改权限策略。
- 不在没有 Action 记录的情况下执行外部副作用。
- 不因某个 Run 失败而自动判定整个 Task 失败。
- 不把内部多 Agent 结构默认暴露给用户。
- 不让客户端成为 Task 状态的事实来源。
- 不让第一种 Runtime 的 API 渗透到产品领域模型。
- 不由 Control Plane 守护、替换或回滚自身进程。
- 不修改正在运行的 Release 或直接在生产工作目录中开发。
- 不在没有备份和兼容性检查时自动执行破坏性 migration。
- 不让 SelfChange Task 绕过 CI、审批和发布门禁。
- 不把主 API 当作唯一恢复入口。
