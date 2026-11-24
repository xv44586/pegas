# 分层记忆、自动积累与按需召回

> Feature：`MEMORY-001`
>
> 状态：Partial
>
> 更新日期：2026-11-24

本文同时记录已经落地的显式 Memory 合同和下一阶段已采纳、尚未实现的 Hindsight 最小闭环。设计内容不能当作实现证据。Feature 在自动积累、受控召回、删除不复活和真实自托管集成得到自动化证据前保持 `Partial`。

## 用户结果

已经实现的结果：用户可以把偏好、事实、情境、经验、过程和受保护引用保存为持久 Memory，并按全局、Worker（事情执行配置）和 Channel（事情）三个作用域查看、纠正与删除。执行 Run 时，Pegas 有界装载当前 Task 适用的显式记忆并提供给实际 Executor。

下一阶段结果：用户不需要逐条创建或审批派生 Memory。实际 Worker 完成工作、得到可验证失败、收到用户明确纠正或要求记住时，Pegas 在后台积累有来源的经验。下一次相关 Run 在开始前召回少量适用记忆。用户可以检查和删除派生记忆，删除后它不能因重试、重建或旧事件重放再次出现。

## 架构决定

### 两层记忆，一个 Pegas 权威边界

1. **显式 Memory**：继续存放在 Pegas SQLite，由当前 `/v1/memories` CRUD 管理。它代表用户钉住或明确维护的内容，在 prompt 中优先级高于派生记忆。
2. **派生 Memory**：第一实现使用自托管开源 Hindsight。它负责从 Pegas 提交的有界证据包中抽取、索引、归并和检索，不拥有 Pegas 的 owner、Task、Run、权限或删除事实。

Pegas Control Plane 始终是以下事实的唯一权威：

- owner 身份与隔离；
- Memory scope、来源和 source revision；
- Task、Run、Artifact、Approval 和当前授权；
- 派生写入 job、重试状态和稳定幂等键；
- 删除墓碑与用户可见投影；
- 召回过滤、排序合并、token 预算和最终 prompt 注入。

Hindsight 是可替换的 `DerivedMemoryProvider`，首版只使用 `retain`、`recall`、`list/get` 和 `delete/invalidate`。Provider API、部署方式或内部归并变化不得改变 Pegas 对外 Memory 合同。实现时必须固定经过验证的开源版本、容器镜像 digest 和许可证记录，升级按 Provider 合同与真实集成测试重新验证。

### Worker 使用，Router 不使用

Worker 需要长期 Memory 来复用偏好、决策和经过验证的执行经验。Router 不读取 Hindsight，也不从通用 Memory 猜测输入归属。Router 只使用服务端 Conversation/Task 状态、Task Directory 和显式 Routing Policy。

Router 不能创建派生候选、选择 Hindsight bank、判断记忆可信度或把记忆内容变成控制意图。用户输入中的“继续刚才的事情”由 Task Directory 处理。项目技术约定、历史失败和执行方法由目标 Worker 召回。

## 已实现的显式 Memory 合同

### 领域模型

- 作用域：`global` 不带 Task；`worker` 与 `channel` 必须绑定同一 owner 的 `taskId`。Worker 作用域绑定该事情的 WorkerProfile 生命周期，Channel 作用域是事情的局部上下文。
- 类别：`preference`、`fact`、`context`、`experience`、`procedure`、`sensitive_reference`。
- 来源：`user_confirmation` 或指向同 owner 的 `task`、`run`、`artifact` ID。来源在写入时校验存在且属于该 owner。
- 每条记忆有稳定 ID、revision、创建/更新时间和 `lastUsedAt`。
- Memory 不保存 Task 当前状态、deadline、Approval 或即时权限。这些始终从对应领域对象读取。

### API

```http
GET  /v1/memories?userId=owner&scope=channel&taskId=task-1&category=context&limit=50&cursor=<memory-id>
GET  /v1/memories/:memoryId?userId=owner
POST /v1/memories
PUT  /v1/memories/:memoryId
POST /v1/memories/:memoryId/delete
```

