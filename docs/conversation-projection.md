# Conversation Projection

> Feature：`CONV-006`（投影合同）、`CONV-007`（任务托盘与锚点导航）
>
> 状态：CONV-006 Partial（服务端派生层 + 投影 API + Web 三声道渲染 + anchor 双向导航 + say 流式已落地；work 卡 criteria 内嵌摘要与就地解决计数联动未实现）；CONV-007 Usable（任务托盘 + 选中指向 + thread 结构分组已落地，验收 1–6 全覆盖）
>
> 更新日期：2026-11-23

## 用户结果

对话页不再把 Outbox 通知队列当成聊天流。进入对话流的每条事实由服务端派生投影属性，客户端只按属性渲染：即时问答以正文呈现、工作事件以锚定任务的折叠卡呈现、需要用户判断的事以行动卡呈现，过程噪声默认安静。用户随时知道「哪件事、到哪一步、该谁动」，并能从任一卡片回溯发起它的原始输入。

## 问题本质

现状缺「输出侧投影合同」：同一批领域事实（`run.progress`、`run.acknowledged`、`review.ready`、Executor 澄清、Approval）被无差别投影成聊天消息，导致过程刷屏、结果与判断混排、任务上下文丢失。本合同是以下既有约束在对话输出侧的统一落实，不新增权威：

- GOAL-001：Review Pack 是交付投影，不是完成事实来源；
- NOTIFY-004/005：默认安静、按 criterion 聚合、external 渠道脱敏投影；
- architecture：Conversation 权威在服务端，渠道只做交互适配；
- DESIGN-003：`run.progress` 不渲染为聊天气泡、过程收进状态条。

## 投影属性（服务端派生，客户端只读）

| 属性     | 取值                         | 含义                                 |
| -------- | ---------------------------- | ------------------------------------ |
| `lane`   | `say` / `work` / `decide`    | 渲染声道：正文 / 折叠事件卡 / 行动卡 |
| `anchor` | `{ taskId, eventId }`        | 归属任务与触发事件，双向可导航       |
| `weight` | `inline` / `card` / `silent` | 重量：正文级 / 折叠卡级 / 不进对话流 |

派生规则是确定性函数：输入事件类型 + Task 状态 + Policy。典型映射：

- 轻量对话 Task（`kind=conversation`）的答复 → `say` / `inline`；
- `run.acknowledged`、`review.ready`、Run 终态 → `work` / `card`，anchor 指向所属 Task；
- Approval 停放、Executor 澄清、投递核对 → `decide` / `card`，未决权威在「待你处理」；
- `run.progress` 与普通过程事件 → `silent`（仅托盘/状态条/审计可见）。

同一事件重放派生结果一致（幂等）。投影属性不接受客户端写入，不创造 Task/Run/Approval/Review Pack 权威。

## 验收条件

1. 服务端为每条进入对话流的事实派生 `lane/anchor/weight`，确定性派生有单元测试覆盖三类 lane 与 silent 过滤，重放幂等。
2. 投影属性随事件投影 API 返回；旧客户端缺属性时按兼容默认渲染（不报错、不刷屏），有兼容回归。
3. `say` 可流式；`work` 默认折叠、展开见 criteria 与操作；`decide` 未决计入「待你处理」，就地解决后扣减并变已决态。
4. `anchor` 双向导航：卡片→发起消息（滚动+高亮）、发起消息→派生卡片；`taskId` 打开事情详情。anchor 缺失降级为无导航卡片，不伪造来源。
5. `weight=silent` 不产生聊天气泡；过程只经托盘/状态条/审计入口可见。
6. 投影只读派生，不接受客户端写入；领域状态仍由既有领域负责。
7. 投影继承隐私边界：external 渠道走 `delivery-projection` 脱敏，restricted evidence fail-closed；不携带隐藏提示词/密钥/未净化参数。
8. 存储、派生、API 与 Web 渲染均有自动化回归，`pnpm check` 与 `pnpm smoke` 通过。

## 任务托盘与锚点导航（CONV-007）

