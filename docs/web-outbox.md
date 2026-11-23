# Web Outbox

> Feature：`NOTIFY-003`
>
> 状态：Usable
>
> 更新日期：2026-11-22

## 用户结果

用户可以从左侧展开的 Pegas 导航在 `Channels` 与 `Outbox` 之间切换。Outbox 聚合需要关注的结果、问题和阻塞，展示未读数量、消息详情、投递状态和来源 Channel；用户打开消息后，服务端记录产品已读状态，并可从详情直接打开来源 Channel 的工作区。

左侧 rail 的显式收缩合同不变：收缩后只保留展开按钮，Channels、Outbox、Pegas 身份、设置和插件入口全部隐藏。

## 验收条件

1. 展开 rail 中 `Channels` 与 `Outbox` 是同级页面导航，当前入口有明确选中状态和数量。
2. Outbox 列表与详情来自服务端持久消息，不在 Web 复制事实来源；刷新和直接 URL 访问可恢复当前消息。
3. 打开未读消息调用所有者范围内的已读 API；重复调用幂等，其他用户不能读取或修改该消息。
4. 产品已读状态 `readAt` 与外部投递状态 `pending`、`sending`、`sent`、`failed` 分离；查看消息不会伪造投递成功。
5. 消息详情显示来源 Channel，并能打开该 Channel 的现有右侧工作区。
6. 空列表、长文案、窄屏和移动布局仍可阅读，不产生横向越线或不可达控件。
7. 数据库迁移、存储、API 和 Web 交互均有自动化回归，`pnpm check` 与 `pnpm smoke` 通过。

## 数据、权限与接口

- `outbox_messages.read_at` 是产品已读时间；数据库 schema 版本为 12。
- `POST /v1/outbox/:messageId/read` 要求 `userId`，只更新属于该用户的消息，并返回更新后的消息。
- `status` 继续只描述通知 Dispatcher 的外部投递状态；它不随 Web 阅读动作变化。
- Web URL 使用 `?view=outbox&outbox=<messageId>` 保存当前入口和选择，不把消息正文写入浏览器存储。
- Web 只使用既有 Channel/Run/Outbox API，不从消息文本推断任务状态、Worker 能力或投递结果。

## 非目标

- 本 Feature 不新增审批决策、批量归档、删除、静默时段或通知优先级操作。
- 不改变哪些领域事件应该进入 Outbox；该策略仍由 Control Plane 和 Notification 领域负责。
- 不把普通 progress 复制到 Outbox，也不把外部投递回执当成用户阅读证据。
- 不实现全文搜索或分页；消息规模增长后的游标与虚拟列表属于后续加固。

## 与 GOAL-001 的后续边界

当前 `NOTIFY-003` 只提供持久消息的 Attention 列表、详情、已读和来源 Channel 跳转，不包含 Goal Contract、EvidenceRef、Review Pack、媒体附件预览或完成证据门禁。这些能力属于 Planned 的 `GOAL-001`，不能从现有 Outbox 文本消息推断已经实现。

后续扩展遵守以下产品边界：

- Outbox 是用户判断与验收的入口，Task 交付默认展示按 success criteria 组织的 Review Pack，而不是代码、工具调用和处理日志；
- 图片、视频、UI 和排版变化直接预览绑定最终 Artifact revision 的截图、关键帧或页面渲染；其他 Task 展示与目标匹配的外部确认、测试、数据校验、指标或来源 evidence；
- 多份 evidence 按 criterion 聚合去重，一份 Task 结果默认形成一份 Review Pack，不为每个过程事件制造通知；
- 完整 Artifact、来源 Channel 和 Execution Trace 通过按需入口下钻，Web 不复制服务端事实，也不从消息正文判断完成；
- 产品已读、通知投递、用户接受和 evidence 有效性分别保存，任何一项都不能推断其他项；
- evidence 预览继承用户、Task、Artifact 和敏感信息权限；服务端在 dispatch 时按接收者、渠道可信度和 sensitivity 生成渠道专属投影。站外渠道只提供脱敏摘要或认证短期引用，不嵌入无法在撤权后收回的 evidence 内容。