- 创建携带 `userId`、`commandId` 和完整 `memory`。同 command 同 payload 重放返回冻结响应，不同 payload 返回 `409 memory_command_conflict`。
- 更新携带 `expectedRevision`，过期返回 `409 memory_conflict`。
- 删除携带 `expectedRevision`，永久移除记忆行并清除历史 command 冻结响应中的正文，只保留删除凭据用于幂等重放。
- 不存在和跨 owner 一律 `404 not_found`。作用域 Task 或来源对象不可用时返回 `409 memory_target_unavailable` 或 `memory_source_unavailable`。
- 每 owner 最多 500 条活跃显式记忆，删除后释放配额。

### 装载与信任边界

- Worker 执行 Run 时调用 `memoryContextForTask`，只取该 owner 的 global 记忆与绑定当前 Task 的 worker/channel 记忆，按 channel → worker → global、再按更新时间排序。
- 装载最多 50 条且正文加元数据预算约 24k 字符，避免上下文风暴。
- 被选中的记录原子更新 `lastUsedAt`。
- 记忆以 `<pegas_memory>` 数据块注入，声明为背景数据而非系统指令。它不能扩大 Mandate、权限或当前输入。与用户输入、Mandate 或真实工具检查冲突时以后者为准。
- 正文中的 `<` 转义为 `\u003c`。`sensitive_reference` 只保存受保护引用文本，密钥仍留在 credential vault。

## Hindsight MVP Intake（Planned）

### 最小闭环

```text
可靠的 Run/Task 事件或用户明确纠正
  → Pegas durable memory job
  → owner/scope/敏感数据校验
  → Hindsight retain
  → 后台抽取、索引和归并

新的 work Run
  → Pegas 构造受限 recall query
  → Hindsight recall
  → Pegas owner/scope/tombstone 二次过滤
  → 与显式 Memory 合并并裁剪预算
  → 注入实际 Worker Executor
```

### 自动写入事件

第一版只从四类可追溯事件生成 durable job：

1. **Run success**：保存已验证结果、关键决策和确实有效的方法。
2. **Run failure**：只保存证据已经支持的失败原因和恢复方式。模型猜测、瞬时错误和未核实归因不能成为稳定经验。
3. **用户明确纠正或要求记住**：由拥有完整 Task/Run 上下文的实际 Worker 或后台提取步骤识别，Pegas 校验来源后新增或 supersede。Router 不参与判断。
4. **Task 完成**：保存最终决策、剩余风险和下次继续所需的最小上下文。

默认后台自动处理，不要求用户逐条批准。弱单次推断只保留在事件历史，不直接形成稳定规则。只有显式规则互相冲突并阻塞当前任务、敏感内容无法安全保存，或 scope 歧义会显著影响后续行为时才询问用户。

不得发送或持久化：模型隐藏思考过程、凭证/密钥、Approval 内容、无界工具输出、与候选无关的完整会话、其他 owner 数据。写入前应用既有隐私策略和新增的 Memory 数据最小化过滤。

### Bank、来源和幂等映射

- 每个 owner 使用独立 Hindsight bank：`pegas-owner:<opaque-owner-hash>`。哈希必须由服务端密钥派生，不能把原始 owner ID 发送给 Provider。
- 派生记录至少带 `taskId`、`runId`、`eventId`、`sourceRevision`、`outcome`、`scope` 和 `capturedAt`。用户界面只展示必要来源，不暴露内部 bank ID。
- 全局经验标记 `scope:global`。局部经验使用服务端从 execution snapshot 得到的规范化、HMAC 后 `execution-context` key。第一版明确以规范化 workspace 根路径作为输入，不发送原始路径。不同 worktree 保持不同 context，跨 worktree 聚合押后到稳定 Project/Repository 领域对象建立以后。context key 缺失时不能把局部经验降级为全局。
- `document_id` 使用稳定来源，例如 `pegas-run:<runId>` 或 `pegas-task:<taskId>:final`。memory job ID 由 event ID 与 source revision 派生。相同事件重放必须命中同一操作，不能生成重复记录。

### 受控召回