插话（`intent:'steer'`）与排队的服务端能力已由 DESIGN-003 提供，本合同只登记呈现层，不重复服务端控制意图：

1. 托盘列出当前 owner 的进行中/等待任务（服务端 Task 投影），完成/取消后自动移除，空托盘不占布局。
2. 选中任务后输入器出现指向上下文条，提供「插话纠正」（走既有 steer）与「排队稍后发」（走既有队列）；取消选中恢复默认归属路由。
3. 控制权跟随选中而非系统活跃度；未选中时由 Router 自动归属（不改变 PLAN-001 路由职责）。
4. 锚点双向导航与 thread 分组按 anchor 合同渲染；分组用结构（缩进/竖线/嵌套）表达，不用解释性文案。
5. 托盘、上下文条、锚点导航在 390px 移动布局可达、无横向越线；键盘可操作、有可访问名称。

## 数据、权限与接口

- 投影属性是事件投影的只读派生字段，优先无 schema 变更（运行时派生）；如需持久化仅新增可空列，旧行按默认派生。
- 沿用实例 bearer + `userId` 所有者校验；托盘是 Task 列表只读投影。
- 选中态、主题、布局是客户端本地呈现偏好，不落库、不跨设备同步。
- 客户端不从消息正文推断任务状态、Worker 能力或投递结果。

## 非目标

- 不改变哪些事件进入 Outbox（NOTIFY 领域负责）。
- 不实现用户接受/返工持久化（GOAL-001/APPROVAL-001）；本合同只投影 decide 形态。
- 不新增服务端控制意图或路由逻辑；不实现任务创建/停止/归档（TASK 领域）。
- 不做全文搜索/分页/虚拟列表、托盘拖拽排序/固定。
- 不把投影属性当作完成/已读/投递/接受事实（四事实分离不变）。

## 失败与恢复

- 派生失败/属性缺失折叠为兼容默认（say 正文或无导航卡），不阻断消息送达。
- Task 投影加载失败沿用全局连接错误，托盘降级为空不阻断对话。
- steer/queue 失败沿用 DESIGN-003 既有错误与重试路径。
- 回滚只需回退派生层与渲染接入，无数据回写。

## 落地顺序

1. 服务端派生层 + 投影 API（最小闭环，Web 仍可读）；
2. Web 三声道渲染接入；
3. anchor 双向导航与 thread 分组、任务托盘（CONV-007）。

交互形态已在本地研究原型验证（`research/conversation-page-design/`，gitignored，不作为实现事实来源）。正式实现需在独立 Feature worktree 补自动化证据。

## 已落地实现（2026-11-22，第一阶段最小闭环）

- **派生层**：`src/conversation/projection.ts` 的 `deriveConversationProjection` 是纯函数（payload 类型 + Task kind + Run origin event → lane/weight/anchor），无 I/O、无 schema 变更。映射：`run.progress`/`run.acknowledged` → `work/silent`；审批/澄清/核对/等待类 → `decide/card`；Run 终态与协作回送 → `work/card`；`agent.message` 与 conversation Task 事实 → `say/inline`；未知类型兼容默认（conversation Task 为 `say/inline`，其余 `work/card`），不伪造 anchor。
- **读取路径接线**：`PegasStore.listOutbox`、`markOutboxRead`、`resolveOutboxMessage`（经 `#outboxForUser`）在返回前附加 `projection`；Task/Run 行读取失败降级为无 context 派生，不阻断消息。durable payload、`claimNextOutbox`（dispatcher 领取）与 external 投递（`externalDeliveryPayload`）均不携带投影属性。
- **API**：`GET /v1/outbox` 与 `GET /v1/channels/:id/timeline` 的 messages 自动携带 `projection`；`POST /v1/outbox` 忽略客户端提交的 projection 字段（`parseNewOutboxMessage` 白名单不接收）。
- **Web 最小接入**：`isSilentConversationMessage`（`web/src/sealed/types.ts`）优先信任服务端 `projection.weight === 'silent'`，无投影属性时回退既有 payload 类型过滤（`run.progress`/`run.acknowledged`）；聊天流过滤已切换。三声道卡片渲染、anchor 双向导航尚未实现（第二阶段）。
- **自动化证据**：`test/conversation-projection.test.ts` 27 测试（三类 lane 映射、silent 过滤、兼容默认、anchor 不伪造、重放幂等、durable payload 不落投影、dispatcher/external 不带投影、read/resolve 投影、API 返回与客户端写入忽略）；`web/src/sealed/types.test.ts` CONV-006 2 测试（信任服务端投影 / 旧服务端回退）；`web/src/sealed/ChatExperience.test.tsx` CONV-006 2 测试（服务端 silent 事实不进聊天流含未知类型 / 旧服务端兼容）。
- **门禁（2026-11-22）**：`pnpm check` format/brand/lint/typecheck/deadcode/build 通过；vitest 99 文件 / 1002 测试全绿（statement 85.01%、line 88.32%；并行满载下既有 dsh SIGKILL 计时用例抖动，隔离与串行复跑稳定通过，与本次改动无关）；`pnpm smoke`、`pnpm smoke:crash` 通过。

