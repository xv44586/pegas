# 归类规则、不确定时策略与测试归类（ROUTE-005 Intake）

> Feature：`ROUTE-005`
>
> 状态：Usable（R1–R4 全部落地；尚未合并 main 与 Candidate 上线）
>
> 登记日期：2026-11-23

## 背景与现状

封板 Web「设置 → 事情归类」页已有能力与锁定占位并存（`web/src/sealed/SettingsPage.tsx`）：

- **已实现**：「归类方式」切换写入 `routerMode`（`model`/`rules`），Worker 据此选 `ModelTaskRouter` 或 `RuleBasedTaskRouter`（`src/worker/main.ts` `createRouter`）；归类模型选择（SETTINGS-001）；「即时应答」开关（ROUTE-004，`chatLaneEnabled`）。
- **锁定占位（本 Feature 范围）**：
  1. **归类规则**：示例规则列表全部禁用，「添加规则」禁用；
  2. **不确定时**：三个 radio（开始新事情 / 先问我 / 优先继续最近的事情）全部禁用，实际行为硬编码等效于「开始新事情」（模型判据「不确定时 create_task」+ `RuleBasedTaskRouter` 无显式引用即新建）；
  3. **测试归类**：输入框与「测试」按钮禁用，页面如实提示「归类测试 API 尚未提供」。

`docs/work-rules.md` 已明确：工作规则（RULES-001）注入 Executor 执行 prompt，影响「事情怎么做」；归类规则决定「输入进哪个 Task」，属 Router Intake 决策链路，二者分离。`docs/router-worker-design.md` 决策 4（保守规则先行、不确定 100% 进模型、不引入 embedding/小模型强依赖）是本 Feature 的既定方向。

## 用户结果

用户可以在「事情归类」页：

1. 维护自己的**归类偏好规则**（添加、编辑、启停、删除），让可预期的归属行为（如「提到 X 项目的消息优先进 X 事情」）不依赖归类模型的临场判断；
2. 显式选择**拿不准时的兜底策略**：开始新事情（默认，保持现状）/ 先问我 / 优先继续最近的事情；
3. 用**测试归类**输入一句话，看到「会归到哪个事情、命中了什么规则/判据、为什么」，且测试不产生真实 Task、Run、通知或任何副作用。

系统硬边界不变且不可编辑：已停止（cancelled）的事情不自动恢复；控制意图（steer/cancel/approval）永远走确定性链路与人类认证；显式 taskId 引用永远确定性优先。

## 关键领域词与既有能力检索结论

- 检索词：归类、归类规则、测试归类、不确定时、routerMode、RoutingDecision、routerSystemPrompt。
- `ROUTE-001/002/003/004`：归属决策合同、fencing、开放候选与权威摘要、reply 车道均已 Usable，本 Feature 复用不重造。
- `RULES-001`（Partial）：工作规则的存储/命令幂等/revision/owner 隔离/`<` 转义模式可复用；其「下一缺口」中的「归类规则与测试归类」由本 Feature 承接，RULES-001 本体不扩权。
- `PLAN-001` P2（`src/router/prefilter.ts`）：确定性前置分流已存在（控制命令唯一匹配、问候白名单），用户归类规则应挂接在同一前置层语义下，不另起分流体系。
- 结论：无同 ID 既有实现，登记新 Feature `ROUTE-005`。

## 方案选型（Intake 建议，实现前经 Eng review 定稿）

候选方案：

- **A. 纯确定性规则层**：用户规则编译为确定性匹配（关键词/事情引用等），唯一命中才生效，否则进模型。可解释、可测试，但自然语言规则表达力有限。
- **B. 规则注入归类 prompt**：把用户规则作为偏好块拼进 `routerSystemPrompt`。表达力强、实现薄，但遵守度不可保证，须配合命中证据与测试归类闭环（与 RULES-001「遵守度缺乏可观察证据」同类缺口）。
- **C. 混合分层（推荐）**：硬约束留在规则/事务层（cancelled 不复活、控制意图确定性、显式 taskId 优先）；用户软偏好经 `<pegas_routing_rules>` 数据块注入归类 prompt（复用 RULES-001 的转义与「偏好不是授权」声明）；每条 RoutingDecision 记录命中的规则 ID/判据来源，进事情时间线可审查；规则不确定 100% 进模型（决策 4 验收不变）。