- 每个 work Run 在实际 Executor prompt 构造前至多自动召回一次。conversation/chat lane 和 Router 不接 Hindsight。
- query 由 Pegas 服务端根据 Task 标题、当前用户输入、Worker 配置、规范化 execution context 和最近失败/等待原因构造。不能让 Provider 自行读取整个 Task 数据库。
- 只查询当前 owner bank。允许 `scope:global` 和当前 execution-context，局部 context 不匹配的结果必须丢弃。
- Hindsight 返回最多 8–12 条候选。Pegas 合并显式 Memory、去重并裁剪后，派生记忆注入预算为 1,200–2,000 tokens。显式 Memory 优先，派生记录不足时不填充无关内容。
- 记录“检索到、过滤掉、注入”三个阶段的 ID 和原因，不能把“已检索”误报为“实际使用”。首版不要求模型逐条引用，但必须为后续效果评估保留注入证据。
- 派生内容与显式 Memory 一样是不可信数据，不能授予权限、恢复 cancelled Task、表达 Approval、扩大 Mandate 或覆盖真实工具状态。

### 用户管理面

记忆页继续以 Pegas API 为唯一入口，合并展示显式与派生记录：

- 显式记录保留完整编辑、revision 和作用域操作。
- 派生记录展示有界摘要、来源 Task/Run、scope、生成时间和最近注入时间。第一版至少支持查看和删除，编辑可以延后。
- 用户删除派生记录时，Pegas 先写 tombstone 并立即从列表默认视图和后续注入中排除，再异步调用 Provider 删除或 invalidate。
- tombstone 保存稳定来源键和最小审计信息，不保留已删除正文。旧事件、重试和索引重建必须先检查 tombstone。

## 验收条件

1. 用户明确纠正一次后，下一次相似任务不会继续使用被替代的旧结论。
2. 有来源的成功方法或已验证失败原因能跨 Task 召回，并且与当前输入和真实工具事实不冲突。
3. 不同 owner 永不共享 bank 或结果。execution-context 不匹配时不注入局部经验。
4. retain、recall 或 list 超时、返回畸形数据、进程退出时，Run 仍能执行和结算，显式 Memory 仍正常工作。
5. 相同事件重复投递、Worker 崩溃恢复和 job 重领不会产生重复记录。
6. 删除后立即停止注入。Provider 暂时不可用、进程重启、旧事件重放或索引重建都不能让正文复活。
7. 记忆页能区分显式与派生来源，用户无需逐条审批即可检查和删除。
8. 自动化证据覆盖 Provider 合同、job/outbox、owner/context scope、预算、prompt 信任边界、tombstone 与真实 retain→recall→delete 链路。

## 数据与权限边界

- Control Plane 生成 Provider capability。Executor 和 Router 不持有 Hindsight 管理凭证，不能绕过 Pegas 直接写 bank。
- Provider adapter 只接受已经绑定 owner 和来源的内部命令。任意客户端提交的 `bank_id`、owner tag 或 source metadata 都不能成为权威输入。
- Memory 只能影响执行上下文，不能增加工具、权限、网络访问、workspace 写范围或 Approval 豁免。
- Task 当前状态、deadline、等待问题、Artifact 完整性、Approval 和授权始终从权威领域对象读取，不能从 Hindsight 回忆。
- 首版不支持跨 owner、团队或组织共享。若以后增加共享，必须新增明确的 Feature Intake、ACL 和撤权后删除/重建验证。

## 失败、恢复与回滚

- Run/Task 终态与 memory job 在 Pegas 事务中提交。Provider 网络调用在事务外异步执行，不能延长或回滚 Run 结算。
- job 使用 lease、稳定 operation ID、指数退避和有界重试，记录最后错误。超出重试预算后进入可观察停放状态，不静默丢失，也不循环打扰用户。
- recall 设置短超时并 fail-open。失败只记录结构化日志和指标，不创建用户待办，除非持续故障导致产品明确无法提供已承诺的 Memory 能力。
- 删除采用本地 tombstone 先行。远端删除失败时后台重试，本地列表和 prompt 继续保持删除状态。
- Hindsight 关闭或不可用时，当前 schema v21 显式 Memory 的 CRUD、分层装载和 prompt 形状保持兼容。Provider 开关是回滚入口。
- 新增数据库对象必须是纯增量。旧版本可以忽略 memory job、派生投影和 tombstone 表，不得覆盖或格式化现有显式 Memory。
- 开发与自动化可以使用临时 Hindsight 实例。官方嵌入式存储仅用于开发和本地试点，状态保持 `Partial`。升级 `Usable` 前必须验证受 Supervisor 管理的服务、持久数据库、备份恢复、删除一致性和升级回滚。

