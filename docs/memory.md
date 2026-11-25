# 分层记忆、自动积累与按需召回

> Feature：`MEMORY-001`
>
> 状态：Partial
>
> 更新日期：2026-11-25

本文记录已经落地的显式 Memory 合同和 Hindsight 派生记忆最小闭环。独立评审（2026-11-25）发现两项 P1 与多项 P2 后，本 Feature 从 `Usable` 降回 `Partial`。两项 P1（凭证遮盖绕过、waiting Run 假成功经验）、删除的远端持续对账和 operation 轮询预算已修复并有回归测试；剩余 P2/P3 缺口关闭并通过完整门禁后才能恢复 `Usable`。

## 用户结果

用户可以把偏好、事实、情境、经验、过程和受保护引用保存为持久显式 Memory，并按全局、Worker（事情执行配置）和 Channel（事情）三个作用域查看、纠正与删除。对于派生 Memory，用户不需要逐条创建或审批：实际 Worker 在 Run 成功或失败后异步提交有界证据，下一次相关 work Run 在开始前召回少量适用记忆。用户可以查看完整派生 bank、直接纠正或删除；旧内容立即停止注入，Provider 恢复、ID 重建和后台重试不会绕过 Pegas tombstone。

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

## Hindsight M1（已实现）

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

第一版只从三类可追溯事件生成 durable job：

1. **Run success**：只在 Run 真正进入 `completed` 终态时入队——普通 Run 直接完成，或 goal-contract Run 的 Worker Report 通过全部必需证据审查。处于 `waiting`（待证据/待审批/待澄清）的 Run 不产生成功经验；后续审查判 failed 时入队对应 `run_failure`。保存已验证结果、关键决策和确实有效的方法。
2. **Run failure**：只保存证据已经支持的失败原因和恢复方式。模型猜测、瞬时错误和未核实归因不能成为稳定经验。
3. **用户明确纠正**：记忆页提交 dedicated correction command；Pegas 在同一事务内落旧内容 tombstone、移除投影并创建 durable supersede job。Router 不参与判断。用户主动要求保存一个新事实时继续使用显式 Memory 创建入口。

默认后台自动处理，不要求用户逐条批准。弱单次推断只保留在事件历史，不直接形成稳定规则。只有显式规则互相冲突并阻塞当前任务、敏感内容无法安全保存，或 scope 歧义会显著影响后续行为时才询问用户。

不得发送或持久化：模型隐藏思考过程、凭证/密钥、Approval 内容、无界工具输出、与候选无关的完整会话、其他 owner 数据。写入前复用既有 `DeterministicPrivacyMasker`（mask 后不 restore），并叠加 AWS access key、JWT、带凭证连接串和自然语言 secret 的确定性遮盖；所有占位符统一替换为 `[REDACTED_CREDENTIAL]` 后才离开 Pegas。

### Bank、来源和幂等映射

- 每个 owner 使用独立 Hindsight bank：`pegas-owner-<opaque-owner-hmac>`。HMAC 使用独立服务端密钥派生，不把原始 owner ID 发送给 Provider。
- Run 派生记录带 `task_id`、`run_id`、`source_kind` 和 HMAC 后的 `context_key`；纠正记录带 `correction_of`。用户界面只展示必要来源，不暴露内部 bank ID。
- 全局经验标记 `scope:global`。局部经验使用服务端从 execution snapshot 得到的规范化、HMAC 后 `execution-context` key。第一版明确以规范化 workspace 根路径作为输入，不发送原始路径。不同 worktree 保持不同 context，跨 worktree 聚合押后到稳定 Project/Repository 领域对象建立以后。context key 缺失时不能把局部经验降级为全局。
- `document_id` 使用稳定的 `pegas:run:<runId>` 或 `pegas:correction:<jobId>`。Run/kind 唯一约束和 correction command fingerprint 在首次事务后固定 job/operation ID；相同事件或命令重放不能生成重复记录。

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
- 派生记录展示有界摘要、来源 Task/Run、scope、生成时间和最近注入时间；支持查看、删除和 dedicated correction。纠正和删除都在后台执行，不创建 Approval 或用户待办。
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
- job 使用 lease、稳定 operation ID、指数退避和有界重试，记录最后错误。operation 轮询与错误重试使用独立预算（schema v51 `poll_count`/`error_attempts`）：慢抽取的 pending/processing 轮询不消耗错误重试额度，轮询超过 600 次仍未终态则进入可观察停放状态；瞬时网络错误仍按指数退避最多重试 8 次。超出预算后不静默丢失，也不循环打扰用户。
- recall 设置短超时并 fail-open。失败只记录结构化日志和指标，不创建用户待办，除非持续故障导致产品明确无法提供已承诺的 Memory 能力。
- 删除采用本地 tombstone 先行。远端删除失败时后台重试，本地列表和 prompt 继续保持删除状态。每分钟完整 bank 同步同时是对账点：Provider 备份恢复或索引重建让已压制记忆重新 valid 时，同步会重新入队 curation invalidate，远端收敛不依赖一次性 job。
- Hindsight 关闭或不可用时，当前 schema v21 显式 Memory 的 CRUD、分层装载和 prompt 形状保持兼容。Provider 开关是回滚入口。
- 新增数据库对象必须是纯增量。旧版本可以忽略 memory job、派生投影和 tombstone 表，不得覆盖或格式化现有显式 Memory。
- `pnpm memory:up` 以 Docker `unless-stopped` 独立监督 Hindsight 和外部 pgvector/PostgreSQL，只绑定 loopback API；数据库使用命名 volume。`pnpm memory:backup` 生成一致性 zip，`pnpm memory:restore <archive> --confirm-restore` 先停 API、用一次性 admin 容器恢复，再重建服务。Provider 故障不会把 Pegas Worker 一起拉倒。
- `pnpm smoke:memory` 使用唯一临时容器/网络/volume，验证 v1.2.2 → v1.2.3 同库升级、owner 隔离、retain/recall/invalidate、纠正和 backup→mutation→restore。脚本只清理自己创建的资源。

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

