# 归类规则、不确定时策略与测试归类（ROUTE-005 Intake）

> Feature：`ROUTE-005`
>
> 状态：Planned（仅 Intake 登记，尚无实现）
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