## 已落地实现（2026-11-22，第二阶段：三声道渲染与锚点导航）

- **三声道渲染**：`web/src/sealed/MainPages.tsx` 聊天流按服务端 `projection.lane` 分流——`say` 保持正文气泡；`work`/`decide` 渲染为 `FactCard`（`.fact-card`，头部 = 状态图标 + 短标签 + 任务名按钮 + 锚点回链，正文可展开，底部单一动作按钮）。decide 未决时按事实类型给出「审查交付 / 去回答 / 查看内容 / 去核对 / 核对投递 / 去处理」；`approval.resolved` / `action.reconciled` 匹配后卡片变已决态（`is-resolved`，动作消失）。无投影属性（旧服务端）整体回退为原有正文 UI，不报错不刷屏。
- **锚点双向导航**：卡片头部锚点按钮（「回到发起消息」）滚动+高亮发起消息（`is-anchor-highlight` 1.6s 闪烁）；发起消息下方出现「查看进展 · N」跳到最新派生卡片。anchor 只来自服务端投影，不从正文推断；anchor 缺失或发起消息不在当前流中时按钮不渲染，不伪造来源。任务名点击打开事情详情抽屉。
- **结构化分组**：卡片归属用任务名 + 锚点结构表达；删除了旧「原始请求：/你最近补充：」解释性文案（`taskContextCue` 收敛为仅任务标题）。
- **决定动作复用既有链路**：审批/核对/投递核对走 `openAttentionMessage`（与「待你处理」同一恢复/已读路径）；澄清走 `continueChannel`；审查走 review 抽屉。不新增服务端意图。
- **自动化证据（第二阶段新增/更新）**：`web/src/sealed/types.test.ts` +4 测试（lane/anchor 只读服务端、缺投影降级、approval/reconciliation 已决匹配）；`ChatExperience.test.tsx` +2 测试（decide 已决态无动作、未决有显式动作与锚点缺失不伪造）；`App.test.tsx` 3 个旧 cue/内联卡用例改写为投影驱动合同（含锚点双向往返断言）。
- **门禁（第二阶段）**：`pnpm check` 99 文件 / 1008 测试全绿；`pnpm smoke`、`pnpm smoke:crash`、`pnpm review:ui -- --force`（桌面/移动/三主题几何断言）、`pnpm a11y:review`（0 违例）通过。
- **仍未实现（CONV-006 剩余缺口）**：`say` 正文流式输出（现状仍是一次性完整文本）；work 卡内嵌 criteria 摘要（现经「审查交付/查看工作详情」抽屉下钻）；「待你处理」计数与聊天内就地解决的联动扣减仍以整页快照刷新为准。

## 已落地实现（2026-11-23，第三阶段：Executor say 声道接线与周期回告）