推荐 C：与现有三层路由分离（渠道/归属/模型难度）和决策 4 一致，不引入 embedding/小模型强依赖；A 作为 C 中确定性部分的实现细节保留。

「不确定时」策略约束：

- `new_task`（默认）：与现状完全一致，作为缺省与回滚值。
- `ask_first`：需要新增 Router 产出（澄清型待办），必须走既有 Inbox/Outbox 与待处理链路，携带原输入并可一键回答后续接；不得由 Router 直接向用户发正文答复（长期边界 1）。
- `continue_recent`：只影响模型 prompt 判据与候选排序权重（ROUTE-003 waiting-on-user 优先排序不变），不得绕过 store 的 Mandate 复核与状态机约束。

「测试归类」约束：只读 API（建议 `POST /v1/routing/preview`，语义为 dry-run），复用 `listRoutingCandidates` 投影 + 当前生效 Router/规则/策略，返回决策、理由与命中规则；**不落库、不创建 Task/Run、不发 Outbox、不写决策合同**；计量按 USAGE-001 `component=router` 如实入账（预览也消耗模型调用）。

## 验收条件（实现完成的判据）

1. 归类规则 CRUD 沿用 RULES-001 模式：增量表 + commandId 幂等冻结响应 + expectedRevision 乐观并发 + owner 隔离 + 每用户条数/长度上限；停用/删除的规则不出现在后续路由中；正文 `<` 转义防注入；规则声明为归属偏好，不能授予权限、不能指向 cancelled 任务、不能表达控制意图或执行指令。
2. 命中证据：每条受用户规则影响的路由决策记录规则 ID 与来源（deterministic/prompt），可在事情时间线审查；无规则命中时行为与现状逐字节一致（回归断言）。
3. 「不确定时」三值持久化于 RuntimeSettings（省略保留语义不变），默认 `new_task`；`ask_first` 产出结构化澄清待办并可回答续接，回答走既有 continuation 链路；`continue_recent` 不改变授权边界。
4. 测试归类 API 为纯 dry-run：同输入重复调用零持久化副作用（Task/Run/Outbox/决策表均无新行，回归断言）；Web 解锁测试输入并展示决策/理由/命中规则，失败就地报错。
5. 系统规则不可编辑不可停用；控制意图与显式 taskId 的确定性链路不被任何用户规则/策略旁路（回归断言）。
6. Web 锁定占位如实解锁：归类规则列表/添加、不确定时 radio、测试归类；三主题与 390px 通过既有 ui-review/a11y 门禁。
7. `pnpm check` + `pnpm smoke` 在 Feature worktree 合并最新 main 后全绿；真实归类模型上至少实测「规则命中 / 规则未命中进模型 / ask_first 澄清」三场景。

## 非目标

- 不做语义检索/embedding 候选（属 CHANNEL-003 后续）；不引入小模型分流强依赖（决策 4）。
- 不做按事情/Worker 作用域的归类规则覆盖（首版全局，与 RULES-001 MVP 对齐）。
- 不改模型/难度路由（WorkerProfile 地盘）、不改控制意图合同与 fencing、不让 Router 代答。
- 不做规则命中率的长期评测体系（先埋点，评测属后续）。
- 不启用「行为与规则」页的语言/回复长度/自主程度占位（仍属 RULES-001 缺口）。

## 数据与权限边界

- 新表为增量迁移（沿用 v31 三表模式），旧版本代码忽略新表可回滚；self-change 兼容区间同步扩展。
- 全部端点走实例 bearer + owner 隔离；不存在与跨 owner 统一 404。
- 规则正文进入归类 prompt 前经 `<` 转义与预算截断（对齐 RULES-001 的 24000 字符总预算模式，具体预算实现时定）；PRIVACY-001 掩码链路不变。
- 测试归类只读投影，遵守与真实路由相同的候选可见性（owner 自己的开放任务），不泄漏跨 owner 数据。

## 失败与恢复

- 规则写命令 `BEGIN IMMEDIATE` 事务 + 冻结响应，重放幂等；409 冲突 Web 自动重读不静默覆盖。
- 归类模型不可用/畸形输出：沿用 `ModelTaskRouter` 规则兜底，用户规则不改变该兜底；`ask_first` 澄清投递失败走既有 Outbox 重试/核对链路。
- 回滚：策略与规则表为增量，回滚代码即恢复锁定占位 UI 与「不确定时=新建」现状；`routerMode` 语义不变。

