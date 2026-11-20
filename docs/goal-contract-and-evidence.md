# Goal Contract 与证据化交付

> Feature：`GOAL-001`
>
> 状态：Planned
>
> 更新日期：2026-11-20

## 产品决策

Pegas 不把“用户先给出一个完整、正确、可执行的目标”当作使用前提。用户可以从愿望、问题、抱怨、例子或一段混乱叙述开始；实际 Executor Agent 在了解真实工具、权限和环境后，帮助用户澄清期望结果、补齐关键上下文与前置条件，并形成可执行、可验收的 Goal Contract。

Task 交付给用户审查的默认内容不是代码、工具调用或处理步骤，而是表征 Goal 是否完成的 evidence。执行过程保留在 WorkChannel、Run 和审计记录中，供恢复、追责和按需下钻；Outbox 默认交付按完成条件组织的 Review Pack。

## 用户结果

用户无需先学习项目管理、流程设计或验收方法，也能：

1. 用自然语言或语音表达不完整的意图；
2. 让 Pegas 帮助确认真正想得到的结果，而不是机械执行现有步骤；
3. 看见 Pegas 识别出的关键假设、来源、前置条件、权限边界和完成条件；
4. 只回答会实质改变结果、成本、权限或风险的问题；
5. 在交付时直接审查每项完成条件及对应证据；
6. 需要时再进入 Channel 查看代码、日志、工具调用和恢复历史。

## 产品边界

### Router 与 Executor

Router 继续只负责输入属于哪个 Task 或控制意图，不判断目标是否充分、Executor 有哪些工具，也不代替实际 Agent 进行业务澄清。

只有加载了 Task 上下文、真实工具、权限和工作环境的 Executor Agent 才能：

- 判断是否可以直接安全执行；
- 识别会改变方案或风险的关键未知项；
- 向用户提出必要问题；
- 生成用户可确认的目标简报；
- 提交带 evidence references 的结构化 Report。

### 简单任务与复杂任务

Goal Contract 是服务端权威的结构化合同，不意味着每个请求都要经过一张表或一轮访谈：

- 即时问答、只读查询和结果明确的低风险任务可以从输入推导最小合同并直接执行；
- 信息缺失会改变结果、成本、权限或不可逆副作用时，必须先澄清；
- 长任务、周期自动化、跨系统写入和高风险动作需要更完整的合同与显式确认；
- 用户拒绝继续澄清时，Pegas 可以保存草稿、缩小范围后执行，或明确说明无法安全推进，不能擅自扩大假设。

## Goal Contract

Goal Contract 描述 Task 要达成什么以及如何证明，而不固定具体模型、工具或每一步点击。概念字段如下：

```text
GoalContract
  id
  taskId
  revision
  basedOnEventIds[]
  desiredOutcome
  beneficiaries[]
  successCriteria[]
    criterionId
    observableStatement
    required
    evidencePlanRef
  nonGoals[]
  constraints[]
  contextSources[]
    sourceRef
    freshness
    authority
    conflictPriority
  assumptions[]
    statement
    status
    sourceEventId
  unknowns[]
    question
    blocking
  prerequisites[]
  permissionBoundary
  reviewCheckpoints[]
  evidencePlan[]
  failureAndRecovery
  feedbackSignals[]
  triggerPolicy
  createdAt
```

`successCriteria` 必须为每个条件提供 Goal 内稳定的 `criterionId`、可观察结果、`required` 策略和 `evidencePlanRef`，不能只写“完成实现”“处理成功”或“Agent 认为可以结束”。同一条件的文字澄清保留 ID；条件被拆分、合并或语义替换时使用新 ID，并在 revision 中记录旧 ID 的 superseded 关系。`evidencePlan` 为每个条件声明期望的证据类型、验证环境、最低覆盖、验证方式和用户呈现方式。

合同修订通过新 revision 和事件表达，不能覆盖用户原始输入。目标或权限范围扩大时，Control Plane 必须重新检查 Policy、成本、风险和既有 Mandate 是否仍足够。Mandate 仍是不可变的接单授权依据；Goal Contract 是可版本化的目标与验收理解，两者不能合并。

## Evidence 与 Review Pack

### 两种不同投影

| 投影              | 回答的问题                                       | 默认位置                   | 默认受众                   |
| ----------------- | ------------------------------------------------ | -------------------------- | -------------------------- |
| Execution Trace   | Agent 做了什么、何时做、调用什么、哪里失败和重试 | WorkChannel、Run、审计记录 | 恢复、调试、追责、专家下钻 |
| Delivery Evidence | Goal 是否达成、凭什么相信、还有什么未证明        | Review Pack、Outbox        | 用户验收与决策             |

