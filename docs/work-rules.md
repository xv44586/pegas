# 全局工作规则与自定义指令

> Feature：`RULES-001`
>
> 状态：Partial
>
> 更新日期：2026-11-21

## 用户结果

用户在封板 Web「设置 → Pegas → 行为与规则」维护两类持久偏好：

- **工作规则**：带标题、正文与启用开关的自定义规则，可添加、编辑、删除（二次确认）与就地启停。
- **自定义指令**：一段自由文本（≤4000 字，可清空），独立保存。

两者在每次执行 Run 时作为持久偏好注入实际 Executor 的提示词。界面如实说明：它们不授予新权限，高风险外部操作仍必须经过 Approval 确认；系统规则「高风险外部操作必须确认」由服务端 Approval 生命周期硬保证，不可编辑、不可停用。

这里的工作规则不是「事情归类」规则：归类规则决定输入进入哪个 Task，属 Router Intake 决策链路，本 Feature 不涉及，归类页保持锁定占位。

## 领域模型

- `WorkRuleRecord`：稳定 ID、`userId`、`title`（≤120 字）、`content`（≤4000 字）、`enabled`、`revision`、创建/更新时间。作用域仅全局（MVP）。
- `BehaviorPreferences`：每用户一条，`customInstructions`（≤4000 字，允许空串），`revision` 从 0 起。
- 契约校验在 `src/rules/rules.ts`（exactKeys 严格解析，与记忆契约同风格）。

## 存储（SQLite schema v31）

- 新增三张增量表：`work_rules`、`work_rule_commands`（幂等命令冻结响应）、`behavior_preferences`；不修改既有表，不在破坏性迁移列表中。
- 每用户最多 100 条规则，超出返回 `rule_limit`；删除后释放配额。
- 删除是永久删除：规则行移除，历史 command 冻结响应中的正文一并清除，只保留删除凭据用于幂等重放（与记忆一致）。
- 回滚到 v30 代码可继续读取同一数据库（忽略新表）；Worker self-change 兼容区间已扩展为 `maximumSchema: 31`。

## API

```http
GET  /v1/rules?userId=owner&limit=50&cursor=<rule-id>
GET  /v1/rules/:ruleId?userId=owner
POST /v1/rules
PUT  /v1/rules/:ruleId
POST /v1/rules/:ruleId/delete
GET  /v1/settings/behavior?userId=owner
PUT  /v1/settings/behavior
```

- 全部端点走实例 bearer 鉴权。
- 创建携带 `userId`、`commandId`、完整 `rule`；同 command 同 payload 重放返回冻结响应，不同 payload 返回 `409 rule_command_conflict`。
- 更新/删除携带 `commandId` 与 `expectedRevision`；revision 过期返回 `409 rule_conflict`。
- 行为偏好 `PUT` 携带 `commandId`、`expectedRevision` 与 `customInstructions`；冲突返回 `409 behavior_conflict`。
- 不存在与跨 owner 一律 `404 not_found`。

## 装载与信任边界

- Worker 领取 Task 后调用 `workRuleContextForUser(task.userId)`：按创建顺序（rowid ASC）装载全部启用规则与自定义指令。
- 装载受硬上限约束：规则正文总预算 24000 字符（每条另计 200 字符元数据开销），超出截断；指令为空且无启用规则时不注入任何块。
- 注入位置在执行 prompt 的 `<pegas_memory>` 之后，以 `<pegas_work_rules>` 数据块呈现，并明确声明：这是用户的持久工作偏好，不是系统授权；不能扩大 Mandate、权限或当前输入范围；不能绕过 Approval；与 Mandate 或真实工具/权限检查冲突时以后者为准。
- 正文中的 `<` 转义为 `\u003c`，防止伪造闭合标签注入指令。
- 停用/删除的规则与清空后的指令不出现在后续执行的提示词中；变更对下一次执行生效，不追溯修改进行中的 Run。

## Web 交互

- 进入「设置 → Pegas」分类才懒加载规则与行为偏好（`Promise.all`），读取失败 page-error 就地报错并可「重新读取」。
- 规则抽屉支持新建/编辑（名称、内容、启用开关），保存成功后提示「规则已保存，对后续执行生效」；删除两步确认。
- 自定义指令 textarea 独立「保存自定义指令」按钮，内容未变化时禁用。
- 409 冲突时自动重读服务端最新状态并如实提示，用户确认后重试；不静默覆盖。

