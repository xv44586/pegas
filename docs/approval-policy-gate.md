# 权限档位与审批 Policy Gate（APPROVAL-001 第二阶段）

> 状态：P1 Gate 覆盖面、P2 权限档位对象、P3 规则批准已实现（见下方实现记录）；P4–P5 仍为 Intake
> 更新日期：2026-11-23
> 基线：`origin/main` `74c2f8c`（Intake 初稿基线 `4baab43`）
> 外部调研：`research/approval-permissions-codex-cindy/NOTES.md`（本地，不入库；Codex CLI/webview、Cindy Apache-2.0 docs、DSH MIT 源码）

## 背景：当前审批桥的三个登记缺口

1. **覆盖面**：`dsh-approval-bridge` 只接 DSH `approval/request` seam（沙箱越权类调用）。沙箱内直接允许的工具（区内写、读任意路径、网络 fetch/search、bash 区内命令）不产生 Action/Approval，也不经任何风险判断。
2. **风险分级**：桥创建的 Action 一律 `risk: high`，没有 low/medium/critical 语义；`docs/approval-lifecycle.md` 预留的「low/medium 由 Action Policy 自动授权路径承接」尚未存在。
3. **档位与授权**：执行权限只有 Run 快照里的 `read-only | workspace-write | danger-full-access × ask | never`，用户不能在事情进行中收紧/放宽；批准只有一次性 `allowed-once`，同类调用每次都重新审批；自动审阅（模型初审）不存在。

外部参照结论（详见研究笔记，此处只保留 Pegas 自有决策）：

- 审批的通用挂点是 DSH `tools/pre-execute` waterfall（可返回 `ask`/`deny`），不止越权 seam；`tools.guard()` 提供审批后仍生效的单调拒绝，适合做不可绕过底线。
- 成熟产品把「权限档位」「单次审批」「持久规则」「自动审阅」分成四层，而不是一个开关；自动审阅以动作实际效果分级，以用户原话为唯一授权来源，失败一律降级人工确认。
- 控制面自修改（Agent 给自己升权）在任何档位下都强制用户确认，是唯一不允许自动化豁免的类别。

## 用户结果

- 用户可以为每件事情选择权限档位（默认「标准」），运行中随时收紧或放宽；收紧对下一次工具调用立即生效，放宽只影响后续审批，不改已排队 Run 的快照下界。
- Pegas 在标准档位下自动放行低风险动作（读、区内写、测试构建），只在真正需要判断的动作上发审批卡；审批卡说清楚「要做什么、影响什么、为什么需要确认」，并显示操作本身（命令/路径/网络目标），不是 JSON。
- 用户批准时可以选择「仅这一次」或「本事情内同类操作」；后者形成可见、可撤销的持久规则，参数变体不命中。
- 审批在手机与电脑是同一张卡：任一端先做的决定生效，其余端同步收口；自动化触发的跟进不因为调度获得新授权。
- 任何档位下，Agent 修改 Pegas 控制面自身（权限档、规则、凭证、发布配置）都必须经用户确认；完全访问档如实披露风险，不假装还有拦截。

## 领域模型（新增/扩展）

### PermissionProfile（档位，一等持久对象）

- 作用域：全局默认（RuntimeSettings）→ Task 覆盖（WorkerProfile 扩展，带 revision）→ Run 快照（创建时冻结，作为**下界**）。
- 档位枚举：`standard`（默认：workspace-write 沙箱 + Policy Gate 分级审批）、`strict`（read-only 沙箱 + 一切写/网络 ask）、`full`（danger-full-access + 显式风险披露；控制面自修改仍强制确认）。
- 生效语义：桥每次 `tools/pre-execute` 经 claim 只读 API 现读「生效档位 + 规则集 + 代次」；Run 快照是下界——运行中收紧立即生效，放宽不得越过快照声明的能力上限（放宽到超过快照需新 Run）。代次不匹配 fail closed。
- 切档命令：稳定 commandId + expectedRevision，幂等；切档事件写 Channel 时间线（可审计事实，不是聊天噪声）。

### Policy Gate（桥内确定性分级，第一阶段）

对每个工具调用按实际效果分类（不看工具名自述）：

| 类别                   | 判定（确定性）                                                 | standard 档位处置                         |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| read                   | fs 读/搜索、web fetch/search 只读                              | allow（记录 Activity）                    |
| workspace-write        | 写路径 canonical realpath 在工作区内                           | allow                                     |
| out-of-workspace-write | 写路径越界（含 symlink 解析后）                                | ask（risk high）                          |
| network-egress         | 向外部发送数据（POST/上传/消息类工具）                         | ask（risk high；含敏感载荷 critical）     |
| destructive-command    | 命令静态分类命中不可逆模式（rm -rf 区外、force push、DROP 等） | ask（risk critical）                      |
| control-plane-mutation | 写 Pegas 数据目录/权限档/规则/凭证/DSH home                    | **guard 硬拦 + ask（任何档位，含 full）** |
| unknown                | 无法静态判定                                                   | ask（fail closed to human）               |

