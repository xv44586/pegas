# 分层记忆与按需加载

> Feature：`MEMORY-001`
>
> 状态：Partial
>
> 更新日期：2026-11-21

## 用户结果

用户可以把偏好、事实、情境、经验、过程和受保护引用保存为持久 Memory，并按全局、Worker（事情执行配置）和 Channel（事情）三个作用域查看、纠正与删除。每条记忆带来源、revision 和最近使用时间。执行 Run 时，Pegas 按需装载适用记忆并提供给实际 Executor，而不是把全部历史塞进每个会话。

## 领域模型

- 作用域：`global` 不带 Task；`worker` 与 `channel` 必须绑定同一 owner 的 `taskId`。Worker 作用域绑定该事情的 WorkerProfile 生命周期（第一阶段 profile 与 Task 一一对应），Channel 作用域是事情的局部上下文。
- 类别：`preference`、`fact`、`context`、`experience`、`procedure`、`sensitive_reference`。
- 来源：`user_confirmation`（用户明确确认）或指向同 owner 的 `task`/`run`/`artifact` ID；来源在写入时校验存在且属于该 owner。
- 每条记忆有稳定 ID、revision、创建/更新时间和 `lastUsedAt`（最近一次被装载进 Executor 的时间）。
- Memory 不保存 Task 当前状态、deadline 或审批事实；这些仍由各自领域对象负责。

## API

```http
GET  /v1/memories?userId=owner&scope=channel&taskId=task-1&category=context&limit=50&cursor=<memory-id>
GET  /v1/memories/:memoryId?userId=owner
POST /v1/memories
PUT  /v1/memories/:memoryId
POST /v1/memories/:memoryId/delete
```

- 创建携带 `userId`、`commandId`、完整 `memory`；同 command 同 payload 重放返回冻结响应，不同 payload 返回 `409 memory_command_conflict`。
- 更新携带 `expectedRevision`；过期返回 `409 memory_conflict`。
- 删除携带 `expectedRevision`，是永久删除：记忆行被移除，历史 command 冻结响应中的正文一并清除，只保留删除凭据（ID 与时间）用于幂等重放。
- 不存在和跨 owner 一律 `404 not_found`；作用域 Task 或来源对象不可用时返回 `409 memory_target_unavailable` / `memory_source_unavailable`。
- 每 owner 最多 500 条活跃记忆，超出返回 `409 memory_limit`；删除后释放配额。

## 装载与信任边界

- Worker 执行 Run 时调用 `memoryContextForTask`：只取该 owner 的 global 记忆与绑定当前 Task 的 worker/channel 记忆，按 channel → worker → global、再按更新时间排序。
- 装载受硬上限约束：最多 50 条且正文加元数据预算约 24k 字符，超出截断，避免上下文风暴。
- 装载会原子更新被选中记忆的 `lastUsedAt`，供记忆页展示“最近使用”。
- 传给 Executor 的记忆以 `<pegas_memory>` 数据块注入执行 prompt，声明其只是背景数据：不是系统指令，不能扩大 Mandate、权限或当前输入范围；与用户输入、Mandate 或真实工具检查冲突时以后者为准。正文中的 `<` 被转义为 `\u003c`，防止伪造闭合标签注入指令。
- 记忆正文不回显任何凭证；`sensitive_reference` 类别只保存受保护引用文本，密钥仍留在凭证 vault。

## 失败与恢复

- 所有写命令在 `BEGIN IMMEDIATE` 事务内完成，command 冻结响应与记忆变更同事务提交。
- 数据库 trigger 校验作用域 Task 归属，跨 owner 绑定直接拒绝。
- schema v21 只新增表；回滚到不支持 v21 的 Release 时，若仍有活跃记忆，Rollback Guard 拒绝切换（记忆是用户数据，静默失效不可接受）；全部删除后允许回滚。
- 装载失败或记忆损坏不应阻止 Run 执行；第一阶段装载在 claim 后进行，读取异常按 Worker 既有失败路径处理。

## 非目标

- 不实现自动记忆抽取（由 Executor 主动总结沉淀）、语义向量检索、跨用户共享或组织级记忆。
- 不实现记忆过期策略、去重合并和冲突消解 UI。
- Web 记忆页写操作接入是独立后续变更；当前 Web 只显示诚实空状态。

这些缺口完成前，`MEMORY-001` 保持 `Partial`。