## 关联更新

- `docs/feature-map.md`：登记 ROUTE-005（Planned）；RULES-001 下一缺口中的归类部分指向 ROUTE-005。
- `docs/work-rules.md`：非目标中的归类条目指向本文档。
- 实现落地时同步更新 `docs/router-worker-design.md`（决策 4 的用户规则扩展）与 `docs/sealed-ui-rebuild.md`（占位解锁）。

## 实现拆分计划（2026-11-24 登记，Eng review 后按此执行）

全部阶段共用 Feature ID `ROUTE-005`，按依赖顺序各自一个隔离 worktree 与可独立审查的 commit 系列（对齐 PLAN-001 P0–P5 模式）；每阶段合入前在合并态复跑完整门禁。基线：main `99c2b4c`（schema v39）。

### R1 归类规则存储与 CRUD（服务端闭环）

- 分支建议 `feat/ROUTE-005-routing-rules-store`。
- 新模块 `src/rules/routing-rules.ts`：契约照抄 `src/rules/rules.ts` 模式（exactKeys 严格解析、draft/record/command/fingerprint），字段建议 `title ≤120`、`content ≤2000`、`enabled`、每用户 ≤50 条（比工作规则更紧，规则要进归类 prompt）。
- SQLite 增量迁移 v40：`routing_rules`、`routing_rule_commands` 两表，`BEGIN IMMEDIATE` + 冻结响应；`src/worker/main.ts` self-change `maximumSchema` 39→40；`test/sqlite-store.test.ts` 迁移列表 +40；`test/rollback-compatibility.test.ts` 增补 v40 增量回滚用例。
- HTTP：`GET/POST/PUT /v1/routing-rules`、`POST /v1/routing-rules/:id/delete`，bearer + owner 隔离 + commandId 幂等 + expectedRevision，404/409 语义与 `/v1/rules` 一致。
- 测试先行：`test/routing-rules.test.ts`（契约/幂等/revision/owner 隔离/上限/HTTP/bearer）。
- 完成判据：纯服务端闭环，Router 尚未消费规则；回滚 = revert，v40 增量表旧代码忽略。
- **落地证据（2026-11-24）**：分支 `feat/ROUTE-005-routing-rules-store`（基线 `1cf8766`）。`src/rules/routing-rules.ts` 契约（title ≤120 / content ≤2000 / enabled，exactKeys 严格解析）；schema v40 增量两表 + `BEGIN IMMEDIATE` 冻结响应（create/update/delete 幂等重放、payload 变更 409、revision 乐观并发、owner 隔离 404、每用户 50 条上限删除释放、rowid DESC 游标分页）；HTTP `/v1/routing-rules` GET/POST/PUT + `/:id/delete`，错误码 `routing_rule_conflict`/`routing_rule_command_conflict`/`routing_rule_limit`/`not_found`，bearer 401；self-change `maximumSchema` 39→40。测试先行：`test/routing-rules.test.ts` 6 测试先红（5 失败）后绿；`test/rollback-compatibility.test.ts` +1（存在归类规则时允许回滚至 39，v40 纯增量）；`test/sqlite-store.test.ts` 迁移列表 +40。门禁：`pnpm check` 113 文件/1197 测试全绿（statement 85.7% / line 88.9%）、`pnpm smoke`、`pnpm smoke:crash` 通过。回滚：revert 即回到 v39 行为，旧代码忽略新表，无数据破坏。

### R2 规则消费与命中证据（Router 纵向闭环）