权威产品与数据合同见 `docs/goal-contract-and-evidence.md`。GOAL-001 实现时需要在独立 Feature worktree 中扩展存储、API、Web 和自动化证据，并保持 `NOTIFY-003` 的已读/投递语义兼容。

## 失败与恢复

- 快照加载失败沿用全局连接错误；已有消息不会被客户端删除或重写。
- 已读请求失败时保留未读视觉状态并显示可恢复错误；下一次打开仍可重试。
- 数据库迁移只新增可空列和索引，旧行默认未读；回滚应用代码时该列可安全保留。
- 回滚本 Feature 时移除 Web 入口和已读 API 即可；通知投递状态与已有 Outbox 数据无需回写。

## 投递策略（NOTIFY-005，2026-11-21）

服务端 Outbox 投递在既有指数退避重试之上增加三条策略，全部权威保存在服务端（schema v30）：

- **静默时段**：`GET/PUT /v1/settings/notifications?userId=` 按用户维护 `quietStart`/`quietEnd`（HH:MM，须成对设置或清除）与 `utcOffsetMinutes`（-840..840），写入带 `expectedRevision` 乐观并发（冲突 409 `notification_preferences_conflict`）。Dispatcher 领取消息时按用户本地时间判断静默窗口（支持跨午夜），窗口内的 pending 消息不投递，`next_attempt_at` 顺延到窗口结束；已 sending 的过期 lease 恢复不受静默影响。窗口按用户隔离，不影响其他用户。
- **待发送合并**：`POST /v1/outbox` 可选 `coalesceKey`。同一用户、同一 channel、同一 key 且尚未被领取（pending）的消息吸收新消息：保留原消息 id 与 dedupeKey（投递幂等键不变），payload 更新为最新内容并累加 `coalescedCount`；新行落为 `merged` 状态并记录 `mergedIntoId`，永不投递。sending/sent/failed/unknown 的消息不被合并；dedupeKey 重放仍幂等。
- **未知投递处理**：Webhook 请求传输层失败（连接失败、超时、中断——请求可能已送达）抛 `DeliveryOutcomeUnknownError`，Dispatcher 将消息置为 `unknown`，不自动重试；明确的非 2xx HTTP 响应仍按既有退避重试至 `failed`。`failed`/`unknown` 消息只能由所有者通过 `POST /v1/outbox/:id/resolve`（`commandId`/`resolution: sent|failed`/`note`，bearer 鉴权）人工核对：命令幂等重放、异 payload 409 `outbox_resolution_conflict`、二次核对 409、跨 owner 404。核对记录 `outbox_resolutions` 不可变（UPDATE/DELETE 触发器拒绝），保留 `previousStatus`；数据库触发器保证终态消息只能经核对记录变更，`sent`/`merged` 不可回退。

回滚：v30 重建 `outbox_messages` 以扩展 status CHECK（新增 `merged`），旧行原样迁移，索引与 channel 搜索触发器原定义重建；回滚应用代码时新列/新表可安全保留，`merged`/`unknown` 行对旧代码表现为不可领取状态，不会重复投递。

## 自动化证据

- `test/sqlite-store.test.ts`：产品已读与投递状态分离、幂等和用户隔离、schema 12 迁移。
- `test/control-plane.test.ts`：已读 API 所有者成功与跨用户拒绝。
- `web/src/App.test.tsx`：左侧入口、未读数量、自动已读、投递状态不变和来源 Channel 跳转。

## Web 呈现 refinement（DESIGN-002，2026-11-22）

- 「待你处理」的短标题、预览、语义状态、筛选计数、本地搜索和安静操作只改变 Web 交互适配，不改变 NOTIFY-003 的消息生成、所有者隔离、已读 API、投递状态或人工核对合同。
- 本地搜索只过滤当前已加载快照中的内容与来源，不是服务端全文搜索；未加载消息不会被声称已搜索。筛选/搜索空态不删除或改写消息。
- 已读仍不等于已解决：已读未解决事项保留在列表中；阅读不改变 Task/Run/Approval、用户接受或外部投递结果。完整正文与核对操作仍在既有详情中。
- 证据与边界见 `docs/sealed-ui-rebuild.md` §17 和 `docs/feature-map.md` DESIGN-002「待处理收件箱 refinement」。回滚 Web refinement 不需要数据库迁移或 Outbox 数据回写。