代码 diff、命令输出、工具日志、内部计划和处理步骤可以作为审计线索或 evidence 的来源，但通常不是用户结果。即使 Task 是修改代码，默认交付仍应优先展示行为变化、自动化验证、真实运行状态、视觉结果、性能指标或部署健康。只有 Goal 本身是审查实现，或用户明确要求技术细节时，代码才作为一等交付内容。

### EvidenceRef

```text
EvidenceRef
  id
  taskId
  runId
  goalRevision
  criterionId
  kind
  artifactRef | observationRef
  externalRef                 # 仅用于导航，不作为事实快照
  producerIdentity
  captureMechanism
  trustClass
  artifactRevision | contentHash
  observationSnapshot
    observedValue
    sourceObjectId
    sourceVersion | etag
    issuerIdentity
    observedAt
    snapshotHash
  verification
    method
    verifierIdentity
    verifierVersion
    result
    verifiedAt
  capturedAt
  environment
  presentation
  sensitivity
  limitations[]
```

有效 evidence 需要满足：

- **相关**：直接对应某个 success criterion；
- **可归属**：绑定准确 Task、Run、Goal revision、Artifact revision 或外部对象；
- **新鲜**：来自最终结果，而不是中间版本、旧构建或执行前状态；
- **可检查**：用户能够预览、打开或复现，不依赖 Agent 自我声明；
- **充分但克制**：足够支持判断，不把日志洪流伪装成透明度；
- **安全**：遵守可见范围和脱敏策略，不为证明完成而扩大数据暴露。

Control Plane 对 EvidenceRef 的结构校验只证明引用完整，不能证明 criterion 已满足。每种 `kind` 必须在 evidence plan 中指定语义验证方法和允许的 trust class；高风险 criterion 使用确定性验证器、独立主体签名或用户明确接受，不能让执行该动作的 Worker 同时成为唯一验证者。验证器的身份、版本和结果随 evidence 持久化。

外部对象可能变化或消失，因此 `externalRef` 只作为导航。支持验收的事实必须保存不可变 `observationSnapshot`，包含观察值、外部对象 ID、可获得的版本/ETag、签发者、观察时间和内容哈希；无法形成可复核快照时明确标记 limitation。

Agent 总结、自由文本 `ready`、单独的退出码和“已执行”过程不能独立满足 success criterion。无法获得充分证据时，该条件必须是 `unverified`、`partial` 或 `failed`，不能由模型补写成成功。

### Review Pack

```text
ReviewPack
  id
  revision
  supersedesReviewPackId
  taskId
  goalRevision
  basisEventIds[]
  projectionAsOf
  finalOutcome
  criteria[]
    criterionId
    completionStatus   satisfied | partial | unverified | failed
    currentValidity    valid | warning | invalid | unknown
    evidenceRefs[]
    explanation
    limitations[]
  sideEffects[]
  remainingRisks[]
  rollback
  auditLink
  createdAt
```

Review Pack 以 success criteria 为顺序，不按执行时间罗列动作。它是由服务端事实生成的交付投影，不是新的完成事实来源。Control Plane 在允许 Task 完成前检查当前 Goal revision 所需的 evidence references；Review Pack 只呈现这一判断和证据。完成时的 `completionStatus` 是不可变快照；后续有效性变化通过 append-only validity event 产生新 Review Pack revision，并以 `currentValidity` 呈现，不能改写当时的完成判定。

## 常见 Goal 的证据

| Goal 类型          | 默认优先 evidence                                         |
| ------------------ | --------------------------------------------------------- |
| 修改 UI 或视觉产物 | 最终截图、关键状态、关键帧、可打开的成品 Artifact         |
| 修复 Bug           | 原问题的回归场景、修复后行为、相关边界回归                |
| 自动化业务流程     | 目标系统最终状态、外部确认、关联 ID、去重与恢复结果       |
| 数据整理或迁移     | 输入/输出数量、校验、抽样、差异、未处理项和回滚点         |
| 研究与决策         | 来源覆盖、关键证据、冲突、结论置信度和未回答问题          |
| 部署或运维         | 准确版本、健康检查、关键路径 canary、指标窗口和回滚可用性 |
| 文档或排版         | 最终渲染、目录与顺序、代表性页面、可打开的交付文件        |