- 分支建议 `feat/ROUTE-005-router-consumption`，依赖 R1。
- `ModelTaskRouter` 增加可选 `routingRules` 输入：启用规则经 `<` 转义后以 `<pegas_routing_rules>` 数据块拼入 system prompt（声明为归属偏好、非授权、不得表达控制意图/执行指令），总预算建议 8000 字符截断；`routerDecisionSchema` 增加可选 `matchedRuleId`，服务端校验必须属于本次注入的规则集合，非法即丢弃该字段（不整条兜底）。
- 命中证据：`routing_decisions` 增量列（随 R2 迁移 v41）记录 `matchedRuleId` 与来源（prompt/deterministic），投影进事情时间线路由决策展示；无规则时 prompt 与决策行为逐字节不变（回归断言）。
- `RuleBasedTaskRouter`（rules 模式）不消费用户规则（保持确定性语义），UI 在 rules 模式下如实说明规则仅作用于智能判断。
- 硬边界回归：用户规则指向 cancelled/不存在任务、含控制意图措辞时不得改变确定性链路；模型畸形输出仍走既有规则兜底。
- 测试：`test/router.test.ts` 扩展 + 新命中证据用例；真实归类模型实测「命中/未命中」两场景。
- **落地证据（2026-11-24）**：分支 `feat/ROUTE-005-router-consumption`（基线 `bf72382`）。`RoutingDecision` 各 kind 增加可选 `matchedRuleId`；`routerDecisionSchema` 增加 `matchedRuleId` 字段，`modelDecision` 校验其必须属于本次注入的规则集合，非法只丢弃该字段不整条兜底；启用规则经 `<` 转义以 `<pegas_routing_rules>` 偏好块拼入 system prompt（声明非授权、不得选未列出任务/恢复已停止任务/表达控制意图），`routingRuleContextForUser` 按创建顺序装载、8000 字符预算（每条 +200 元数据开销）；无规则时 prompt 逐字节不变（回归断言）。schema v41 为 `routing_decisions` 增量两列 `matched_rule_id`/`decision_source`，三处决策落库点写入证据，`listChannelRoutingDecisions` 与 HTTP 时间线 routing 投影携带命中证据；`RuleBasedTaskRouter` 不消费用户规则，显式 taskId 确定性链路不受影响（回归断言）；self-change `maximumSchema` 40→41。测试：`test/routing-rule-consumption.test.ts` 6 测试；`test/routing-rules-live-integration.test.ts` 1 真实 magpie/qwen4-max 条件集成（规则命中 create_task 带 matchedRuleId、无关消息保守 create_task 无命中，6.1s 实测通过）；回滚兼容用例扩展 v41。门禁：`pnpm check` 115 文件/1204 测试全绿（statement 85.72% / line 88.92%）、`pnpm smoke`、`pnpm smoke:crash` 通过。剩余风险：真实模型遵守度仅两场景实测；Web 时间线尚未渲染命中证据（R4 一并解锁）。回滚：revert 即回 v40 行为，增量列旧代码忽略。

### R3 「不确定时」策略（含 ask_first 澄清待办）

- 分支建议 `feat/ROUTE-005-uncertainty-policy`，依赖 R2（prompt 注入位）。
- RuntimeSettings 增加 `routingUncertainty: 'new_task' | 'ask_first' | 'continue_recent'`（默认 `new_task`，省略保留 COALESCE 语义与 `chatLaneEnabled` 同款）。
- `new_task`/`continue_recent` 只改 prompt 判据与措辞，不改候选授权边界；`ask_first` 新增 `RoutingDecision` kind `clarify`（携带问题与原输入），由 Control Plane 落为既有澄清/待处理链路（对齐 `goal.clarification_required` 的 Outbox/待处理投影，不新造通知体系），回答走既有 continuation 重新路由；Router 不发正文。
- `RoutingDecision` 合同扩展需同步 `routerDecisionSchema`、store `#applyTaskRoutingDecision`、畸形兜底与 fencing 回归；控制意图优先级不变。
- 测试：三值策略持久化/省略保留、clarify 决策→待办→回答续接闭环、崩溃 resume、真实模型 ask_first 场景。
- **落地证据（2026-11-24）**：分支 `feat/ROUTE-005-uncertainty-policy`（基线 `34de0de`）。RuntimeSettings 增加 `routingUncertainty`（schema v42 增量列，默认 `new_task`，省略保留 COALESCE 语义与 chatLaneEnabled 同款，非法值 400）；`new_task` prompt 逐字节不变（回归断言），`continue_recent` 仅追加保守判据，`ask_first` 允许 `clarify` 决策（question ≤400 字符，非 ask_first 模式收到 clarify 走既有规则兜底不阻塞）。`applyRoutingClarification` 在事务内以 `routing-clarification:<eventId>` dedupe 写 owner Outbox 待办（无 taskId、不创建 Task/Run、事件正常结算 processed），重放返回同一消息；processor 新增 clarify 分支，`applyRoutingDecision` 显式拒绝 clarify。Web：`routing.clarification_required` 归类「回答」待办，抽屉展示问题与原始消息，「去回答」回对话页不带 taskId（重新走 Router），复用既有 continuation 链路。测试：`test/routing-uncertainty.test.ts` 5 测试；`App.test.tsx` +1、`types.test.ts` +1；真实 magpie/qwen4-max 双候选歧义消息（“预算控制在两千以内，别的你看着办”）实测产出 clarify 中文问题；单候选场景真实模型倾向 continue_task（保守合理，已登记）。门禁：`pnpm check` 116 文件/1212 测试全绿（statement 85.73% / line 88.93%）、`pnpm smoke`、`pnpm smoke:crash` 通过。剩余风险：clarify 遵守度未系统评测；设置页「不确定时」radio 仍锁定（R4 解锁）；澄清待办无自动过期（用户不回答则消息保留在待办，原输入已在 payload 可追溯）。回滚：revert 即回 v41 行为，增量列旧代码忽略；已产生的澄清待办为普通 Outbox 消息可读。