- 静态分类只做确定性规则，不堆「看起来能拦」的正则当安全边界；真正的硬边界是 DSH sandbox 本身 + `tools.guard()` 底线。
- 每次判定落结构化记录（callId、类别、risk、依据、档位代次），经既有 Activity/审计链路可查。

### Approval 扩展

- Action `risk` 由 Gate 分级写入（low/medium/high/critical），不再一律 high；`approval.reason` 结构化（类别 + 白话说明），Web 渲染「需要你决定：…」。
- 决定选项扩展：`approve_once`（现有语义）/ `approve_rule`（本事情内同类：工具 + 参数指纹或命令前缀，持久规则带 scope、创建决定引用、撤销入口）/ `reject` / `revise`。规则命中仍走 Gate 记录，critical 与 control-plane-mutation 永不接受规则豁免。
- 授权来源：自动审阅与规则核对只认认证人类输入原话（Task Mandate/Goal/历史决策）；automation/协作机器输入不构成新授权（复用既有 provenance 边界）。

### 自动审阅（第二阶段，独立评审后实施）

- 在 Gate 与用户之间插入可选审阅阶段：候选优先评估 DSH `experimental-auto-review`（MIT、同进程、ask 政策下拒绝转人工）经 patch 组合；Pegas 侧负责把「用户原话授权投影」与审阅记录落库。
- 审阅超时/失败/超预算一律降级 ask；不静默放行、不静默拦截、不为争取放行换模型。
- 不整档切换 DSH `auto` preset（其绑定 danger-full-access，与默认沙箱相悖）。

## 验收条件

1. 标准档位下，沙箱内直通调用全部经 Gate：区内写/读静默放行且有 Activity 记录；越界写、外部发送、不可逆命令、未知类别产生对应 risk 的 Approval 并停放 Run（复用现有持久等待/恢复链）。
2. control-plane-mutation 在 standard/strict/full 三档都被 guard 拦截并强制审批；回归证明模型经 bash 间接写同样命中（canonical 路径判定）。
3. 运行中切档：收紧后下一次调用按新档位判定；放宽不越过 Run 快照下界；代次错配 fail closed；切档命令幂等、owner 隔离、时间线可审计。
4. `approve_rule` 创建的规则只在本 Task 生效、绑定指纹；参数变体不命中；撤销后下一次调用重新审批；critical/control-plane 类别拒绝规则豁免。
5. 审批卡结构化渲染命令/路径/网络目标与 reason；多端同一决定（既有唯一 decision 约束）不回归；移动端 390px 可完成批准/拒绝。
6. automation 触发 Run 的审批范围从 Task 已认证原话恢复；机器输入不能借规则/审阅扩大授权（对抗回归）。
7. 真实 DSH 探针：标准档位完成一个含区内写 + 越界写 + 网络发送的任务，越界/发送停放→批准→恢复→outcome 全链路；`pnpm smoke:crash` 三崩溃点不回归。
8. `pnpm check` + `pnpm smoke` 全绿；新增回归先红后绿；Feature Map APPROVAL-001 状态与证据同步。

## 非目标

- 不做 execpolicy 完整规则语言、managed network proxy、组织级 requirements/多租户策略。
- 不做 IM 渠道审批卡（渠道接入时复用共享决定语义）。
- 不改 Router 职责（仍只归属 Task）；不让 Web 成为档位/规则事实来源。
- 不在本 Feature 内实现模型自动审阅（第二阶段独立 Intake，先确定性 Gate 闭环）。
- 不迁移存量 Run 快照（不可变契约）；旧 Run 按旧语义执行至结束。

## 数据与权限边界

- PermissionProfile/规则/切档命令/审阅记录全部服务端持久化，owner 隔离；API bearer + Run claim 双通道语义沿用 APPROVAL-001 现有合同。
- 档位现读 API 是 claim 鉴权只读端点，返回生效档位 + 规则指纹集 + 代次；不返回凭证。
- 规则与档位变更 append-only 审计；删除规则不删历史决定。
- schema 迁移 additive（新表 + WorkerProfile 可空列）；回滚 Guard：存在 active 规则/非默认档位时拒绝回滚到不支持的 Release。

## 失败与恢复