## 按事情聚合与三段分区（DESIGN-007，2026-11-23）

「待你处理」从一条消息一行改为一件事情一行的混合式收件箱。分类轴从「事件类型/重要性」换成「现在该谁动」，消除 `review.ready` 在「需要确认」与「重要结果」之间的语义骑墙。全部改动位于 Web 交互适配层；NOTIFY-003 的消息生成、所有者隔离、逐条已读 API、投递状态与人工核对合同不变。

### 分区与语义映射

列表固定三个分区，按此顺序渲染；判定只依据服务端结构化 payload `type` 与投递状态，不从自由文本推断：

1. **待你处理**（球在用户手里，永不折叠进聚合组、不参与分页）：
   - 确认 ← `approval.required` / `approval.requested`（沿用既有 `approval.resolved` 消除规则）；
   - 回答 ← `input.required` / `input.requested` / `goal.clarification_required` / `goal.evidence_required` / `run.blocked` / `run.waiting`；
   - 验收 ← `review.ready`；
   - 核对 ← `action.outcome_unknown` / `action.reconciliation_required`，以及投递 `failed`/`unknown` 待人工核对的消息（沿用 `needsOutboxResolution`）。
     行内以动词小标签（确认/回答/验收/核对）区分动作，操作按钮沿用既有上下文动作（查看内容/去回答/审查交付/去核对/核对投递）。同一事情的多条待办各自成行，不合并——每个待办是一个独立决定。
2. **失败**（独立强信号区，不参与分页）：`run.failed` / `action.failed`。同一事情（`taskId`）的失败合并为一行：标题为事情名，摘要取最新一条，右侧计数胶囊「N 条 · M 未读」，可展开组内时间线（倒序、最新在上）逐条打开详情。无 `taskId` 的失败各自成行。
3. **事情动态**（例行结果，参与分页）：`run.completed`。按事情聚合为一行，规则同上；组内全部已读时整行降低视觉权重。无 `taskId` 的结果各自成行。

分区内与组间排序统一按组内最新消息 `createdAt` 倒序；组内时间线同样倒序。`update` 类消息维持不进入收件箱。

### 聚合与展开

- 聚合键：`taskId`；缺失时退化为单消息行，不得从 payload 文本猜测归属。
- 聚合行显示：事情标题（来源 Channel 标题，缺失时「Pegas」）、最新一条的 `attentionSummary` 摘要前缀「最新：」、计数胶囊「N 条」或「N 条 · M 未读」、最新时间。「最新：…」摘要行是可点按钮：点击打开最新一条的既有详情抽屉并按既有语义标记该条已读（2026-11-23 修复：此前摘要为纯文本，组内未读的最新一条无入口，导致「N 条只见 N-1 条」「点开未读不减」）。
- 展开态在行内面板展示最近 3 条组内通知（倒序、**含最新一条**，与摘要行入口指向同一条），每条可打开既有详情抽屉；超过 3 条显示「查看全部 N 条」，点击展开其余条目（仍在行内，不新增页面），展开后时间线条数等于计数胶囊的 N。展开/收起不触发任何已读请求。
- 已读语义维持逐条：只有打开某条消息的详情才调用该条的已读 API；展开组、翻页、筛选都不批量标已读。聚合行未读数由组内成员派生。

### 筛选、计数与搜索

- 筛选 chips 改为：全部 / 待你处理 / 失败 / 事情动态。计数口径：待你处理与失败按消息条数（该区不折叠语义），事情动态按事情数（聚合行数），全部 = 三者之和；页头副标题双口径展示「X 件事情 · Y 条通知 · Z 条未读」。
- 本地搜索命中组内任一条通知即保留整个聚合行（含未命中成员，计数不虚减）；仍只过滤已加载快照，不声称服务端全文检索。
- 筛选/搜索空态与真空状态文案区分沿用既有规则。

