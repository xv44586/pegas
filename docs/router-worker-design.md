# Router / Worker 演进设计（PLAN-001）

> 状态：已采纳的设计决策与实施计划（Living Document）
>
> 决策日期：2026-11-21。本文是 Pegas 自有需求与架构决策的权威记录；调研过程与第三方样本分析保存在本地 `research/personal-agent-router/`（不入库），本文不依赖其存在。
>
> 实施进度：P0（ROUTE-003）已落地 Usable；P1（ROUTE-004 + EXEC-005）已落地 Partial（默认关闭，真实 DSH conversation 链路待实测）；P2 已落地（前置分流、400ms 收集窗口、Router/改写计量进 USAGE-001 账本）；P3 第一阶段（WORKER-002）已落地 Partial（手动三池 + effort + 终态错误停放，真实 DSH 三池执行待实测；自动分级押后）；P4（NOTIFY-006）已落地 Usable（欠账视图 + 四类只读 finding + 独立 Watchdog 进程与 API）；P5（COLLAB-001 sourceContext）已落地（新建相关事情 + 委派返回终态事实交接，真实模型遵守度待评测）。本轮 P0–P5 全部落地。证据与剩余风险见 Feature Map 对应小节。

## 1. 背景与问题

当前 Router（`ROUTE-001/002`）与 Worker 执行链已具备持久决策合同、claim fencing、五状态 Task/Run 状态机与完成门禁。对照"个人助理日常使用"目标，存在以下已核实的缺口：

- **F1 候选语义不一致**：主对话路由候选来自 `store.listTasks(userId)`（不过滤状态），`ModelTaskRouter` 只排除 `cancelled`，于是 `completed` 任务进入候选。store 层 `#applyTaskRoutingDecision` 对 completed 目标执行 Mandate 复核、对 cancelled 直接拒绝——**授权边界从未被突破**。实际问题是：① 主对话与 handback（`listOpenTaskCandidates`，排除 completed/cancelled）候选语义不一致；② 模型可能把新想法误投给旧任务，复核失败时整条事件 failEvent，用户输入被退回而非正确新建；③ 候选名额被历史任务占用。**定性：候选语义对齐属 Feature 缺口（ROUTE-003）；"误投→复核失败→输入被退回"单独登记 Bug 并附复现测试，修复随 ROUTE-003 落地。** 注意：不得把 F1 升级为安全事故——store 兜底一直存在，这是登记时的反向护栏。
- **F2 无即时应答路径**：闲聊、提问、致谢也走 create_task → Run → DSH session → 完成门禁，日常对话延迟与成本不成比例。
- **F3 候选摘要信息不足**：只传 `id/title/goal/status/statusReason`，缺"谁在等用户回答什么问题"（pending Approval、Executor 澄清、未消费 steering）、最近交付与最近输入。"用衬线吧"这类对等待问题的直接回答无法可靠归属。
- **F4 候选截断无相关性**：上限 20 按更新时间截断，历史任务多时活跃任务可能被挤出候选。
- **F5 路由成本不可见**：无确定性前置分流（显式 taskId/协作/Automation 之外）、无连发合并窗口、Router 模型调用未接入 USAGE-001 计量。
- **F6 执行资源无分级**：所有 Run 用同一模型档位；Provider 终态错误（401/403/模型不存在）与瞬时错误（429/5xx/超时）走同一条重试链，撞墙浪费预算。
- **F7 交付欠账不可见**：Run 终态与用户可见通知送达之间没有对账视图；"task 完成但回传丢失/Router 未更新"只能靠 lease 过期结算这一道网。

## 2. 长期边界（不变量）

以下约束在本轮全部改动中保持不变，任何实现违反即验收失败：

1. Router 只判断输入所属 Task 与控制意图，不判断 Executor 工具能力，不代替实际 Agent 向用户答复。
2. Conversation 权威状态在服务端；各端只做交互适配。
3. 用户可见的执行确认由实际 Executor 在检查真实工具与权限后生成；传输状态只作为界面元数据。
4. 三层路由分离：**渠道路由**（消息进哪个入口）保持确定性；**归属路由**（输入属于哪个 Task）留在现 Router；**模型/难度路由**（用哪个模型执行）落 WorkerProfile，绝不进归属 Router。
5. 控制意图（steer/cancel/approval）只接受已认证人类输入，共用既有事务与 fencing；任何新增快路径不得绕过。