- Gate/档位读取失败、代次错配、分类器异常：一律 ask（fail closed to human），不静默放行。
- 桥创建 Approval 失败沿用现有 fail closed（Run 失败，不放行工具）。
- 批准/规则写入沿用唯一 decision + 幂等 command 约束；崩溃后 Inbox lease 过期重领，不重复副作用。
- 回滚本 Feature：恢复「仅越权 seam 审批」旧行为；新表数据保留不删除，旧代码忽略。

## 实施顺序（最小纵向闭环优先）

1. **P1 Gate 覆盖面**：桥 pre-execute 主动 ask/deny + 确定性分类 + risk 分级 + guard 底线（无新 schema，先让「沙箱内直通」全部过审）。
2. **P2 档位对象**：PermissionProfile 持久化 + 现读 API + 切档命令 + Run 快照下界 + Web 档位选择器。
3. **P3 规则批准**：approve_rule + 规则持久化/撤销 + 指纹命中。
4. **P4 审批卡升级**：结构化渲染 + reason + 移动端 + 通知深链（DESIGN 合同同步）。
5. **P5 自动审阅**：独立 Intake（DSH auto-review 组合评估 + 授权投影 + 审阅记录）。

## P1 实现记录（2026-11-23）

- **实现**：`src/executor/policy-gate.mjs`（确定性分类器）+ `src/executor/dsh-approval-bridge.mjs`（pre-execute 分级 ask/deny、grant 命中提前放行、control-plane guard、risk/category 写入 Action）+ `src/executor/dsh-cli-executor.ts`（policy patch config 注入、`policy_decision` 事件→Activity）+ `src/worker/main.ts`（protectedRoots=dataDir）。无 schema 变更。
- **与 Intake 表格的差异（如实记录）**：
  - 「read 记录 Activity」目前经 `policy_decision` stdout 事件进入既有 Run Activity 进度流，未落独立审计表；档位代次字段随 P2 引入。
  - network-egress 的「含敏感载荷 critical」未实现（载荷敏感性判定不做静态猜测），P1 一律 high。
  - bash 区内 `rm -rf` 判为低风险交由沙箱边界（Intake 表格只把「区外 rm -rf」列为 destructive）；间接执行（eval/管道 sh/解释器 -c/xargs）一律 unknown→ask，宁可误报不静默放行。
  - control-plane-mutation 的 deny 是「本次调用拦截 + 停放审批」；批准后的 successor 调用仍被 guard 拦（P1 不提供控制面修改的执行通道，属 P2+ 的显式设计决策）。
- **证据**：`test/policy-gate.test.ts` 17 项（先红后绿）+ `test/policy-gate-integration.test.ts` 真实 DSH 探针 1 项（区内写放行落盘、越界写停放 `high/out-of-workspace-write`）；`pnpm check`（合并最新 main 后复跑）111 文件 / 1183 测试全绿（statement 85.54%、branch 78.3%、function 89.9%、line 88.7%），`pnpm smoke`、`pnpm smoke:crash` 通过。验收条件 1（除独立审计表）、2 的 standard 档路径、8 已满足；条件 3–7 属 P2–P5 与后续验证。
- **剩余风险**：bash 静态分类可被复杂构造绕过 ask 路由（硬边界仍是 DSH sandbox + guard，Intake 已声明非安全边界）；`rm -rf` 目标解析对变量/通配符不展开，此类命令落入 unknown 或依赖模式命中；探针网络发送路径未在真实 DSH 上覆盖（分类器单测覆盖）。
- **回滚**：revert 本 Feature 提交即恢复「仅越权 seam 审批」旧行为；无迁移、无数据删除。

## P2 实现记录（2026-11-23）