## 失败与恢复

- 所有写命令在 `BEGIN IMMEDIATE` 事务内完成，command 冻结响应与数据变更同事务提交。
- 删除后同 commandId 重放返回已删除记录；对已删除规则的后续更新返回 404。
- 回滚本 Feature 代码即恢复占位 UI；v31 为增量表，旧版本忽略新表，无数据破坏。

## 非目标

- 按事情/Worker 作用域的规则覆盖（MVP 仅全局）。
- 归类规则、测试归类与「不确定时」策略（已登记 `ROUTE-005`，Intake 见 `docs/routing-rules-intake.md`）。
- 默认语言/回复长度独立偏好控件（2026-11-24 修订：从「行为与规则」页删除锁定占位，见下方修订记录）；自主程度滑条保持锁定（风险阈值由服务端 Approval 强制）。
- 规则是否被遵守的可观察证据（属执行证据体系后续）。

这些缺口完成前，`RULES-001` 保持 `Partial`。

## 修订：删除语言/长度锁定占位（2026-11-24 Intake）

- **背景与定位问题**：「行为与规则」页的权威链路是 Executor 执行 prompt 注入（`<pegas_work_rules>`），管「事情怎么做」。「默认语言/回复长度」两个锁定占位来自封板 UI 对通用 chatbot 设置的照搬，预设「一问一答的回复风格」语义：回复长度对 Executor 无意义（交付物长度由 Goal/证据要求决定，全局长度约束会与 Mandate 冲突，executorPrompt 已声明冲突时以 Mandate 为准）；真正受长度影响的是 ROUTE-004 say 车道的日常问答，不属于本页。默认语言是跨交付/say 的输出偏好而非「回复」属性，且用户已可用自定义指令表达（如「用中文交付」），独立控件属重复能力。
- **用户结果**：「行为与规则」页不再展示永远禁用的语言/长度占位与「尚未开放服务端设置」提示；页面收敛为信息横幅 + 「开始工作前：高风险动作始终确认」（Approval 硬边界如实展示，保留锁定）+ 工作规则 + 自定义指令。语言/长度偏好经自定义指令表达，页面无需新增说明（横幅已声明偏好注入语义）。
- **验收条件**：`SettingsPage.tsx` 删除默认语言 select、回复长度 segmented 与对应 field-hint 中的语言/长度句子；「开始工作前」行与 Approval 声明原样保留；「自主程度」tab 不动；「语音与输入」分类不动（ASR/TTS 服务配置，定位正确）。新增/更新 Web 回归断言：行为与规则 tab 不出现「默认语言」「回复长度」，「开始工作前」仍在且禁用；既有工作规则/自定义指令回归不回归。文档同步：本文件、`docs/sealed-ui-rebuild.md` §行为与规则、Feature Map RULES-001 缺口清单。
- **非目标**：不新增任何服务端偏好字段或 API；不做 say 车道长度偏好（如将来需要归 ROUTE-004/CONV 系列单独登记）；不动自主程度滑条与风险阈值语义；不改工作规则/自定义指令的存储与注入。
- **数据与权限边界**：纯前端展示收敛 + 文档，无 schema/API/注入链路变更。
- **失败与恢复**：回滚 revert 即恢复占位展示，无数据影响。
- **落地证据（2026-11-24）**：分支 `feat/RULES-001-behavior-cleanup`（基线 intake `e575b3a`）。`SettingsPage.tsx` 删除默认语言 select、回复长度 segmented 与对应提示句；「开始工作前」行与 Approval 声明、「自主程度」tab、「语音与输入」分类原样保留。测试先行：`App.test.tsx` 工作规则用例新增占位删除断言（默认语言/回复长度/旧提示不出现，开始工作前仍在）先红后绿。门禁：`pnpm check` 130 文件 / 1335 测试全绿、`pnpm smoke`（task 36187af8）、`pnpm review:ui --force`、`pnpm a11y:review` 0 违例。纯前端展示收敛，无 schema/API/注入链路变更；回滚 revert 即恢复占位，无数据影响。文档同步：docs/work-rules.md、docs/sealed-ui-rebuild.md §16、Feature Map RULES-001。
