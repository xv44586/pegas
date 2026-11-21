# Goal Contract 与证据化交付

> Feature：`GOAL-001`
>
> 状态：Partial
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

### 进程内可信验证器（2026-11-21 实现）

- `passed` 结果只能由进程内可信验证器签发：`createEvidenceRef` 与 `recordEvidenceVerification` 拒绝任何非 `pegas-control-plane-verifier` 身份的 `passed` attestation；`failed`/`pending` 仍可由其他主体追加为审计事实。HTTP 用户主张始终只保存为 `pending`。
- 取证时可随 `createEvidenceRef(..., { artifactBytes })`（HTTP 为 `artifactBase64`）提交被证明的产物字节：服务端先校验字节 SHA-256 与 Artifact `contentHash` 一致，再以 `wx` 独占写入数据目录 `attachments/evidence-<id>-<hash>`（schema v27 `evidence_refs.artifact_storage_path`）。验证时服务端重读字节并重验 digest，篡改即拒绝。
- `POST /v1/evidence/:evidenceId/verify { userId, commandId }` 触发进程内验证：服务端以自身身份运行确定性验证器并追加 append-only verification event；命令幂等重放返回冻结结果，跨 owner 拒绝。客户端不能提交 verification 对象。
- 第一个确定性验证器 `verifyVisualEvidence`（`src/goal/trusted-verifier.ts`）：要求 `screenshot/render/keyframe` + `control-plane` trust class + 已存证字节；校验 PNG/GIF/JPEG/WebP 容器签名与声明 MIME 一致，并从容器读取固有像素尺寸，必须与取证照明的 capture viewport 完全一致；任何不满足即 `failed`。语义级“截图内容正确”仍需后续独立验证器或用户明确接受。
- 自动化证据：`test/trusted-verifier.test.ts`（身份门禁、字节存证/篡改、视口/容器不匹配、四种图片格式解析、命令重放、HTTP 取证→验证→完成→delivery 闭环）。

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

截图、关键帧和页面渲染必须绑定准确 Artifact revision 或内容哈希，并记录环境、视口/分辨率、捕获时间或视频时间码。旧构建截图、错误 viewport 和修改前 Artifact 不能证明最终交付。服务端在取证时强制最终修订守卫：`screenshot/render/keyframe` 必须绑定该 Task 内同名 Artifact 的最新 revision 与内容哈希，否则拒绝（`Visual evidence must bind the final Artifact revision`）。

已存证字节的 evidence 支持所有者内容预览：`GET /v1/evidence/:id/content?userId=` 返回原始字节，附 `content-type`、`content-length`、`x-pegas-content-sha256` 与 `cache-control: private, no-store`；每次读取都重新校验 SHA-256，被篡改的存证拒绝服务。跨 owner 与不存在统一 404 `not_found`，无存证字节返回 404 `content_unavailable`。`review.ready` 预览投影为每条 evidence 附带 `sensitivity/capturedAt/contentHash/artifactRevision/viewport/timecode/hasContent`，用户不需要进入执行日志即可检查视口、时间码与最终修订；原始 capture environment（工具、路径等）仍不进入投影。

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

已实现（`src/notification/delivery-projection.ts`）：`NotificationChannel.external=true` 的渠道（Webhook 默认外部）在 dispatch 时收到 `review.ready` 的脱敏投影，持久 Outbox 行保留完整站内预览。sensitivity 为 `public/private` 的 evidence 保留可检查元数据（kind/verification/contentHash/artifactRevision/viewport/timecode/artifactName/limitations）；其余标签（含未知标签，fail closed）整条脱敏为 `{evidenceId, kind, verification, sensitivity, redacted: true, previewRef}`，且存在脱敏项时 criterion 的 explanation/limitations 一并隐藏并给出 `redactedEvidenceCount`。所有 evidence 均附认证站内引用 `previewRef=/v1/evidence/:id/content`；本地 Artifact uri、hasContent、presentation 与 rollback 细节不进入外部投影。非 `review.ready` payload 按生产合同本就是摘要，原样传递；投影不改变重试/unknown 停车语义。

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

1. [x] 定义 Goal Contract revision、EvidenceRef、Review Pack 和 criterion 状态合同；
2. [x] 让 Executor 生成最小目标简报，并保存用户确认与修订；提案 API、blocking 澄清停放与用户回答后恢复已实现，Web 澄清卡片待接入；
3. [x] 为结构化 Report 增加 evidence references，由 Control Plane 实施完成门禁；
4. [x] 扩展 Artifact 与 Outbox API，支持 evidence 聚合、权限和预览；服务端元数据、聚合、所有者权限、最终修订守卫、所有者内容预览 API 与外部渠道脱敏投影已完成；
5. 实现 Web Review Pack、视觉 evidence 画廊和 Channel 审计下钻；
6. 用真实任务样本验证哪些字段和提问有价值，再决定 Memory、Scheduler 与反馈闭环的后续范围。

## 当前服务端 API（Partial）