- **实现**：`src/approval/permission-profile.ts`（档位代数：strict<standard<full、`tierSandbox` 沙箱映射（全部 approvalPolicy=ask）、`combinePermissionTiers` 下界组合）+ `src/worker/worker-profile.ts`（`permissionMode` 解析/effective/fingerprint）+ `src/settings/runtime-settings*.ts`（全局默认 `permissionTier`，默认 standard，保存省略保留现值）+ `src/storage/sqlite-store.ts`（migration v40、切档审计与时间线事件、`runPermissionProjection`、`listWorkerProfileChanges`）+ `src/worker/run-execution-snapshot.ts` / `src/core/domain.ts`（快照 additive `permissionTier`）+ `src/control-plane/server.ts`（claim-only `GET /v1/runs/:runId/permissions`）+ `src/executor/dsh-approval-bridge.mjs`（每次 pre-execute 现读档位）+ `src/worker/main.ts`（沙箱 mode 从生效档位推导）+ `src/supervisor/rollback-compatibility.ts`（回滚 Guard）+ Web（事情抽屉「权限档位」选择器、设置页隐私区「全局权限档位」，完全访问需显式风险确认弹层）。
- **与 Intake 的差异（如实记录）**：
  - 未新建独立 PermissionProfile 表：档位持久化复用 `runtime_settings.permission_tier`（全局默认）与 `worker_profiles.permission_mode`（Task 覆盖，NULL=inherit），沿用 WorkerProfile 既有 revision/commandId 幂等与 owner 隔离；切档不设独立端点，走既有 `PUT /v1/tasks/:id/worker-profile`（fingerprint 含 permissionMode）。
  - 「代次」实现为 settingsRevision+profileRevision+双档位的 SHA-256 指纹（32 hex），不是单调递增计数；桥每次现读，mismatch/读取失败一律按 strict 处置（fail closed），不静默放行。
  - 桥现读无缓存（2s TTL 会违反「收紧对下一次调用立即生效」）；代价是每个工具调用一次本地 HTTP 往返（3s 超时）。
  - strict 档语义：read-only 沙箱；Gate 把 write/edit/apply_patch/bash 与 web_fetch/web_search 全部升为 ask；control-plane-mutation 的 guard 硬拦在任何档位（含 full）不变。full 档：danger-full-access 沙箱 + ask，Web 启用前强制风险确认；高风险动作仍走审批。
  - 切档审计为 append-only `worker_profile_changes` 表 + `task.permission_changed` 时间线 outbox 事件（白话文案）；`listWorkerProfileChanges` 提供 owner 隔离读取，Web 审计列表 UI 属 P4。
  - 审批时把当次 tier/generation/mismatch 写入 Action request（`policy_decision` 事件同步携带），审批卡可回看判定时的档位事实。
  - 存量 Run（无快照档位）按 mismatch→strict 处置：旧 Run 在桥下运行会全量 ask（fail closed），不迁移不可变快照；Worker 新 Run 一律带档位快照。
- **证据**：`test/permission-profile.test.ts` 16 项 + `test/permission-bridge.test.ts` 2 项（收紧下一次调用立即生效、断网 fail closed、strict 网络 ask、全档位 control-plane deny；先红后绿）+ Web `App.test.tsx` 事情级/全局档位切换与完全访问风险确认 2 项（先红后绿）；P1 探针 `test/policy-gate-integration.test.ts` 更新为带档位快照的 Run 后真实 DSH 复跑通过；`test/sqlite-store.test.ts`（v40 迁移清单）、`test/worker-profile.test.ts`（快照含 permissionTier）同步更新。`pnpm check`（合并最新 `origin/main` `6c0f013` 后复跑）113 文件 / 1205 测试全绿（statement 85.64%、branch 78.55%、function 89.8%、line 88.77%），`pnpm smoke`、`pnpm smoke:crash` 通过；合并后首轮门禁暴露两处测试基建计时抖动并修复：SIGKILL 升级回归隔离复跑稳定（P1 已登记同类抖动）、真实 DSH 探针补 Run lease 心跳（默认 30s lease 短于慢模型 turn，生产 Worker 本有心跳，探针直连 executor 缺模拟；心跳对停放后的 Run 停跳，不掩盖真实失败）。验收条件 3（收紧/放宽下界/错配 fail closed/幂等/owner 隔离/时间线审计）已满足；条件 2 的三档 guard 有单测覆盖（真实 DSH 三档探针未跑）；条件 4–7 属 P3–P5 与后续验证。
- **剩余风险**：每工具调用一次现读 HTTP 的时延与控制面负载（本地回环，未压测）；strict 档 bash 一律 ask 会产生高频审批（预期行为，P3 规则批准缓解）；full 档下 Gate 不再拦截区外写（如实披露，风险确认弹层承担告知）；旧 Run fail-closed 全量 ask 可能让存量等待中的 Run 恢复后审批变多。
- **回滚**：schema v40 additive（两列 + 审计表），旧代码忽略新列；Supervisor Guard 在存在非默认全局档位或 Task 覆盖时拒绝回滚到 <v40 的 Release（先切回 standard/inherit 再回滚）；revert 提交即恢复 P1 行为，审计数据保留不删除。

## P3 实现记录（2026-11-23）