## 3. 已采纳决策

### 决策 1：chat 承载 = 轻量 Task（A）

即时应答创建 `kind=conversation` 的轻量 Task，复用现有状态机、审计与 Outbox；隐式最小 Goal Contract（架构文档已允许），完成即 completed，无 evidence 门禁。conversation Task 不建 WorkerProfile 行、Run 快照精简；Channel 列表/搜索/统计过滤 conversation 类（挂 CHANNEL-003 筛选体系）。

**否决独立 chat 表**：它只在"chat 允许轻到可丢"时划算，与 Pegas 任何事可恢复、可审计、服务端权威的承诺冲突；否则等于把 Task 机器重造一遍。

### 决策 2：reply 确认语义 = 正文零确认（C'，一步到位）

chat 正文零确认、零过渡："已收到"由 Inbox 传输元数据（CONV-003）承担，"在干什么"由运行状态/工具步骤可见性承担。**不保留**"需工具耗时→先写一句具体确认"分支。危险动作确认仍在执行点由 Executor 检查真实工具权限后生成（EXEC-002/APPROVAL-001 语义不变）。

验收：chat 回复无"好的/收到/我来/我来查"式开场与口头预告（fixture 断言）；过程可见性缺失时也不得回退为模板确认。

### 决策 3：执行池 = 可缺省 + 优雅降级（C）+ 两条护栏

fast/balanced/deep 三池全部用户可配可缺省，初始映射不硬编码：默认 balanced=全局 Agent 默认模型，fast/deep 留空待用户选。允许 1–3 池任意配置，缺省降级链 fast→balanced→全局默认。effort 与池正交：池选模型，effort 选推理深度，Run 快照两者都记。自动难度分级仅在 ≥2 池且评测达标后启用（见 P3 第二阶段）。

两条护栏：

1. **不静默换池**：池指向的模型不可用时，本次 Run 按降级链显式落定，"原池→实际池+原因"记进 Run 快照；路由不了的执行请求显式拒绝并说明原因，绝不悄悄落到用户没配置的模型。
2. **池选择权先给执行/规划侧按池描述挑**，不做难度分类器；自动分级继续押后。

验收：单模型用户全链路行为与现状一致；池/effort 进 Run 快照与 session 兼容性检查。

### 决策 4：前置分流 = 按风险分场景（纯规则先行）

| 场景                 | 误判代价          | 方案                                                                                                      |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| 命令/控制意图        | 高（漏掉=失控）   | 纯规则注册表，唯一匹配才旁路；旁路仍走人类认证与同一事务                                                  |
| 任务归属             | 高（错投=污染）   | 确定性优先链（显式 taskId/协作/Automation，已有）                                                         |
| 主对话"闲聊 vs 任务" | 高（误吞=丢任务） | 保守规则（问候/致谢白名单），不确定 100% 进 Router                                                        |
| 群聊 ambient 插话    | 低（漏答一句）    | 留待未来多用户/群聊 Feature：辅助小模型判定 + 四护栏（不起主模型、skip 零痕迹、失败开放、被召唤永不判定） |

不引入 embedding/小模型强依赖。埋点记录命中率与误判，成本/延迟成为实测问题后再评估语义分流。验收：规则不确定时 100% 进模型。

### 决策 5：F1 定性 = Feature 缺口为主 + 单独 Bug（B 主 A 辅）

候选语义对齐按 ROUTE-003 Feature 登记（"主对话与 handback 候选语义一致"是从未实现过的预期，不是回归）；"模型误投 completed→复核失败→用户输入被 failEvent 退回"单独开 Bug 记录并附复现测试（可复现的用户可见失败），修复随 ROUTE-003 一起落地。判据是**有没有被违反的既有契约**，不是现象严重度。登记时保留反向护栏：store 兜底一直存在，非授权漏洞。

## 4. 实施计划（P0–P5）

依赖顺序：P0 → P1 → P2；P3/P4/P5 独立可并行。每个 P 项一个 Feature ID、一个隔离 worktree、一个 PR 系列。

### P0 路由输入修正（ROUTE-003）