## 非目标

- Hindsight `reflect`、Mental Models 和开放式用户画像。
- 自动把经验晋升为 Skill。
- 完整会话、全部工具日志或每轮聊天的无差别写入。
- 文档知识库、代码索引或通用 RAG。
- Router 长期记忆或基于 Memory 的 Task 路由。
- Worker 直接调用 Hindsight MCP。
- 每条记忆的用户审批流程。
- 跨 owner、团队或组织共享。
- 在没有稳定领域对象时引入虚假的 Project scope。

## 当前证据与状态

已经落地的显式层由 `test/memory.test.ts` 覆盖字段、作用域、来源、幂等、revision、删除清理、owner 隔离、分层装载、容量、HTTP 与 Executor 注入边界。`test/rollback-compatibility.test.ts` 覆盖 schema v21 活跃记忆的回滚保护。Web 已接入显式 Memory 的查看、创建、编辑和删除。

M1 派生层已经实现：

- `src/memory/derived-memory.ts` 定义可替换 Provider、owner bank/workspace context 的 HMAC 映射、召回二次过滤和显式来源投影；`src/memory/hindsight-provider.ts` 以直接 HTTP 接入 retain、operation status、recall、list/get 和 invalidate，不把 SDK/MCP 或 Provider 凭证交给 Executor。
- schema v49 新增 durable retain job、curation job、本地召回投影、Run 注入证据和 tombstone。Run 成功/失败只写有界 input/outcome evidence，credential-like 内容先确定性遮盖，不写思考过程与无界工具日志；作业以稳定 UUID、`document_id`、lease 和有界重试在事务外执行。
- 每个 work Run 在 Executor 前最多召回一次；显式 Memory 排在派生 Memory 前。Hindsight 超时、畸形响应或不可用时 fail-open，不阻断 Run；Router 和 conversation lane 均不读取 Hindsight。
- `GET /v1/derived-memories` 与记忆页展示本地实际召回过的派生记录。删除先写 tombstone、清除正文投影并立即停止注入，再由 curation job 异步调用 Hindsight invalidate；不创建 Approval 或用户待办。
- 配置默认关闭；启用时必须显式提供 `PEGAS_HINDSIGHT_BASE_URL` 和独立的 `PEGAS_MEMORY_HMAC_KEY`。首个验证基线固定为 Hindsight v1.2.3、MIT、完整镜像 `ghcr.io/vectorize-io/hindsight@sha256:601cfdd1bd3f6053864c6458ee15259f065a01a3f83090b56a8ae57db67f8f38`。

自动化证据位于 `test/derived-memory.test.ts`、`test/derived-memory-store.test.ts`、`test/derived-memory-processor.test.ts` 与 `web/src/App.test.tsx`，覆盖 HTTP wire contract、弱相关结果丢弃、owner/context 二次隔离、Run 终态原子入队、稳定提交后只轮询不重投、失败如实措辞、recall fail-open、tombstone 防复活、异步 invalidate、API 与 Web 删除无需审批。

最终质量门禁：`pnpm check` 通过 142 个测试文件 / 1433 个测试（statements 85.27%、branches 78.13%、functions 89.68%、lines 88.37%，Server/Web/Desktop 构建通过）；`pnpm smoke` 通过完整多进程 Task→Run 链路；`pnpm smoke:crash` 通过 event claim、tool call 与 write-back 三个崩溃恢复注入点。门禁期间旧 DSH 500ms SIGTERM→SIGKILL 计时用例曾在高负载下抖动两次，隔离复跑与最终全量均通过，未修改该测试或阈值。

`MEMORY-001` 仍保持 `Partial`：尚未用受 Supervisor 管理、带持久 PostgreSQL 的真实 Hindsight 实例跑 retain→recall→invalidate canary，也未验证其备份恢复和版本升级；列表当前是“Pegas 实际召回投影”而非远端 bank 的完整浏览器；用户纠正的 dedicated supersede 事件和记忆效果评测仍是下一缺口。