## 视觉证据合同

图片、视频、产品 UI、响应式布局、交互状态、文档排版、幻灯片顺序或其他视觉呈现发生变化时，最终渲染是必需 evidence，而不是可选附件：

- 图片、海报和图表提供最终完整预览；必要时补充关键细节、尺寸与色彩信息；
- 视频和动画提供可播放 Artifact，以及覆盖开头、核心变化和结尾的关键帧或 contact sheet；涉及节奏时记录时间码；
- 产品 UI 在真实目标环境或可信 Candidate 中截图，覆盖被修改的关键状态和约定视口；响应式改动至少覆盖约定的桌面与窄屏；
- 文档、网页和幻灯片提供最终页面渲染；顺序变化必须能从预览中直接检查；
- 视觉回归修复优先提供可信的 before/after；全新产物通常只要求最终态。

截图、关键帧和页面渲染必须绑定准确 Artifact revision 或内容哈希，并记录环境、视口/分辨率、捕获时间或视频时间码。旧构建截图、错误 viewport 和修改前 Artifact 不能证明最终交付。

截图只能证明视觉状态，不能替代功能、无障碍、性能、安全或后端正确性的证据。

## Outbox 交付

GOAL-001 扩展后的 Outbox 默认呈现：

- Task 与 Goal 的简短结果；
- success criteria 的逐项状态；
- 可直接预览的 evidence，如缩略图、画廊、关键帧、指标摘要或外部确认；
- 证据限制、剩余风险和回滚入口；
- 完整 Artifact 和来源 Channel 的链接；
- 按需查看 Execution Trace 的审计入口。

多份 evidence 应按 criterion 聚合为一份 Review Pack 并去重，不为每张截图或每个测试产生一条通知。只有需要用户在执行中选择方向的中间 evidence 才主动进入 Outbox；普通过程截图和 progress 留在 Channel。

Outbox 的产品已读、外部投递状态、用户是否接受结果、evidence 是否有效是四个不同事实，不能相互推断。Review Pack 持久化成功后，即使通知暂时投递失败，完成事实和证据也不会丢失；Dispatcher 可以继续重试。

服务端为每种投递渠道生成独立 delivery projection，并在 dispatch 时再次校验接收者、渠道可信度、sensitivity 和当前授权。站内可信界面可以按权限预览；Webhook、推送和消息平台默认只发送脱敏摘要或需要认证且短期有效的引用，不嵌入 canonical evidence bytes。外部投递内容一旦离开 Pegas 不能依赖后续撤权回收，因此高敏 evidence 不得进入不可控渠道。

## 数据、权限与隐私边界

- Goal Contract、EvidenceRef、Review Pack 与完成判断以服务端为权威；客户端只做呈现和交互适配。
- EvidenceRef 优先引用现有 Artifact 或外部事实，不无边界复制大文件和敏感数据。
- evidence 沿用来源 Artifact 的所有者、Task、可见范围和保留策略；跨用户、跨 Task 或撤销授权后不得继续预览。
- 截图和日志在进入 Review Pack 前必须检查凭证、个人信息、内部提示词、生产数据和受限内容；无法安全预览时提供脱敏摘要与权限受控引用。
- `auditLink` 只提供用户已有权限范围内的 Channel/Run，不因为 Review Pack 扩大执行日志可见性。
- Goal Contract 的目标修订不能静默扩大外部写入、费用、数据收集或触发频率；这些变化按风险进入 Approval。

## 失败与恢复

- 目标整理失败时保留原始 Conversation Event，Task 可以保持 backlog/unstarted 或等待 Executor 重试，不能丢失用户意图。
- 缺少关键上下文、权限或前置条件时保存结构化 unknown/waiting reason，释放当前 Run；用户补充后从持久状态恢复。
- evidence 捕获失败或与最终 revision 不匹配时，相应 criterion 保持 `unverified`；不得只凭 Worker 的 `ready` 结束 Task。
- Review Pack 必须在 Task 完成和 OutboxItem 创建的同一权威提交边界内引用已持久化 evidence；响应丢失后用稳定 ID 去重。
- Outbox 投递失败不删除 Review Pack，也不把 Task 改回运行中；用户可从 Channel 访问同一结果，Dispatcher 继续按既有策略重试。
- 外部副作用无法确认时明确显示 `unknown` 和恢复建议，不能用截图、日志或模型推断伪造成功。
- Evidence Artifact 损坏、撤权或过期时追加 validity event，不改写历史 EvidenceRef 和完成时的 Review Pack 快照。Control Plane 生成新的 Review Pack revision，为受影响 criterion 更新 `currentValidity`，并按 Policy 决定重开 Task、请求重新验证或仅发出 attention；重新捕获产生新 EvidenceRef，不原地替换历史。
- 完成流水线使用语义幂等键和唯一约束：Report 以 `(taskId, runId, reportSequence)`，evidence capture 以 `(taskId, goalRevision, criterionId, sourceArtifactRevisionOrSnapshotHash, captureKind)`，Review Pack 以 `(taskId, goalRevision, basisEventSetHash)`，OutboxItem 以 `(reviewPackId, channel, recipientProjection)` 去重。调用方丢失响应后必须查询或返回同一记录，不能生成新的完成链。