- `src/memory/derived-memory.ts` 定义可替换 Provider、owner bank/workspace context 的 HMAC 映射、召回二次过滤和 dedicated correction；`src/memory/hindsight-provider.ts` 以直接 HTTP 接入 retain、operation status、recall、完整分页 list/get 和 invalidate，不把 SDK/MCP 或 Provider 凭证交给 Executor。
- schema v49 新增 durable retain/curation job、本地召回投影、Run 注入证据和 tombstone；schema v50 增加内容哈希 tombstone、durable correction、完整 bank 同步健康状态与 `retrieved/filtered/injected` recall audit；schema v51 为 retain/correction job 增加独立轮询与错误预算列。Run 成功/失败只写有界 input/outcome evidence，出网前复用既有隐私 masker 并叠加常见凭证格式遮盖，不写思考过程与无界工具日志。
- 每个 work Run 在 Executor 前最多召回一次；显式 Memory 排在派生 Memory 前。Hindsight 超时、畸形响应或不可用时 fail-open，不阻断 Run；Router 和 conversation lane 均不读取 Hindsight。同步失败保留最后成功投影并暴露健康状态。
- `GET /v1/derived-memories` 和记忆页展示定期同步的完整有效 bank。`POST /v1/derived-memories/:id/correct` 以 command ID 幂等 supersede；删除/纠正先落 ID + 内容哈希 tombstone、清正文并立即停止注入，再由后台作业收敛 Provider，不产生 Approval 或待办。
- `scripts/hindsight-ops.mjs` 提供 loopback、`unless-stopped`、外部持久 PostgreSQL、备份和显式确认恢复；`scripts/smoke-memory.mjs` 是可重复的真实 Provider canary。默认 linux/arm64 基线固定到 Hindsight v1.2.3 manifest `sha256:4b903ed2cbf029d6d305030b0005002d61d6a3b1d9b85867fb459351dcaa671c`（multi-arch index `sha256:601cfdd1bd3f6053864c6458ee15259f065a01a3f83090b56a8ae57db67f8f38`，MIT）与 pgvector/pg18 manifest `sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782`；其他架构必须显式固定并重新跑 canary。

自动化证据位于 `test/derived-memory.test.ts`、`test/derived-memory-store.test.ts`、`test/derived-memory-processor.test.ts`、`test/hindsight-runtime.test.ts` 与 `web/src/App.test.tsx`，覆盖 wire contract、完整分页、owner/context 隔离、预算与全阶段审计、原子入队、submit→poll 不重投、fail-open、ID 重建防复活、异步 curation、dedicated correction、完整同步与无需审批 UI。评审修复回归另覆盖：常见凭证格式（ghp_/github_pat_/AKIA/xoxb/JWT/连接串/自然语言 secret/私钥块）出网前遮盖、waiting goal Run 不产生成功经验且审查 failed 入队 failure、审查通过后才入队 verified success、Provider 恢复复活已删记忆时同步重新入队 curation、慢抽取轮询不消耗错误预算、永不终态的 operation 在 600 次轮询后停放。

最终门禁和真实 canary 的精确测试数量、覆盖率及输出记录在 `docs/feature-map.md` 的 MEMORY-001 M1 小节。

`MEMORY-001` 当前为 `Partial`。恢复 `Usable` 前必须关闭的评审缺口：内容哈希 tombstone 对 Provider 归并/改写重建的防复活承诺需要来源级压制或如实收窄文档；崩溃窗口重复 retain 的幂等需要真实 Provider 证据；Provider 超时/畸形响应合同测试尚未落地；mask 隐私模式下 memories 注入绕过 masking（M0 既有边界，需单独 Intake）；并发同 commandId 纠正的 replay 检查需移入事务；自托管 Hindsight HTTP 面无鉴权，本机 Executor shell 可绕过 Pegas 权威边界，需鉴权方案或明确登记边界缺口。其余 P3（CJK token 预算、recall query 组成与文档一致性、global 经验产生路径、Web sync 健康展示、404/409 契约、瞬时失败入队策略、HMAC key 长度校验、shutdown AbortSignal）逐项关闭。Hardening（非 arm64 镜像、加密 off-site backup、长期效果评测、>10k 游标）保持押后。