- `GET/POST /v1/tasks/:taskId/goals`：读取 revision 历史或以稳定 `commandId` 创建新 revision；来源事件必须属于当前用户和 Task。新 revision 会重绑定尚未开始的 Run，或原子终止旧 revision 的活动 Run 并创建绑定新 revision 的后继 Run。
- `POST /v1/runs/:runId/goal-proposals`：实际 Executor 在检查真实工具与权限后提交 Goal Contract 草案。鉴权与协作 API 相同：先验证当前 Run 短期 claim（`x-pegas-run-claim-token`），再解析 body；请求体为 `{commandId, goal}`。命令在来源 Run 内以 `(runId, commandId)` 唯一，同一 payload 重放返回创建时冻结的 `{contract, waitingOnClarification}`，重放只接受创建该命令的 claim hash（Run 取消或 claim 轮换后仍可重试），不同 payload 复用 command 返回 `409 goal_proposal_command_conflict`。只有 running Run 可以创建新提案；closed Task、未认证 claim 和外来来源事件被拒绝。尚无 Goal 快照的 executing Run 原地绑定首个 revision；已绑定 Goal 的活动 Run 走既有 supersede/后继 Run 路径。
- **blocking 澄清**：`goal.unknowns[].blocking=true` 时，服务端在同一事务内取消尚未开始的后继 queued Run（`last_error=awaiting_goal_clarification`）、把 Task 置为 `started/awaiting_goal_clarification`，并写入去重的 `goal.clarification_required` Outbox（含 questions 列表）。Executor 提交后结束 turn；`completeRun` 检测到该状态时把 Run 停放为 cancelled 而不是进入 evidence 报告阶段，不产生 `goal.report_required` 噪声。此时没有任何可领取 Run；用户经认证入口回答后，Router `continue_task` 创建绑定当前 revision 的新 Run 并清除等待原因。非 blocking 未知项只记录在合同中，不暂停执行。
- `GET/POST /v1/tasks/:taskId/artifacts`：登记不可变 Artifact revision、SHA-256、媒体类型、敏感级别和可选 Run 归属。
- `GET /v1/tasks/:taskId/evidence` 与 `POST /v1/runs/:runId/evidence`：按当前 Goal revision 和 Run 保存证据。HTTP 写入的 `confirmedForCapture: true` 只记录 `pending` 的用户主张，不能产生通过验证或完成 Task；自动验证只能由进程内可信验证器追加 verification event。语义重复 evidence 在同一 Run 内去重，重试 Run 可以对同一不可变来源重新取证；视觉 evidence 还必须绑定兼容的图片/渲染 Artifact、视口或时间码。
- `GET/POST /v1/runs/:runId/reports`：保存有递增序号的结构化 Worker Report；HTTP 写入要求该次 Run claim 独有且可轮换的 capability，服务端从 capability 推导 Reporter，不能由请求体冒充 Worker。`ready` 只表达完成主张，不绕过 evidence plan。
- `GET /v1/tasks/:taskId/review-packs` 与 `GET /v1/tasks/:taskId/delivery`：按 criterion 返回当前 Run 的 Review Pack、Artifact 和 evidence 聚合，并提供 Channel/Run 审计链接；历史列表使用 `limit`/opaque `cursor` 分页，默认 50、上限 200。

Task、Run、Review Pack 和 `review.ready` OutboxItem 在同一个 SQLite 提交边界内更新。`review.ready` OutboxItem 携带有界的 `review` 预览投影（NOTIFY-004）：`finalOutcome`、Goal revision、按 criterion 的 `completionStatus/explanation/limitations/evidenceCount`、最多 20 条 evidence 预览（kind、verification 结果、sensitivity/capturedAt/contentHash/artifactRevision、精选 viewport 与 keyframe timecode、hasContent、绑定 Artifact 的 id/name/kind/revision/MIME/uri、presentation 与 limitations）、`remainingRisks`、可选 `rollback` 与 `auditLink`。执行日志、原始 capture environment 与隐藏提示不进入该投影；用户从 Outbox 即可判断目标是否达成，并按 auditLink 进入 Channel 下钻。`ready` Report 在该事务内重新读取当前 Run 的全部 EvidenceRef，不能因 Worker 事务外快照与 Control Plane 并发写入而漏证或丢失唤醒。响应丢失后，重复 Report 使用持久化在原 Report 上的 capability hash 验证并返回同一完成链；过期 capability 不能创建新序号 Report。同一 Run 内，同一 Artifact revision 或 observation snapshot 换 command ID 重放时不会被重复计数。Evidence capture 不可变，`pending → passed/failed` 通过 append-only verification event 演进；缓存的当前 verification 只用于投影。Run 在领取时生成不可出现在普通 Run API 的 claim capability，所有权更换时轮换；DSH Executor 子进程不会继承 Pegas 控制面、恢复、通知、隐私或模型凭证。当前用户 API 仍沿用单用户实例 bearer token 加 `userId` 所有者校验，因此高风险用户接受必须等 `APPROVAL-001` 提供受认证 confirmation capability，不能由普通 evidence 请求字段获得产品级信任。

自动化至少覆盖：手段被误当目标、来源冲突、缺少权限、用户拒绝继续澄清、执行中目标变化、部分完成、证据缺失、Agent 自我声明被拒、旧 revision evidence、敏感 evidence 脱敏、视觉证据缺少目标视口、Outbox 聚合/去重、通知失败恢复和重复事件。

## 回滚

回滚服务端写路径时应停止创建新 Goal Contract/EvidenceRef/verification event/Review Pack，保留 schema v15 中已经持久化的历史记录为只读，并让尚未绑定 Goal 的旧 Task 继续使用兼容 Task/Run/Outbox 投影；不得删除用户输入、Artifact、审计记录或已产生的外部副作用。已绑定 Goal 的 Task 不得绕过 evidence 门禁直接改为 completed；应保持 `started/awaiting_evidence`，或在显式迁移审计后恢复执行。若回滚到不了解 claim capability 的版本，必须先停止 GOAL Report HTTP 写入，不能把 capability 降级为共享 Worker token。

schema v22 只新增 `goal_proposal_commands` 重放表，旧 Release 会忽略该表。但存在 `started/awaiting_goal_clarification` 的开放 Task 时，回滚到不支持 v22 的 Release 会被 Rollback Guard 以 `rollback_incompatible` 拒绝：旧版本不认识该等待原因，会把停放的 Task 误投影为可继续状态。用户回答澄清或显式停止 Task 后允许回滚；历史提案命令与 Goal revision 保持只读保留。