## 验收条件

1. 用户可以从自由文本或语音开始，不需要先填表、选择工具或创建 Bot。
2. Executor 而非 Router 判断是否需要目标澄清，并只询问会改变结果、成本、权限或风险的问题。
3. Goal Contract 保存 desired outcome、success criteria、non-goals、关键来源、假设、未知项、前置条件、权限、evidence plan 和恢复边界，并记录来源事件与 revision。
4. 用户事实、Executor 推断和未验证假设可区分；用户纠正产生新 revision，不覆盖原始表达。
5. 低风险明确任务可直接执行；高风险、长期或范围扩大的任务按 Policy 要求显式确认。
6. Worker 的结构化 Report 引用 EvidenceRef；自由文本、进程退出和 Agent 自我声明不能完成 Task。
7. Control Plane 逐项判断当前 Goal revision 的 success criteria，并拒绝缺少必需 evidence 的完成请求。
8. Review Pack 以 criteria 而非执行步骤组织，显示 `satisfied/partial/unverified/failed`、证据、限制、风险和回滚。
9. 视觉变化包含与最终 Artifact revision 绑定的截图、关键帧或页面渲染；缺少视觉证据时相关 criterion 不得满足。
10. Outbox 直接预览 evidence，聚合去重并提供 Artifact、Channel 和按需审计入口；默认不展示代码和过程日志。
11. evidence 遵守用户、Task、Artifact 和敏感信息边界；无权或无法安全预览时不泄露内容。
12. 等待后恢复、重复 Report、重复通知和响应丢失不会产生重复完成、重复 evidence 或重复外部副作用。

## 非目标

- 不要求所有简单任务进入长访谈或显式规划流程；
- 不新增用户必须理解的 Bot、Worker、Run 或 Goal Contract 配置界面；
- 不让 Router 判断 Executor 工具能力、业务完成条件或 evidence 是否充分；
- 不把模型推理过程、完整工具参数或日志洪流作为“透明度”默认交付；
- 不在 GOAL-001 首版实现跨 Task 的自主长期流程优化；
- 不把用户查看 Outbox、通知投递成功或 Agent 发出 `ready` 等同于用户接受结果；
- 不以本设计文档把现有 `TASK-002`、`NOTIFY-003` 或 `QUALITY-001` 状态提升为已实现。

## 计划中的实现顺序

1. 定义 Goal Contract revision、EvidenceRef、Review Pack 和 criterion 状态合同；
2. 让 Executor 生成最小目标简报，并保存用户确认与修订；
3. 为结构化 Report 增加 evidence references，由 Control Plane 实施完成门禁；
4. 扩展 Artifact 与 Outbox API，支持 evidence 聚合、权限和预览；
5. 实现 Web Review Pack、视觉 evidence 画廊和 Channel 审计下钻；
6. 用真实任务样本验证哪些字段和提问有价值，再决定 Memory、Scheduler 与反馈闭环的后续范围。

自动化至少覆盖：手段被误当目标、来源冲突、缺少权限、用户拒绝继续澄清、执行中目标变化、部分完成、证据缺失、Agent 自我声明被拒、旧 revision evidence、敏感 evidence 脱敏、视觉证据缺少目标视口、Outbox 聚合/去重、通知失败恢复和重复事件。

## 回滚

在 GOAL-001 尚未实现前，本文件只定义产品与架构方向。后续代码回滚时应停止创建新 Goal Contract/EvidenceRef/Review Pack，保留已经持久化的历史记录为只读，并回退到现有 Task/Report/Outbox 投影；不得删除用户输入、Artifact、审计记录或已产生的外部副作用。