- **say 入口**：`POST /v1/runs/:runId/messages`（pre-auth run-capability 路由，claim header 鉴权，无 claim/伪造 403）。请求体严格限定 `{commandId, text}`（text ≤ 8000）；Task/Run/lane 服务端冻结，payload 不接受 taskId/lane。落盘为 conversation Outbox 的 `agent.message` 事实（dedupe `run-message:<runId>:<commandId>`），同键同 payload 幂等重放冻结响应，异 payload 409 `run_message_command_conflict`；Run 停止/claim 过期后拒绝。该事实只是投影输入：不结算 Run/Task，不铸造控制意图。权威实现 `parseRunMessageCommand`（src/schedule/schedule.ts）、`PegasStore.sayFromRun`（src/storage/sqlite-store.ts）、路由（src/control-plane/server.ts）。
- **即时可见**：conversation Outbox 是 Web 聊天流的读取源，`agent.message` 派生 `say/inline`（既有 SAY_TYPES 规则），消息入队即出现在对话正文，不等 Run 结束；anchor 指向所属 Task 与发起事件。无 schema 变更，Web 零改动（三声道渲染既有能力直接消费）。
- **周期回告决定（服务端确定性 Policy）**：机器输入（`source=automation` 的 origin event，含周期 Automation 与 Follow-up 到点）唤醒的 Run，其 `run.completed` 投影为 `work/silent`——完成卡不再重复刷屏，用户可见回告由 Executor 经 say 入口发出（执行合同要求周期触发的 Run 必须如此）。`run.failed`、审批/澄清等 decide 事实不受影响仍可见；人类输入驱动的 Run 完成卡行为不变。派生层新增 `runOriginSource` context（读取路径 JOIN inbox_events.source），纯函数与幂等语义不变。
- **执行合同**：DSH 合同新增 say 接口段落（正文即时可见、不代替最终答案、不结算状态、周期触发必须经此回告、commandId 网络重试键）。
- **自动化证据（第三阶段）**：`test/run-messages.test.ts` 5 测试（严格 payload、claim 鉴权 + 幂等/冲突/停止后拒绝 + say/inline anchor、HTTP 合同 403/201/409/400、周期触发端到端：创建 Run 完成卡可见 → 触发 Run say 正文 + 完成卡 silent）；`test/conversation-projection.test.ts` +1（automation 完成卡 silent、失败/decide/say 不受影响、web 来源不变）；`test/dsh-cli-executor.test.ts` +1 合同回归。

## 已落地实现（2026-11-23，CONV-007：任务托盘与选中指向）

- **托盘只读投影**：`web/src/sealed/MainPages.tsx` 在输入器上方渲染 `.task-tray`（`role=group` 「进行中的事情」），列出当前 owner 非终态任务（completed/cancelled 过滤），按 `latestActivityAt` 降序；每项为 `aria-pressed` 胶囊按钮，状态点区分 active（运行/排队，脉冲）、attention（有 `statusReason`，caution 色）、idle，附 `statusLabel`。空托盘不渲染、不占布局。
- **选中态与控制权**：选中是客户端本地偏好（`App.tsx` `onSelectTask` 设置 composerTarget，不落库）；`steerTarget` 严格跟随选中任务而非最活跃任务；未选中时输入走 Router 默认归属。已选事情保留目标，提交时由服务端复核；用户可清除或换目标。引用某条 Agent 回复时，输入器显示原文预览并提交其 Outbox ID，可点预览跳回原回复。
- **插话/排队指向选中**：`canSteer` 要求选中任务的最新 run 处于 running/queued，走既有 `sendSteerMessage`（`payload.intent:'steer'`）；`canQueue` 要求显式选中 + 非终态 + 活跃 run，排队消息在任务完成后经既有 `sendMessage` 发出。不新增服务端意图。
- **几何修复**：托盘使 composer 变高，`.composer-model-picker` 桌面/移动 `max-block-size` 扣减量各 +50px，保证向上弹出不越 viewport（review:ui 几何断言覆盖）。
- **review:ui 种子确定性**：`scripts/capture-ui-review.mjs` 改用 dsh fixture executor（`PEGAS_ROUTER=rules`、collect window 0）；fixture 对托盘任务在 run 内用自身 claim token 走真实 `POST /v1/runs/:id/goal-proposals` 提交 Goal Contract，run 完成后服务端依合同停在 `awaiting_evidence`，托盘实拍稳定可见等待中任务；连续 4 次 `--force` 全绿。
- **自动化证据**：`ChatExperience.test.tsx` 19 测试（CONV-007 新增 4：托盘列出/隐藏终态/切换选中、输入跟随选中而非最活跃、steer/queue 指向选中、空托盘不占布局与终态自动清除；既有 steer/queue 3 用例改为经托盘选中）；`App.test.tsx` 2 用例断言改 `findAllByText` 适配托盘标题重复；`pnpm check` 99 文件/1013 测试、`pnpm smoke`、`pnpm a11y:review` 0 违例。
- **仍未实现（CONV-007 当时缺口）**：同一任务连续事实的 thread 分组渲染（缩进/竖线/嵌套）——已由下方 thread 分组补齐；选中上下文条沿用「继续事情」横幅形态；托盘任务多时横向滚动、无分页/收纳。