**用户结果**：主对话里"继续/纠正/停止"永远指向正确的开放任务；已完成任务的续接只走 Mandate 复核路径；历史任务再多也不挤掉活跃候选。

1. 新增 `store.listRoutingCandidates(userId, opts)`：`status IN ('backlog','unstarted','started')`，排序 waiting-on-user 优先 → `updated_at DESC`，上限 20 不变；主对话与 handback 共用（handback 保留 excludeTaskId）。
2. 候选摘要从权威事实推导，新增 `awaiting`（pending Approval 问题/Executor 澄清/未消费 steering，各取最新一条 ≤160 字符）、`lastDelivery`（最近 completed Run output 首行 ≤120 字符）、`recentInput`（最近用户输入首行 ≤120 字符）。全部由服务端查询生成，不接受 Worker 自由文本作为权威摘要。
3. completed 不进默认候选；显式引用 completed taskId 走既有 TASK-002 恢复路径，store 复核兜底保留不动。
4. routerSystemPrompt 增加：候选 `awaiting` 非空时，对该问题的直接回答优先 continue 该任务。

**验收**：F1 复现测试先行（completed 不出现在主对话候选）；store 复核拒绝行为不变；唯一 awaiting 任务存在时"用衬线吧"正确 continue（fixture 模型）；300 个历史 completed + 3 个活跃任务时候选仍含全部活跃任务；PRIVACY-001 wrapper 链路不变。

**非目标**：不改 Decision 合同、不改 fencing、不做语义检索候选。**回滚**：纯查询与 prompt 变更，无 schema 迁移。

### P1 即时应答路径（ROUTE-004 + EXEC-005）

**用户结果**：日常提问/闲聊秒级得到同一个 Pegas 的回答，不产生重量级 Channel；需要干活的事仍走完整 Task 门禁。

1. `RoutingDecision` 新增 `{ kind: 'reply'; input; reason }`：无需 Task 的即时应答分类。Router 依旧只分类，不产生回答内容。判据："一句话能答、无外部副作用、无需交付物"才 reply；不确定时 create_task。
2. **对话执行单元**（Executor 的一种，不是 Router 的一部分）：用户级单例滚动 DSH session（key=`conversation:<userId>`），单一人格 system prompt + MEMORY-001 全局记忆；工具面只读（查任务状态/记忆等），无写副作用工具；遇到需要副作用/长工作的请求产出结构化 `suggest_task` 信号，Control Plane 将其作为新输入重新路由，形成 chat→Task 升级闭环；回复走正常 Outbox。
3. 承载按决策 1：reply 创建 `kind=conversation` 轻量 Task，Run 绑定 conversation executor。常驻性=session 长驻（体验常驻），进程仍是现有 Worker Runtime 按事件唤醒；空闲回收只关 runtime、留 session，下条消息 resume。
4. 独立预算：config 新增 `chatConcurrency`（默认 1–2），与 `workerConcurrency` 分池；重任务占满时 reply 不受影响，chat session 永远拿不到重任务执行权限。
5. 控制意图不受影响，优先级高于 chat。

**验收**："今天星期几"→ reply → Outbox 回复，无重量级 DSH session（fixture 断言 executor 类型）；双向并发隔离；chat 中"帮我改 X 代码"→ suggest_task → 正常 create_task 全门禁；Worker 崩溃后 conversation session 可 resume（EXEC-003 崩溃注入手法）；chat 与 Task Executor 共享同一 prompt/记忆来源；决策 2 的零确认 fixture 断言。

**非目标**：Router 亲自回答（禁止）；chat 内执行副作用；群聊语义。**权限边界**：conversation Task 的 Mandate 为隐式最小只读授权，升级必须重新接单。**回滚**：settings 新增 `chatLaneEnabled`（默认关），关闭后 reply 兜底为 create_task，行为回到现状；轻量 Task 数据保留可读。

### P2 路由降本（并入 ROUTE-003/004 后续缺口）

1. 确定性前置分流（决策 4）：新增"唯一匹配控制命令"规则（"停掉 X"且 X 精确匹配一个 started 任务标题 → 直接 cancel，仍走同一事务与人类认证）；问候/致谢短文本白名单。
2. 短收集窗口：同一用户 300–500ms 连发 user.message 合并为一次路由输入；steer/cancel/approval 与显式 taskId 永不延迟。实现为 Inbox 领取侧批处理，不改事件持久化。
3. Router 计量接入 USAGE-001（component=router，runId 可空）。