### R4 只读测试归类 API + Web 解锁

- 分支建议 `feat/ROUTE-005-preview-and-ui`，依赖 R1–R3。
- `POST /v1/routing/preview`：bearer + owner，输入一句话，复用 `listRoutingCandidates` 投影 + 当前生效 routerMode/规则/策略执行 dry-run，返回决策/理由/命中规则；零持久化副作用回归断言（Task/Run/Outbox/routing_decisions 均无新行）；模型调用计量 `component=router` 如实入账；超时/失败返回诚实错误不兜底成假决策。
- Web `SettingsPage` 解锁三区：归类规则列表/添加/编辑/启停/删除（复用工作规则抽屉模式，409 自动重读）、不确定时 radio（读写 R3 设置）、测试归类输入+结果卡；rules 模式下规则区如实标注仅作用于智能判断。
- 门禁：`App.test.tsx` 回归、`workspace-theme` 合同、`pnpm review:ui --force`、`pnpm a11y:review` 三主题 + 390px。
- **落地证据（2026-11-24）**：分支 `feat/ROUTE-005-preview-and-ui`（基线 `5637b34`）。`POST /v1/routing/preview`：bearer + owner，输入 ≤4000 字，复用 `listRoutingCandidates` + 当前已保存 routerMode/规则/策略执行 dry-run（合成事件不落库），返回 kind/reason/taskTitle/title/question/matchedRuleId；模型调用经 `MeteredJsonModelProvider` 以 `component=router` 如实入账（eventId=`preview:<uuid>` 不指向真实事件）；模型失败/未配置返回诚实 502 `routing_preview_failed` 不兜底假决策；privacyMode=mask 时经 PrivacyMaskingProvider。Web 解锁：归类规则列表/添加/编辑/启停/删除（`routingRule` 抽屉复用工作规则模式，409 提示重开）、rules 模式如实标注规则仅作用于智能判断、「不确定时」三值 radio 走既有保存链（省略保留）、测试归类输入+结果卡（含命中规则名）；系统硬规则保持锁定。测试：`test/routing-preview.test.ts` 2 测试（零持久化副作用断言：Task/Event/Outbox/routing_decisions 均无新行）；`App.test.tsx` +1 全链路（规则渲染/启停 PUT/添加 POST/radio 保存 payload/preview 结果卡）；真实 magpie/qwen4-max HTTP preview 条件集成（命中规则+零副作用+计量入账）。门禁：`pnpm check` 117 文件/1216 测试全绿（statement 85.55% / line 88.75%）、`pnpm smoke`、`pnpm smoke:crash`、`pnpm review:ui --force`、`pnpm a11y:review` 0 违例。剩余风险：preview 使用已保存设置而非未保存草稿（UI 已如实说明）；真实模型遵守度未系统评测。回滚：revert 即恢复锁定占位与无 preview API，v40–v42 增量旧代码忽略。

### 集成与完成