## 已落地实现（2026-11-23，CONV-007：thread 分组渲染）

- **结构分组规则**：`web/src/sealed/MainPages.tsx` 纯函数 `groupMessageThreads` 把连续 ≥2 条同 `taskId` 的 pegas 非 say 事实卡合成一个 thread 块；单卡、任务交错（A-B-A）、用户消息与 say 均不成组、并打断分组。分组只在客户端呈现层做，不改服务端投影与消息序。
- **结构表达而非文案**：thread 渲染为 `<section class="message-thread">`（aria-label「事情进展：<任务名>」），左侧竖线用既有 `--line-strong` token + 14px 缩进（`web/src/sealed-ui.css`），无任何「你说过/来龙去脉」式解释性文案。
- **去重复任务名**：thread 内首卡保留任务名按钮（打开事情详情），第 2 张起 `FactCard hideTaskTitle` 隐藏任务名；每张卡的锚点回链保留，归属由结构 + 锚点表达。thread 内除末卡外沿用 `grouped-next` 紧凑间距。
- **自动化证据**：`ChatExperience.test.tsx` 21 测试（新增 2：连续同任务事实合成一个 thread 且任务名按钮仅 1 个、锚点按钮每卡保留；单卡/交错任务不成组）。`pnpm check` 100 文件/1031 测试、`pnpm smoke`、`pnpm review:ui --force`（既有 attention 种子含同任务连续 4 事实，桌面/390px 移动实拍竖线分组可见、几何断言通过）、`pnpm a11y:review` 0 违例。
- **仍未实现（非验收缺口）**：选中上下文条沿用「继续事情」横幅形态；托盘任务多时横向滚动、无分页/收纳；thread 只收拢当前已加载消息，不跨分页合并。

## 已落地实现（2026-11-23，DESIGN-008：work 入口语义统一与已安排事实）