**验收**：连发 3 条只产生 1 次路由调用；控制命令零延迟旁路；计量可查；规则不确定 100% 进模型。

### P3 执行资源分级（WORKER-002）

第一阶段（手动三池，决策 3）：RuntimeSettings 增加 `executionPools: { fast, balanced, deep }`（各指向已配置 provider/model，可缺省）；WorkerProfile override 扩展 `pool` 与 `effort`（兼容现有 modelMode）；Run 快照记录 pool/effort 与降级原因；事情级执行设置加档位选择。

失败分类：Executor 错误分 `transient`（429/5xx/超时/网络，走现有重试链）与 `terminal_provider`（401/403/模型不存在，首次即停放 Task 为 awaiting-condition 并 Outbox 告知，不消耗重试预算）。

第二阶段（自动分级，后置）：确定性估计器 → 池映射；低置信保守档；有界升级仅在 GOAL-001 验证失败时触发，绑定 acceptance digest，切换次数上限，升级永不放松验收标准。启用门槛：≥60 中英任务对比固定强/省基线，成功率降幅 ≤5pp 且成本更低，否则保留手动。

**验收（第一阶段）**：pool/effort 进 Run 快照且 session 兼容性检查包含它们；terminal 错误不产生重试后继；旧 profile 数据兼容；单模型用户行为不变。**回滚**：新增字段可空，旧 Release 读取不受影响。

### P4 交付可靠性对账（NOTIFY-006）

1. 欠账视图：查询"已完成/已停放 Run 中，用户可见通知仍 pending/failed/unknown 的清单"（Run × Outbox dedupeKey 关联）。投递失败 ≠ 结清。
2. 对账 finding（进 Supervisor 健康检查或独立只读 Watchdog，沿用 OBS-001 边界——只读、不写产品状态）：
   - `Unreported`：Run 终态 > N 分钟但无对应 sent Outbox；
   - `NeverStarted`：Task started 但无 Run；
   - `Stranded`：queued Run 超 lease 窗口无人领取且节点在线；
   - `StaleWaiting`：waiting Run 的等待条件已满足但未唤醒。
     finding 只产生告警指标与日志，修复仍走既有恢复链，不新增自动修复路径。
3. 重启恢复语义不变；对账是第二道网，不是替代。

**验收**：四类 finding 各有故障注入测试（SIGKILL 于结果写回前/后、通知发送中）；对账进程崩溃不影响主链路。

### P5 协作上下文合同（并入 COLLAB-001 下一缺口）

完成事实向新任务结构化流动，不复用 session："新建相关 Channel"与委派返回续接时，来源 Task 最近 Review Pack 摘要（summary + 关键决定 + artifact 引用）作为结构化 `sourceContext` 注入新 Task 首个 Run 输入，标记来源 taskId/relationId；不 resume 旧 session（授权复核与 session compatibility 边界不变）；与 context note 的区别：sourceContext 是终态事实交接，不授予权限。

**验收**：cancelled→新建相关 Channel 携带来源摘要且权限不扩大；来源摘要经 PRIVACY-001 边界；旧数据无 sourceContext 时行为不变。

### P6 真实供应商实测修正（EXEC-006，2026-11-22）

真实模型 + 真实 DSH 首轮实测暴露四个缺口，本节记录已落地的语义修正：