- **实现**：决定词表扩展 `approve_rule`（`src/approval/approval.ts`，语义=批准一次 + 建立本事情内同类规则）；规则一等对象 `src/approval/approval-rule.ts`（类型/撤销命令解析）+ `src/approval/approval-rule-fingerprint.ts`（sha256 指纹，纯校验在 approval.ts 供 Web 复用）；migration v41：`approval_decisions` CHECK 重建含 approve_rule + append-only `approval_rules`（触发器只允许 active→revoked 翻转，禁删禁改）+ `approval_rule_revocations` 幂等账本；`decideApproval` 同事务建规则（重复指纹去重）+ `task.approval_rule_changed` 时间线事件；`runPermissionProjection` 返回 active 规则集并入 generation 指纹；HTTP `GET /v1/tasks/:id/approval-rules`、`POST /v1/tasks/:id/approval-rules/:ruleId/revoke`（bearer + owner，幂等撤销）；桥 `createApproval` 对可规则类别附加 approve_rule 选项（说明指纹范围），pre-execute 现读规则集按指纹放行（`policy_decision` 带 ruleId），seam 对已命中 callId 返回 allowed-once；Web 事情抽屉「已批准规则」列表 + 撤销，审批卡决定选项由 prompt 通用渲染。
- **与 Intake 的差异（如实记录）**：
  - 未新增独立 decide 端点：approve_rule 是既有决定 option kind，复用唯一 decision/幂等 command/successor 链路；规则创建与决定同事务，崩溃后不会出现「已批准但无规则」或反之。
  - 规则范围=工具 + 类别 + canonical 目标集合指纹（参数内容变体命中，目标变体不命中）；Intake 提到的「命令前缀」未实现——bash 命令前缀匹配无法确定性保证范围不扩大，P3 只对 out-of-workspace-write / network-egress 且 targets 非空的 high 动作开放规则；destructive-command（critical）、unknown、control-plane-mutation 一律不提供也不接受规则（服务端 risk 守卫 + 桥类别守卫 + guard 硬拦三层）。
  - strict 档下规则不放行：分类 reason/targets 语义随档位变化，指纹天然不匹配（fail closed 方向）；mismatch 时规则集视为空。
  - 规则命中复用 Gate allow 路径（Activity `policy_decision` 记录 ruleId），不逐次创建 Action/outcome；撤销后下一次调用重新审批（现读无缓存）。
  - 规则撤销是状态翻转 + append-only 历史（创建决定引用保留）；回滚 Guard：存在 active 规则时拒绝回滚到 <v41。
- **证据**：`test/approval-rules.test.ts` 10 项（指纹稳定性/类别守卫/决定建规则/幂等重放/critical 拒绝/无选项拒绝/撤销幂等与 owner 隔离/投影只含本 Task active 规则且 generation 变化/回滚 Guard/HTTP 面）+ `test/approval-rule-bridge.test.ts` 2 项（停放带规则选项→approve_rule→successor 同目标参数变体放行、目标变体 re-ask、撤销后 re-ask；control-plane 不提供规则）+ Web 2 项（审批抽屉选规则提交、抽屉规则列表撤销），均先红后绿；`pnpm check` 115 文件 / 1219 测试全绿（statement 85.72%、branch 78.61%、function 89.96%、line 88.87%），`pnpm smoke`、`pnpm smoke:crash` 通过。验收条件 4 已满足（指纹绑定/变体不命中/撤销 re-ask/critical 与 control-plane 拒绝豁免/owner 隔离）。
- **剩余风险**：规则命中不创建逐次 Action 审计（只有 Activity 记录 + 规则创建/撤销审计），逐调用独立审计表仍是登记缺口；规则目标集合精确匹配对「同目录新文件」不命中（保守方向，宁可多问）；真实 DSH approve_rule 全链路探针未跑（fake harness 覆盖）。
- **回滚**：revert 提交恢复一次性 grant 行为；v41 additive（新表 + decisions CHECK 重建保数据），旧代码忽略新表；Guard 在存在 active 规则时拒回滚（先撤销全部规则再回滚）。

## UI 设计合同（P4 输入）

- 审批卡：标题=动作白话摘要；副行=来源事情 + 触发消息锚点；主体=结构化操作预览（命令等宽块/路径列表/网络 host+方法）；「需要你决定」reason 行；选项=仅这一次 / 本事情内同类（说明指纹范围）/ 拒绝；备注可选；主按钮一个。
- 档位选择器：事情详情「执行」区 + 设置页全局默认；三档 radio 卡（标准/严格/完全访问），完全访问需显式风险确认弹层；当前档位与来源（全局/事情）常显文字。
- 规则管理：事情详情「已批准规则」列表（工具+范围摘要+创建时间+撤销）；空态说明规则来自批准时的选择。
- 视觉遵循 DESIGN.md 封板合同：白底、400/500 字重、--text-* 阶梯、状态纯文字+图标辅助、一个区域一个主按钮；移动端 390px 全功能。