- **automationActive 服务端事实**：`PegasStore.completeRun` 在结算 `run.completed` 时，若该 Task 仍挂着 active 的 existing_task Automation（且无审批/证据/澄清阻塞），payload 携带 `automationActive: true`；自动化取消后的收尾完成与无自动化的一次性 Run 不携带。这是既有 `hasActiveAutomation` 判定（Task 保持 started 的依据）首次透出到消息层，不新增查询、不改投影 lane/weight。
- **「已安排」语义**：Web `factCardHeading` 对携带该事实的完成卡渲染「已安排」+ CalendarClock（Run 已结束但事情仍会按周期推进）；事情抽屉 hero 经 `taskAutomationActive`（取该 Task 最新一条 run.completed 事实）同样显示「已安排，自动化仍会按周期推进」，不再误报「工作已完成」。旧消息无该字段时行为不变（诚实回退）。
- **🔗 单一语义**：对话流中所有「去事情」入口统一为 meta 行 14px Link2 icon（`.message-work-entry`，22px 槽、hover title + aria-label）——say 正文下的大蓝「查看工作详情」链接与 work 卡内的描边按钮全部移除；用户消息派生入口（单事情/多事情菜单）从页内锚点跳转改为打开事情详情抽屉（review.ready 仍进审查抽屉）。凡 🔗 目的地都是抽屉。
- **锚点图标区分**：卡片右上「回到发起消息」从 Link2 改为 ArrowUpToLine（向上回溯语义），页内跳转只剩这一个入口；🔗 只表示离开当前位置去事情。
- **卡片排版收敛**：`.fact-card` 行高 1.78（错误继承聊天正文）→ 1.55（DESIGN.md card-body 契约）；`.message-markdown strong/b` 浏览器默认 700 → 500（全站字重契约）。
- **自动化证据**：`test/run-automations.test.ts` +2（automationActive 只在 active automation 存在时携带、取消后与一次性 Run 不携带）；`web/src/sealed/types.test.ts` +2（事实只读 run.completed、最新完成事实优先）；`ChatExperience.test.tsx` +2（已安排卡 + say/卡 meta icon 开抽屉 + 抽屉 hero 已安排；普通完成保持已完成）+3 既有用例改为抽屉目的地；`App.test.tsx` 锚点往返用例改为 🔗 开抽屉；`test/sealed-ui-work-entry.test.ts` 6 测试固化 CSS/DOM 合同（icon 槽规格、meta 常显、1.55 行高、500 字重、旧链接/按钮不回归、锚点图标区分）。

## 已落地实现（2026-11-23，EXEC-005 收尾：say 流式输出）

- **流式投影（服务端权威）**：conversation Run 执行期间，Worker 把 DSH `text` 增量累积为完整正文，经 `PegasStore.streamSayFromRun` 写入同一条 `agent.message` 事实（dedupe/coalesce `run-say:<runId>`）。文本单调增长（只追加、拒绝回退），草稿 payload 携带 `streaming:true`；最终结算复用同一 dedupe 键去掉该标记，气泡原位定格、不重复。写路径校验 owning Worker + running Run + conversation Task，失败不阻断 Run 结算。
- **完成事实去重**：conversation Task 的 `run.completed` 保留为权威事实但 payload 不再携带正文，投影 `work/silent`（与 automation 完成卡同规则）；decide 类结算事实（审批/澄清/证据）不受影响仍可见。旧客户端把无文本完成事实过滤为空，不刷屏。
- **升级标记防泄漏**：`conversationProgressText` 在流式路径上从 `PEGAS_SUGGEST_TASK_BEGIN` 起截断，并对尾部部分标记前缀保守持有，标记段永不作为正文流出；suggest_task 升级与幂等语义不变。零确认合同不变：`ConversationExecutor` 只放行 `message` 增量，acknowledgement/activity 等过程事件仍被抑制。
- **中断诚实**：Worker 崩溃/Run 失败时已流出的部分正文保留（`streaming:true` 草稿原样可见），`run.failed` 照常投影为可见事实，不伪造完成。
- **Web 渲染**：`isStreamingSayMessage` 只读服务端 `streaming` 事实；草稿气泡尾部渲染脉冲光标（`.say-stream-caret`，`role=status` 「正在输入」，prefers-reduced-motion 全局降级），结算后光标消失。读取沿用既有 5s snapshot 轮询 + coalesce 投影，无 SSE/WebSocket、无 schema 变更。
- **自动化证据**：`test/chat-lane-stream.test.ts` 6 测试（增量原位增长/单气泡定格/silent 完成卡、崩溃保留部分正文 + 失败可见、标记段不流出 + 升级闭环、标记保守截断纯函数、acknowledgement 仍抑制、runtime 回收 + session resume）；`web/src/sealed/types.test.ts` +1（streaming 只认 agent.message 服务端事实）；`ChatExperience.test.tsx` +1（草稿光标 → 轮询结算无重复气泡）；`test/chat-lane.test.ts`/`test/conversation-projection.test.ts` 既有断言按新合同改写。
- **仍未实现（CONV-006 剩余缺口）**：work 卡内嵌 criteria 摘要；「待你处理」计数与聊天内就地解决的即时联动（仍以整页快照刷新为准）。token 级推送为非目标（粒度=DSH text 事件）。