1. **相关事情引用是确定性意图，不交给模型**：`payload.sourceTaskId` 存在时，无论模型答 reply/continue/steer，处理器一律强制 `create_task` 并注入服务端派生的 sourceContext；来源无终态事实时 failEvent 退回，绝不静默降级成对话。模型只负责没有结构化引用时的归属判断。
2. **continue_task 不追加并行 Run**：目标 Task 存在 queued/running Run 时，用户继续输入按 steering 语义处理——queued Run 直接合并进输入（`[用户补充]` 块），running Run 追加 steering 指令，由既有 supersede 机制生成唯一后继。修复了实测中"6 秒内连发两条消息产生两个并行 Run，steering 后继被无关 Run 永久阻塞"的卡死。automation 与 collaboration 事件保持既有追加语义（调度提示与协作交接需要独立 Run 承载其 provenance）。同一事件的决策重放必须一致，否则拒绝。
3. **执行过程可见**：Executor 进度事件扩展为 acknowledgement + activity（工具调用、推理步开始/结束）；Worker 把 activity 汇总成单条 coalesced Outbox `run.progress` 投影（工具调用次数、完成步数、最近 ≤20 条动态），经 PRIVACY-001 还原后到达 Web；工作详情按 Run 展示执行动态，不再"只能傻等"。
4. **推理档位为受控选择**：事情级 effort 从自由文本改为下拉（默认/low/medium/high/max），已有非标准值保留可见可存。
5. **进度与结果的展示分工（第二轮实测反馈）**：`run.progress` 是工作详情的私有投影，不进入主 chat 与正文时间线；工作详情按 Codex 式工作流展示——顶部用时统计，Run 级「工作流程记录」默认收缩，推理步分组内的工具明细二次收缩；终态结果在主 chat 携带上下文 cue（事情标题 + 原始请求 + 最近用户补充，全部由服务端权威事件在客户端推导，不改写 Outbox 原文）。
6. **完整执行记录 = 轻列表 + 按需全量（第三轮，借鉴 Codex transcript 数据分工）**：Codex 的列表 item 只带类型/标题/计时，重内容（命令输出、diff）显式 deferred，打开详情才按需读取权威记录。Pegas 对应实现：DSH `--json` 的 text/thinking/tool_call(input)/tool_result(result)/step 逐条落 `run_activity_entries`（v35，durable、owner 隔离、有界截断），列表仍用 coalesced `run.progress` 轻投影；打开详情时经 `GET /v1/runs/:id/activity` 拉全量（运行中轮询），工具参数/输出与推理全文默认收缩、点击展开；正文与结果统一 Markdown 渲染。
7. **单一工作流入口（第四轮实测反馈）**：Run 行不再同时提供「查看完整记录」链接和独立的轻量「工作流程记录」两份重复视图（Codex 只有一条工作流，展开即是全部）。现在每个 Run 只有一个「工作流程记录」折叠块：摘要行沿用 run.progress 轻量计数；首次展开时按需读取该 Run 的 durable 全量记录，之后的每次展开直接复用已加载数据；运行中 Run 每 5s 刷新其记录。块内即完整 typed transcript——助手正文 Markdown、推理默认收缩、工具调用默认收缩（点开见完整参数与输出）、末尾「最终结果」默认收缩。无记录的旧 Run 展开后显示诚实空态；progress 与记录都缺失时仍保留可展开入口（点开按需加载）。原第二层「运行详情」抽屉删除。

**验收**：模型答 reply 时相关事情仍创建 work Task 且首 Run 含来源终态；连发消息只产生一个 Run 且输入合并；running 中继续输入生成可领取的 steering 后继；activity 经 Outbox 单条投影可见且脱敏还原；`pnpm check` + `pnpm smoke` + `pnpm smoke:crash`。

## 5. 明确不做（本轮非目标）

- 不重构 Task/Run 状态机、Mandate/Goal Contract/evidence 门禁、claim fencing——它们是本设计的地基。
- 不让 Router 回答内容、判断工具能力或选择执行模型。
- 不引入 embedding/分类小模型强依赖；不做自动难度分级（第一阶段）。
- 不做群聊/多用户 ambient 语义；不做历史任务语义检索候选（属 CHANNEL-003）。
- 不新增自动修复路径（对账只读）。

## 6. 登记与验收协议

- Feature Map 登记：ROUTE-003、ROUTE-004、EXEC-005、WORKER-002、NOTIFY-006（初始 Planned）；COLLAB-001/USAGE-001 更新下一缺口。
- 每项遵循 AGENTS.md：独立 worktree、验收条件先行、Bug 复现测试先行、`pnpm check` + 涉进程/持久化/通知/恢复链路时 `pnpm smoke`、Feature Map 与文档同步、完成声明附证据与剩余风险。
- F1 的 Bug 记录随 ROUTE-003 首个 PR 提交，附复现测试与"非授权漏洞"定性说明。