### 分页（第一阶段：Web 客户端分页）

- 分页只作用于「事情动态」区，按聚合行（事情）分页，每页 20 行；待你处理与失败区永远全量显示。
- 分页条显示「第 a–b 件事情，共 N 件」与页码/上一页/下一页；切换筛选或搜索词回到第 1 页；数据刷新导致当前页超界时收敛到最后一页，不出现空页假象。
- 本阶段是对已加载快照的客户端投影，不新增服务端合同；消息规模超出快照承载能力后的服务端按事情聚合游标接口属 NOTIFY-003 后续（见下）。

### 自动化关联（第二阶段，依赖服务端权威字段）

- `existing_task` 型自动化：N 轮通知天然同一 `taskId`，聚合与「打开事情」落点无需改动。
- `new_task` 型自动化：每轮新建事情，仅按 `taskId` 聚合会退化为一轮一行。目标聚合键为「自动化 ID（若有）否则 taskId」，行级入口为「打开自动化」（复用封板自动化页），轮次条目次级入口打开该轮事情。
- 阻塞缺口：当前 `new_task` 创建的事情只有路由 reason 自由文本携带 automation id，Task/Outbox 无结构化关联字段；按「不从自由文本推断」规则，本阶段不实现 new_task 聚合，先由 SCHEDULE-001/NOTIFY-003 补充权威 `automationId` 投影字段后再接入。在字段落地前，new_task 型自动化的通知按各自事情成行（现状），不得声称已按自动化聚合。

### 非目标

- 不新增归档、稍后处理、批量已读、snooze、通知优先级或源头静默（DONT_NOTIFY 类机制属 SCHEDULE-001/GOAL-001 后续）。
- 不改变哪些事件进入 Outbox；不新增服务端分页/搜索合同（NOTIFY-003 后续缺口不变）。
- 不按「自动化/手动」出身分类；自动化差异只影响第二阶段的聚合键与落点。

### 失败与恢复

- 已读请求失败保留该条未读视觉状态与可恢复错误，聚合行未读数随之保持；不因组内单条失败伪造整组已读。
- 展开状态、筛选与页码是本地视图状态，刷新后回到默认（第 1 页、全部收起）；详情 URL 恢复与焦点恢复沿用既有合同。
- 回滚本 Feature 即恢复一条消息一行的收件箱；无数据库迁移、无服务端数据回写。

### 验收条件

1. `review.ready` 出现在「待你处理」区并带「验收」标签与审查交付动作；`run.completed` 只出现在「事情动态」；`action.outcome_unknown`/`action.reconciliation_required` 与投递 failed/unknown 带「核对」标签，不再归入回答。
2. 同一事情的多条 `run.completed`/失败各自合并为一行，计数与未读数正确，组间与组内均按最新时间倒序；无 `taskId` 消息不合并。
3. 同一事情多条待办（确认/回答/验收/核对）各自成行且置顶，不被聚合或分页隐藏。
4. 展开组显示最近 3 条（含最新）+ 「查看全部 N 条」，「查看全部」后时间线条数 = 胶囊计数 N；摘要行「最新：…」可点，打开最新一条详情并只标记该条已读，聚合行与页头未读数随之减少；展开/收起/翻页/筛选不发出已读请求。
5. 筛选计数口径（待办/失败按条、动态按事情）与副标题双口径一致；本地搜索命中组内任一条保留整组。
6. 事情动态区分页每页 20 行，页码边界、筛选/搜索重置与数据收缩收敛正确；置顶两区不受分页影响。
7. 桌面与 390px 移动端无横向溢出，粗指针目标 ≥44px，light/warm/dark 语义 token，axe 0 严重违例；详情焦点恢复沿用既有回归。
8. 自动化回归覆盖三分类映射、聚合、排序、计数、分页与已读边界；`pnpm check` 与 `pnpm smoke` 通过。
