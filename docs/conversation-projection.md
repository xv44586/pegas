# Conversation Projection

> Feature：`CONV-006`（投影合同）、`CONV-007`（任务托盘与锚点导航）
>
> 状态：CONV-006 Partial（服务端派生层 + 投影 API + Web 三声道渲染 + anchor 双向导航已落地；say 流式未实现）；CONV-007 Partial（任务托盘 + 选中指向已落地；thread 分组未实现）
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

## 已落地实现（2026-11-23，CONV-007：任务托盘与选中指向）

- **托盘只读投影**：`web/src/sealed/MainPages.tsx` 在输入器上方渲染 `.task-tray`（`role=group` 「进行中的事情」），列出当前 owner 非终态任务（completed/cancelled 过滤），按 `latestActivityAt` 降序；每项为 `aria-pressed` 胶囊按钮，状态点区分 active（运行/排队，脉冲）、attention（有 `statusReason`，caution 色）、idle，附 `statusLabel`。空托盘不渲染、不占布局。
- **选中态与控制权**：选中是客户端本地偏好（`App.tsx` `onSelectTask` 设置 continuationTaskId，不落库）；`steerTarget` 严格跟随选中任务而非最活跃任务；未选中时输入走 Router 默认归属。选中项自动清除仅在 cancelled 时触发（completed 保留选中以保护「继续事情」resume 流程）。
- **插话/排队指向选中**：`canSteer` 要求选中任务的最新 run 处于 running/queued，走既有 `sendSteerMessage`（`payload.intent:'steer'`）；`canQueue` 要求显式选中 + 非终态 + 活跃 run，排队消息在任务完成后经既有 `sendMessage` 发出。不新增服务端意图。
- **几何修复**：托盘使 composer 变高，`.composer-model-picker` 桌面/移动 `max-block-size` 扣减量各 +50px，保证向上弹出不越 viewport（review:ui 几何断言覆盖）。
- **review:ui 种子确定性**：`scripts/capture-ui-review.mjs` 改用 dsh fixture executor（`PEGAS_ROUTER=rules`、collect window 0）；fixture 对托盘任务在 run 内用自身 claim token 走真实 `POST /v1/runs/:id/goal-proposals` 提交 Goal Contract，run 完成后服务端依合同停在 `awaiting_evidence`，托盘实拍稳定可见等待中任务；连续 4 次 `--force` 全绿。
- **自动化证据**：`ChatExperience.test.tsx` 19 测试（CONV-007 新增 4：托盘列出/隐藏终态/切换选中、输入跟随选中而非最活跃、steer/queue 指向选中、空托盘不占布局与终态自动清除；既有 steer/queue 3 用例改为经托盘选中）；`App.test.tsx` 2 用例断言改 `findAllByText` 适配托盘标题重复；`pnpm check` 99 文件/1013 测试、`pnpm smoke`、`pnpm a11y:review` 0 违例。
- **仍未实现（CONV-007 剩余缺口）**：同一任务连续事实的 thread 分组渲染（缩进/竖线/嵌套）；选中上下文条沿用「继续事情」横幅形态；托盘任务多时横向滚动、无分页/收纳。