- R1–R4 依次经集成 worktree 合入 main，每步 CI 全绿 + 合并态 `pnpm check` + `pnpm smoke`（R2 起涉及路由决策持久化，必须含 `pnpm smoke:crash`）。
- 全部合入后：Feature Map ROUTE-005 升级（按证据如实定 Partial/Usable）、`router-worker-design.md` 决策 4 扩展、`sealed-ui-rebuild.md` 占位解锁、经 Candidate + Supervisor 上线并实机验证三场景（规则命中/ask_first 澄清/测试归类）。
- 风险登记：prompt 注入规则的真实模型遵守度需实测（与 RULES-001 同类缺口）；`clarify` kind 是决策合同首次扩展，回滚需确认 v41 增量列兼容；`ask_first` 若澄清链路契约不齐，R3 可先只落 `new_task`/`continue_recent` 并把 `ask_first` 单独拆出，不得为赶进度伪造待办。

### 集成记录（2026-11-24）

- **迁移重编号**：上游 main 在本 Feature 开发期间合入 APPROVAL-001（PR #65/#66，占用 v40–v43）与 EXEC-003（PR #67，占用 v44）。集成 worktree `int-route005-r1` 将本 Feature 迁移重编号：v40→v45（`routing_rules`/`routing_rule_commands`）、v41→v46（`routing_decisions` 命中证据两列）、v42→v47（`routing_uncertainty`）；self-change `maximumSchema` 42→47；`test/sqlite-store.test.ts` 迁移列表与 `test/rollback-compatibility.test.ts` 阈值同步更新。上文各阶段落地证据中的 v40/v41/v42 为当时分支上的历史编号，语义与表结构不变。全部迁移仍为纯增量（新表/新列），回滚 = revert，旧代码忽略新对象。
- **合并态门禁（基线 origin/main `cdfb0da`，merge commit 见分支 `int-route005-r1`）**：冲突解决 6 文件（feature-map 头部合并、runtime_settings INSERT 列合并、worker/main import、迁移列表、Web api/types 可选字段并集）；上游 `test/approval-rules.test.ts` 最大迁移版本断言 44→47 同步。format/brand/lint（含 css-cascade）/typecheck/knip/build 全绿；`vitest run --coverage --no-file-parallelism` 128 文件 / 1312 测试全绿（3 次运行 2 次全绿；1 次仅既有 `dsh-cli-executor` SIGTERM→SIGKILL 计时用例抖动，该文件与 executor 源码相对 main 零 diff，隔离复跑通过，按 SCHEDULE-001 先例降低并行复跑，未改测试或阈值）；`pnpm smoke`（task 391a304a）、`pnpm smoke:crash`（event-claim/tool-call/write-back 三注入）、`pnpm review:ui --force`、`pnpm a11y:review` 0 违例、`pnpm review:canary --changed-from origin/main`（无外部服务文件变更，按规则跳过）；真实 magpie/qwen4-max 条件集成 3 测试合并态复跑通过（12.7s）。
- **合并与上线（2026-11-24）**：第二次合并 origin/main `3dd768b`（仅 EXEC-003 发布记录 docs，冲突仅 feature-map 头部）后复跑合并态测试全绿。PR #69 经 CI run 45322184125 success 合入 main（merge `92dfc88`，main CI run 45322744431 success）。隔离发布 worktree `release-92dfc88` 完整门禁 + `pnpm smoke:self-change` + evidence `ready-for-review` 后，经 `buildSelfChangeCandidate` 构建 Candidate `main-92dfc88-r1`（schema 31–47，无破坏性迁移），APFS clonefile 重锚定复核通过，Supervisor staging→verifying→stable，schema 44→47。主仓 ff + `build:server` + kickstart 后真实 restart 验证；删除发布 worktree 后 `/readyz` 不变。实机验证：设置页三区解锁实拍、真实模型 preview（HTTP + UI 各一次）零持久化副作用（Task/Event/Outbox/routing_decisions 计数 47/87/1051/77 前后不变）、规则抽屉权限边界声明如实。active=`main-92dfc88-r1`、previous=`main-cdfb0da-r1` 可回滚；运行时回滚 `POST /v1/recovery/rollback`，代码回滚 revert merge `92dfc88`（v45–v47 纯增量，旧代码忽略）。详细发布记录见 `docs/feature-map.md` ROUTE-005 专节；实拍存 `research/route-005-live/`（本地不入库）。开发/集成/发布 worktree 与分支已清理。
