# Pegas 封板 UI 全量重建合同

> Feature: DESIGN-002
> 状态：Partial
> 日期：2026-11-22

## 1. 决策与权威顺序

这次不是旧 Web 的换肤，而是完整重建。旧 `App.tsx` 组件树、DS Bot 布局、旧 CSS 选择器和旧弹层结构都不是实现模板；只有既有 API、领域类型和已验证行为可以复用。

封板过程产生的 12 张本地参考图是视觉输入。当早期图与后期图冲突时，以生成时间更晚的图为准，最终四联图优先级最高。正式产品文档只记录 Pegas 自有需求，不把生成图或外部项目当成架构事实来源。

## 2. 产品结构

桌面端采用三段式工作台：左侧固定主导航，中间为当前页面，右侧按需打开工作详情或预览抽屉。默认主题为白底；顶栏只提供明暗快速切换，跟随系统、明亮、暖纸和深色的完整选择位于设置中的独立“外观”分类。

主导航固定包含：对话、所有事情、待你处理、自动化、记忆，以及位于底部的设置。全局搜索由顶栏入口或 `⌘K` / `Ctrl+K` 打开。移动端把主导航收敛为底部导航或可展开菜单，详情抽屉变为全高覆盖层；信息层级和操作名称不能改变。

## 3. 页面矩阵

### 3.1 对话

- 顶栏显示 Pegas 身份、当前上下文、搜索入口和明暗快速切换；切换直接生效，不打开主题菜单。
- 消息区保持宽松的编辑式排版，不用密集 dashboard 卡片承载普通对话。
- 输入器固定在内容底部，支持文字、语音、附件入口和发送；发送失败保留草稿。
- Task、Run 和传输状态作为元数据展示，不伪装为 Pegas 回复。
- 点击工作事件、附件或任务状态，在右侧打开对应详情。

### 3.2 所有事情

- 提供标题、状态筛选、搜索和按最近活动排序。
- 每个事情行展示名称、简短目标、状态、最近活动和执行上下文；整行可打开详情。
- 服务端仍是 Task 状态事实来源，客户端不自行迁移状态。

### 3.3 待你处理

- 聚合需要确认、需要补充信息、执行失败和重要结果。
- 列表使用语义化列表与可命名条目；每项先显示状态文字和短标题，再显示可选一行预览、未读/已读、来源事情、相对时间及必要的投递核对提示。标题优先取服务端 `title`/`summary`，否则只从正文安全派生首句/首行；完整 Markdown 留在详情中。
- 每行只有一个安静的上下文操作（查看原因、查看内容、去回答、审查交付、去核对、核对投递或打开事情）；标题也可打开同一详情。相同可见操作在辅助技术中携带事项标题以区分目标，关闭详情后焦点返回触发控件。
- 筛选显示实时计数并保持单行横向滚动；本地搜索只过滤当前已加载的内容与来源，不伪装服务端全文搜索。真空状态与筛选/搜索空状态分开表达。
- Outbox 已读状态与任务完成、用户接受和外部投递状态分离；已读但未解决的事项继续保留，阅读不改变任务或投递状态。
- 桌面与 390px 移动端使用同一信息顺序；普通列表用分隔线而非嵌套卡片，粗指针下标题、筛选和操作目标至少 44px。

### 3.4 自动化与记忆

- 自动化展示名称、意图、触发条件、目标、下次/最近触发和启停状态；已接入 SCHEDULE-001 服务端合同，支持新建（固定间隔/一次性）、编辑、暂停、恢复与两步确认结束。Invocation 触发历史展示仍是缺口。
- 记忆按全部、全局、Worker 和事情范围展示内容、类别、来源、最近使用，并提供编辑与两步确认删除；已接入 MEMORY-001 服务端合同，编辑保留服务端来源，浏览器不持久化记忆数据。

### 3.5 设置

设置拥有独立页面结构，不与工作详情抽屉混用。分类顺序为：Pegas、外观、模型服务、事情归类、语音与输入、能力与连接、记忆、隐私、通知、模型用量、数据与恢复、关于。

关键边界：

- **模型服务**只管理 Provider 连接、凭证状态、模型目录、连接测试，以及“当前被哪些设置使用”的只读引用。
- **外观**管理跟随系统、明亮、暖纸和深色主题；它是当前设备的即时本地偏好，不进入服务端设置保存栏。
- **事情归类**只管理 Router 是否启用、Router 连接与 Router 模型；Router 不判断工具能力、不代替 Executor 回复。
- **Pegas**管理执行模型、隔离运行环境、行为、系统提示词/规则和自主程度。DSH 使用 Pegas 专属 profile，不共用用户本机默认 profile。若用户选择 DeepSeek Flash，展示的模型名为 `deepseek-v4.1-flash`，不写成 DeepSeek V3.2。
- **模型用量**展示时间范围、总 token、缓存、延迟、成本来源及按模型/事情/Run 的明细；无法计算成本时明确显示“未提供价格”。

设置页的分类内容独立滚动，底部保存操作位于同一父级的独立布局行，不覆盖或透出表单内容。`select` 保留原生语义，但与 input、textarea 共用表面、边界、圆角、箭头和焦点语言；测试输入使用弹性内容列，短操作按钮保持单行和稳定点击宽度。

### 3.6 首次设置

首次设置由四个必要步骤组成：欢迎与边界、模型连接、Pegas 运行环境、语音与完成确认。用户可以跳过非必要项，但必须知道哪些能力尚未可用。完成页提供进入对话和继续设置两个明确出口。

## 4. 右侧详情与状态矩阵

右侧抽屉统一支持显式关闭和 Escape，关闭后焦点返回触发元素。当前服务端可验证地覆盖已完成、进行中、等待和失败；文件、图片、视频、网页、运行时、规则、需要确认、Worker 未完成、转交 Pegas 与并行 Subagent 保留封板信息结构，但只有收到对应结构化服务端事实时才允许展示为真实状态。

- 详情展示所选 Channel 的服务端时间线和全部 Run 尝试；时间线获取失败就地提示，不回退为全局会话。完成态另展示服务端结果、可用时的用量和继续追问；服务端未返回 Artifact 时不生成示例产物。
- 运行态展示当前 Run 与最近活动；停止事情必须二次确认，暂停与纠正 API 未提供时操作明确禁用。
- 确认态展示风险与将执行的具体动作；内容由真实 Executor 基于工具与权限生成。
- 失败态展示失败位置、可读错误、已完成步骤和重试。
- 协作态在服务端提供结构化父任务、关系和分支字段后展示来源、转交原因、并行分支和结果汇总；客户端不得根据 `statusReason` 或错误字符串猜测。
- 内容预览只展示服务端返回的标题、类型、来源与安全 URL；没有内容时显示诚实占位，不生成文件名、尺寸或下载动作。
- 运行时详情只展示 Run 中实际返回的 Executor、Worker profile、工作区、模型和 session 恢复引用；缺失字段统一显示“服务端未提供”。

## 5. 视觉系统

- 默认画布为纯白/近白，左导航和次级表面只用轻微中性色区分。
- 品牌蓝用于主操作、选中态、进度和 Pegas 标记，不作为大面积装饰背景。
- 字号走 DESIGN-004 八档 token（10/11/12/13/14/16/20/26px）：页级大标题 26px、区块标题 20px、抽屉/浮层标题 16px、章节标题 14px、卡片标题 13px；中文正文 14px、聊天正文与文本输入 16px、卡片正文与按钮 13px、次级标签 12px。字重仅 400（正文）与 500（标题/标签/按钮）；章节标题必须大于卡片标题，卡片正文与按钮文本比邻近外部正文小 1px。自动化门禁见 `test/sealed-ui-typography.test.ts`。
- 标题 `text-wrap: balance` 避免末行孤词；26px 大标题行高 1.2、字距 -0.03em，20px 区块标题行高 1.25、字距 -0.02em。不使用眉题/eyebrow、计数药丸、序号徽章等装饰标签；状态一律纯文本。
- 圆角分三级：控件 10px、卡片 14px、浮层 18px；胶囊仅用于状态与切换。
- 阴影只用于浮层、输入器和抽屉，普通列表用间距与细边界建立层级。
- 动效时长 140–220ms，使用 opacity/transform；尊重 `prefers-reduced-motion`。
- 所有颜色通过语义 token 表达。暖色与深色主题不能通过页面级硬编码覆盖。

## 6. 响应式与可访问性

- 使用动态视口单位处理移动浏览器高度，不用固定 `100vh` 截断输入器。
- 交互元素优先使用原生 button、a、input、select 和 dialog 语义。
- 键盘焦点使用 `:focus-visible`，不移除可见焦点环。
- 桌面最小验证宽度为 1024px；移动验证 390px。触控目标至少 44×44px。
- 抽屉、菜单、外观选择器、全局搜索和设置导航均需支持键盘与屏幕阅读器名称。

## 7. 技术验收与回滚

1. 新入口不导入旧 `styles.css` 或 `workspace-theme.css`，也不依赖旧页面类名。
2. 页面与状态由可组合组件和显式 view model 构成；生产数据只来自现有 API 或新增的服务端契约。
3. 每个主页面、设置分类、主题、抽屉状态和移动布局至少有一条自动化证据。
4. 参考图逐页截图复核，重点检查导航几何、留白、标题层级、输入器、详情抽屉、设置信息架构、主题和错误状态。
5. 完成前运行 `pnpm check`、`pnpm smoke` 与 UI review。
6. 若验证失败，回滚 DESIGN-002 Feature commit 即恢复旧构建；本 Feature 不迁移或重写服务端数据。

## 8. 交付证据与剩余缺口（2026-11-20）

- 新组件树位于 `web/src/sealed/`，唯一视觉入口为 `web/src/sealed-ui.css`；旧 DS Bot 组件和两份旧 CSS 已删除。
- UI review 使用隔离的模型目录夹具，不依赖开发机 DSH，并自动捕获 57 张截图：主页面、12 个设置分类、四步首次设置、白/暖/深色/跟随系统主题、桌面与移动外观/语音/改写、深色与 390px 移动端的事情归类、对话输入聚焦、多行和模型选择状态，以及四种 Run 状态和四类预览的视觉。
- 设置视觉回归会检查滚动内容与底部操作栏的相邻关系、原生选择器的统一外观，以及测试输入和按钮的最小几何约束；粗指针设备的顶栏按钮和所有主要操作至少为 44×44px。对话输入采用 Codex 式上下两层结构，回归会检查焦点只落在完整输入面、文本框不产生内部矩形焦点框、模型身份和可选列表来自服务端当前接入点、选择不离开对话、垂直自适应、选择面板不越界和发送目标尺寸。
- 异步交互回归会拒绝过期的 Channel 时间线、配置读取、模型服务探测、语音测试和输入改写测试结果，轮询更新不得抢走抽屉内焦点；继续追问时必须同步清理详情深链接，避免刷新后恢复错误界面。重连只刷新失败的数据源，不能覆盖设置页未保存草稿；保存期间锁定表单，避免成功响应覆盖用户后来输入的内容。替换访问令牌必须在服务端验证成功后才解除访问门，不能在请求仍未完成时暴露旧数据。
- 行为回归覆盖首次设置自动出现、模态语义与焦点约束、完整会话历史、草稿跨页面保留、并发快照防倒退、慢用量接口与核心快照解耦、Channel 级时间线及打开后的周期刷新、搜索入口的定向时间线、Channel 深链接恢复、无 Task 待处理消息深链、旧 `tasks` 地址兼容、设置分类深链恢复、配置重连保留未保存草稿、模型服务快捷入口 URL 同步、设置冲突错误公告、全部 Run 尝试与失败诊断、待处理通知锁定原始 Run、完成 Channel 中旧失败 Run 的独立诊断、重试后选中新建后继 Run、运行与完成 Channel 内继续追问、停止二次确认、已归档 Channel 的权威状态、失败重试反馈、单 Run 用量与刷新、缺少总量时由输入/输出 Token 推导、完全未回报用量显示未知、离线状态和执行模型目录可用性、用量与执行模型目录失败显式反馈、等待与排队状态分类、失败事情可恢复、已读但未解决的结构化待处理保留、待处理项按时间倒序、已读事项不重复写入及已读失败恢复、待处理详情焦点恢复、URL 详情恢复、浏览器前进后退、跨浏览器中文输入法组合态、语音配置前置检查、听写期间禁止发送、设置取消恢复、抽屉与全局搜索只允许一个顶层模态、Provider 切换时的兼容模型重置、Pegas 专属 profile 恢复，以及自定义 Provider 实际配置模型探测与无模型时安全禁用。事情列表显示 Worker 身份与执行模型，并支持搜索 Run 结果；普通空列表不误报服务端能力不可用。模型服务的输入改写引用必须反映真实模式并跳转到语音与输入。全局用量必须保留事情/Run 归属；无 Artifact 事实时不显示产物标记；浏览器历史关闭抽屉后焦点返回原触发控件。
- `pnpm check`、`pnpm smoke` 与 `pnpm review:ui -- --force` 是合入门禁。
- Feature 保持 `Partial`：Artifact、规则持久化、通知偏好、恢复操作与结构化 Worker/Subagent 协作需要各自的服务端 Feature 先提供事实来源；当前页面以禁用控件或空状态呈现这些缺口。

## 9. MVP 前端修复（2026-11-21）

- 所有事情默认“全部”，筛选无结果与真正空列表使用不同空状态文案；移动端保留事情搜索，过滤触控 44px。
- 全局搜索支持 ArrowUp/ArrowDown 与可见关闭按钮；模态打开时主壳层 inert；提供 skip link；页面标题随导航更新。
- 待你处理新增“重要结果”筛选，图标按 result/failed/approval/input 语义着色；长消息、长结果与长时间线条目按需展开，用户消息使用“展开完整消息”。
- Provider 列表在未执行连接测试前显示“已配置”，测试成功后才显示“连接正常 · N ms”。
- 补齐 `--text`、`--text-muted`、`--text-soft`、`--surface-subtle`、`--accent-contrast`、`--accent-ink` 语义 token；浅色/暖色/深色在对话、事情、待处理、设置四页 axe 对比度 0 违例。
- 证据：`pnpm check`（49 文件 / 473 测试）、`pnpm smoke`、`pnpm review:ui -- --force`（57 张截图）与 Chromium 三主题对比度扫描；详见 `docs/feature-map.md` DESIGN-002 MVP 小节。
- 仍缺：搜索接入服务端（CHANNEL-003），以及 Artifact、规则、通知偏好、恢复与协作占位启用。

## 10. 自动化/记忆接入服务端（2026-11-21）

- 自动化页从诚实空状态升级为真实读写：列表/指标（已启用、已暂停、已结束）、新建与编辑表单（名称、意图、固定间隔分钟或一次性执行时间、new_task/existing_task 目标）、暂停/恢复、两步确认结束；命令携带稳定 commandId 与乐观 revision，操作后从服务端重新拉取。
- 记忆页支持全部/全局/Worker/事情过滤，展示类别、作用域、来源与更新时间/最近使用；添加表单覆盖六类别与三作用域（Worker/事情需选择关联事情），编辑保留服务端来源，删除两步确认并携带 expectedRevision；列表有界分页（最多 3 页 × 200 条，超出显式提示）。
- 设置“记忆”分类显示真实条数（全局 N 条 · Worker/事情 N 条）并提供“管理记忆”跳转到记忆页。
- 状态色对比度修正：`--positive:#22754f`、`--caution:#965e0e`、暖色 `--accent-ink:#2f49de`，由 `test/sealed-ui-contrast.test.ts` 固化为回归门禁。
- 证据：`pnpm check`（52 文件 / 499 测试）、`pnpm smoke`、`pnpm review:ui -- --force`（57 张截图，自动化/记忆含真实种子数据）；真实 Control Plane 联调覆盖自动化 interval/once 创建、暂停、恢复、结束与记忆创建、编辑、删除；axe 三主题 × 两页及 390px 移动端 0 违例。详见 `docs/feature-map.md` DESIGN-002 接入小节。
- 仍缺：Artifact、规则、通知偏好、恢复与协作占位启用（搜索与触发历史已于 §11 接入）。

## 11. 搜索/触发历史/人工核对接入（2026-11-21）

- 全局搜索接入 `GET /v1/channels/search`：200ms 防抖、过期响应丢弃、错误就地重试；空查询显示最近事情，有查询时显示「搜索结果」与命中摘要（优先输入/结果来源而非标题重复）；保留方向键导航与焦点约束。
- 自动化页每条自动化提供「触发记录」展开区：按需读取 `GET /v1/automations/:id/invocations`（limit 50），展示状态（待触发/处理中/已派发/失败）、计划时间、尝试次数与失败原因；可折叠、失败可重试。
- 待你处理页对 `action.reconciliation_required` 通知显示「去核对」，打开核对抽屉：展示动作类型、请求与已记录结果，必填核对依据（≤2000 字符），结论二选一（确认已成功/确认已失败）并说明后果；提交 `POST /v1/actions/:id/reconcile`（commandId 幂等）；已核对动作展示只读核对记录。审批抽屉内 unknown/failed Action 复用同一表单。
- 状态色修正：待处理角标改用 `--caution-badge`/`--caution-badge-ink`（深色 8.66:1），对比度回归扩展到深色主题。
- 证据：`pnpm check`（53 文件 / 518 测试）、`pnpm smoke`、`pnpm review:ui -- --force`（57 张截图）；真实 Control Plane+Worker+Scheduler（bearer 模式）联调覆盖搜索摘要、真实触发记录与两条核对路径；axe 三主题 × 搜索/触发记录/核对抽屉/待处理页及 390px 移动端 0 违例。详见 `docs/feature-map.md` DESIGN-002 对应小节。
- 已知服务端缺陷（待独立 fix，未在本变更修改）：短查询（<3 字符）snippet SQL 参数绑定顺序错误导致 400 `datatype mismatch`，UI 就地展示错误；详见 Feature Map CHANNEL-003。
- 仍缺：搜索状态/时间筛选与分页 UI，以及 Artifact、规则、通知偏好、恢复与协作占位启用。

## 12. Review Pack/证据画廊/澄清卡片接入（2026-11-21）

- 事情详情抽屉新增「目标与交付」区：并行读取 `GET /v1/tasks/:id/delivery`（单请求返回 goal+artifacts+evidence+reviewPack），展示目标修订、期望结果、非目标、Review Pack 逐条完成标准（已满足/部分满足/未满足/未验证）、剩余风险与证据画廊；无 Review Pack 时如实提示；读取失败就地报错且不遮蔽时间线。
- `review.ready` 通知在待你处理页显示「审查交付」，打开审查抽屉：结论 hero（completed/partial/failed）、完成标准（语句由当前 Goal Contract 补全）、证据画廊、剩余风险、回滚说明与「打开事情详情与审计时间线」；对话页同时显示紧凑审查卡片。
- 证据画廊缩略图与全屏预览经 `GET /v1/evidence/:id/content` 取回已存证字节：bearer 模式 fetch→blob（卸载时回收 objectURL），无 token 场景直连 URL；预览显示验证结论/敏感级/类型元数据，可「打开原始内容」，并支持「返回交付审查」回到来源抽屉（review 或 task）。
- `goal.clarification_required` 归类「需要补充」：待你处理显示「去回答」，打开澄清抽屉列出 blocking 问题；对话页在 Task `statusReason=awaiting_goal_clarification` 期间显示内联澄清卡片（解除等待后自动隐藏）。「去回答」跳转对话页、聚焦输入器并携带 taskId 发送，复用既有 continuation 链路。
- 证据：`pnpm check`（74 文件 / 657 测试，App.test.tsx 新增 7 条回归）、`pnpm smoke`、`pnpm review:ui -- --force`（57 张截图）；真实 Control Plane（bearer + store 级 Goal/Artifact/Evidence/Report seed）联调全链路；axe 三主题 × 审查/预览/澄清/事情详情/对话页 0 违例；实拍见 `output/feature-review/live-evidence-goal/`。
- 仍缺：历史 Goal/Review Pack 修订下钻、evidence 重验证入口、validity 失效事件；通知偏好、附件上传、语音直发、执行节点、Worker 覆盖与协作卡片未接入；Review Pack criterion 解释文案暂为服务端英文模板。

## 13. 剩余服务端接口接入与文案本地化（2026-11-21）

- 设置「通知」从假开关占位升级为真实免打扰时段：`GET/PUT /v1/settings/notifications`，开关 + 起止时间（24h 制、成对提交/清除）+ 设备时区（UTC±H），expectedRevision 乐观并发、409 就地报错可重读；如实说明静默期通知保留稍后投递、按类型分级开关的服务端契约尚未提供。
- 设置「能力与连接」从假连接网格升级为真实执行节点列表：`GET /v1/nodes`（名称/能力/最近心跳），运行时抽屉同步新增「已注册执行节点」；空态如实说明控制面自身仍可执行；工具授权清单契约未提供仍保留诚实横幅。
- 投递核对闭环：failed/unknown 且未核对的通知在待你处理页标记「投递失败/结果未知，待核对」并提供「核对投递」；消息抽屉展示投递状态与最近错误，核对表单二选一（确认已送达/未送达）+ 必填依据（≤2000 字），`POST /v1/outbox/:id/resolve` commandId 幂等；已核对消息展示只读「人工核对记录」，列表行同步结论。
- 事情详情新增「事情级执行设置」编辑器：`GET/PUT /v1/tasks/:id/worker-profile`，跟随全局/为这件事情指定模型（模型来自 `GET /v1/settings/agent-models` 目录）、展示生效模型/来源/版本，保存携带 expectedRevision，409 冲突提示并自动重读，归档事情只读；修复 5s 轮询重置未保存编辑的问题（同步依赖改为按值比较的稳定键，轮询对象身份变化不再触发重置）。
- 事情详情新增只读「协作记录」：`GET /v1/channels/:id/collaborations`（委派/交接/上下文注记/交回 × 等待接收/进行中/已交回/已完成/失败/已取消，请求文本、结果摘要、层级与目标事情摘要）。
- 「目标与交付」新增历史修订下钻（`GET /v1/tasks/:id/goals` + `/review-packs` 按需并行加载，当前修订标记，可折叠）与 pending 证据「验证证据」按钮（`POST /v1/evidence/:id/verify`，提交后详情轮询自动反映最新结论）。
- 对话输入器附件闭环：「添加附件」启用（隐藏 file input，≤25MB 客户端守卫，chip 可移除），发送后按返回 event 上传 `POST /v1/events/:id/attachments`；消息已发出但附件失败时分离报错不吞事实。服务端 `listEvents`/`pageChannelEvents` 投影补充 `attachment` 元数据，对话与 Channel 时间线渲染附件 chip，点击经认证附件 API fetch→blob 预览（图片/视频/文件占位），可返回工作详情。
- 语音直发模式：输入工具新增「说完直接发送」开关（aria-pressed），开启后录音结束走 `POST /v1/voice/messages`（idempotency-key、source=web、language=zh、continuation 携带 taskId）直接成为消息，不污染草稿；默认听写转草稿不变，未配置语音仍引导去设置。
- 文案本地化：Review Pack criterion 解释模板改中文（`N 条已验证证据满足这条完成标准。`/`需要至少 N 条已验证证据，目前只有 M 条。`）；echo Worker 无证据 Report 的 limitations/remainingRisks 改中文；均有测试断言。
- 类型边界整理：`RuntimeSettingsSelection` 拆为纯类型模块（原路径 re-export），web 侧 `ChannelRelation` 按服务端合同镜像，`collaboration.ts` 权限类型改 type-only import——web tsconfig 类型图不再拉入 node 模块；均为等价类型重构。
- 证据：`pnpm check`（74 文件 / 668 测试，App.test.tsx 新增 10 条、附件投影回归 1 条、文案断言若干）、`pnpm smoke`、`pnpm review:ui -- --force`（57 张截图）；真实 Control Plane + Worker 联调覆盖附件上传/投影/预览、pending 证据验证、历史修订、Worker 覆盖保存、协作卡片、投递核对、静默时段落库、节点心跳；axe 三主题 × 新视图 0 违例；实拍 15 张见 `output/feature-review/live-evidence-endpoints/`。详见 `docs/feature-map.md` DESIGN-002「剩余服务端接口接入」小节。
- 仍缺：规则与数据恢复占位（服务端契约未提供）、搜索筛选/分页 UI、validity 失效事件、`/v1/evidence?goalRevision=` 列表、协作操作入口与目标事情跳转；语音直发待真实 ASR 供应商联调；多附件/事件与附件进入模型上下文属 CONV-001 后续。

## 14. 搜索筛选分页、按修订证据列表与协作跳转收尾（2026-11-21）

- 全局搜索对话框新增筛选栏：状态 chips（全部/进行中/已结束，映射 `ended=false/true`）、「需关注」开关（`needsAttention=true`）、排序下拉（最近更新/最近创建/最近结束）与执行者下拉（汽车/相机/电脑/手机，映射 `workerIconId`）；空查询 + 仅筛选也走 `GET /v1/channels/search`，纯空态仍显示本地最近 5 条；筛选变化立即重查、文本输入 200ms 防抖、过期响应按 requestId 丢弃。
- 搜索结果超过一页（8 条）时底部出现「加载更多」：携带服务端 `nextCursor` 续页并按 id 去重追加；续页失败就地报错，「重试」回到第一页；结果区改为可滚动容器（max-height 52vh），加载更多按钮固定在结果底部。
- 「目标与交付」历史修订中每个目标修订新增「查看证据记录 vN」：`GET /v1/tasks/:id/evidence?goalRevision=N&limit=20&cursor=` 按修订独立展开/缓存/续页，条目展示类型、验证结论（已通过/待验证/未通过）、完成标准、敏感级、相对时间与局限；空修订如实提示「这个修订还没有证据记录」，读取失败按修订隔离报错并可重试；切换事情时历史与证据状态整体重置。
- 协作记录升级为层级树 + 跳转：按 `parentRelationId` 把子协作嵌套渲染在父卡片下（左侧竖线缩进，parent 缺席时按根渲染）；带 `targetTaskId` 的卡片提供「打开目标事情」，经新增 `api.channelTimeline`（单请求 `GET /v1/channels/:id/timeline`，校验投影完整性并兜底 workerIconId）打开目标事情详情抽屉并触发既有 delivery/协作/时间线加载；目标不存在或读取失败在协作区就地报错，按钮恢复可再试。
- 证据：`pnpm check`（74 文件 / 676 测试，App.test.tsx 新增 8 条回归）、`pnpm smoke`、`pnpm review:ui -- --force`（57 张截图）；真实 Control Plane（store 级 seed：双修订 Goal + 22 条证据 + 真实 depth0/depth1 委派链 + 10 个填充事情）联调覆盖筛选参数、排序切换、8→14 续页、v2 证据 20→22 续页与 v1 隔离、协作两级跳转；axe 三主题 × 搜索对话框/证据/协作抽屉 0 违例；实拍 12 张见 `output/feature-review/live-evidence-wrapup/`。详见 `docs/feature-map.md` DESIGN-002「搜索筛选分页、按修订证据列表与协作跳转收尾」小节。
- 仍缺：规则占位、协作发起/取消入口（owner 侧服务端契约未提供）、validity 失效事件；语音直发待真实 ASR 供应商联调；「所有事情」页服务端排序/筛选属 CHANNEL-003 后续（数据恢复占位已在 §15 接入只读状态；工作规则已在 §16 接入，归类规则仍锁定）。

## 15. 数据与恢复页接入只读恢复状态（2026-11-21，RECOVERY-001）

- 「设置 → 数据与恢复」从占位改为真实视图：本地数据库卡片如实说明在线备份走服务端 `pnpm backup` 命令（等宽 code 样式），导出数据按钮禁用并标注「待服务端 API」；恢复平面卡片展示只读状态徽标（状态完好/降级运行/状态不可用）、当前版本与 commit（8 位）、阶段、兼容 schema 区间、最近更新相对时间、可回滚版本；降级时额外展示状态来源（last-known-good 备份）与诊断列表；不可用时如实说明不影响本机数据并提供「刷新恢复状态」重试。
- 数据链路：Control Plane 新增 `GET /v1/recovery/status` 只读代理（实例 bearer；上游恢复平面 token 只在服务端；白名单投影剥离 `root` 路径；默认 3s 超时；未配置/不可达/401 分别映射诚实 unavailable 诊断）；Web 进入该分类才懒加载，读取失败 page-error + 「重新读取」。restart/rollback/candidates 不经代理暴露，破坏性操作仍只能在服务端恢复平面执行；「清除本机数据」保持禁用（需专门审批设计）。
- 证据：`pnpm check`（75 文件 / 688 测试，server 8 + Web 4 新增）、`pnpm smoke`、`pnpm review:ui -- --force`（57 张截图，recovery 面板确定性等待不可用态）；真实恢复平面联调三态（完好含可回滚版本 / 截断主状态降级 / 停止恢复平面不可用），实拍 5 张见 `output/feature-review/live-evidence-recovery/`；axe color-contrast 三主题 × 三态 0 违例。详见 `docs/feature-map.md` RECOVERY-001「恢复状态只读代理与封板 Web 接入」小节与 `docs/recovery-state.md` 代理节。
- 仍缺：数据导出 HTTP API 与 Web 导出交互、清除本机数据的审批设计、恢复平面写操作（重启/回滚）的产品化入口。

## 16. 行为与规则页接入工作规则与自定义指令（2026-11-21，RULES-001）

- 「设置 → Pegas → 行为与规则」从占位改为真实读写：信息横幅如实说明规则是注入执行的持久偏好、不授予新权限；锁定的基本行为行（默认语言/回复长度/自主程度）保留禁用并注明原因；系统规则「高风险外部操作必须确认」锁定展示（由 Approval 硬保证）；自定义规则列表支持添加（抽屉表单：名称/内容/启用开关）、编辑、两步确认删除与就地启停开关；自定义指令 textarea 独立保存，未变化时禁用。
- 数据链路：`GET/POST /v1/rules`、`GET/PUT /v1/rules/:id`、`POST /v1/rules/:id/delete`（commandId 幂等 + expectedRevision，沿用记忆模式）与 `GET/PUT /v1/settings/behavior`（revision 从 0 起）。进入 Pegas 设置分类才懒加载（规则与偏好并行读取），409 冲突自动重读最新状态并如实提示，读取失败 page-error + 「重新读取」。
- 执行语义：Worker 每次执行按创建顺序装载启用规则（≤24000 字符）与自定义指令，以 `<pegas_work_rules>` 块注入执行 prompt（声明非授权、不能绕过 Approval、`<` 转义）；停用/删除/清空对下一次执行生效。契约与边界详见 `docs/work-rules.md`。
- 「事情归类」页的归类规则与测试归类保持锁定：那是 Router Intake 决策链路，不属于本 Feature。
- 证据：`pnpm check`（76 文件 / 699 测试，rules 7 + Web 4 新增）、`pnpm smoke`、`pnpm review:ui -- --force`（57 张截图，behavior 面板 seed 真实规则并确定性等待）；真实 Control Plane + fake DSH（捕获 stdin 提示词）联调验证创建/停用/删除/指令变更逐次生效；axe 三主题 × 列表/抽屉 0 违例；实拍 9 张见 `output/feature-review/live-evidence-rules/`。详见 `docs/feature-map.md` RULES-001 小节。
- 仍缺：归类规则与测试归类（Router Intake）、语言/回复长度偏好、按事情/Worker 作用域、规则遵守度的可观察证据；协作发起/取消入口与 validity 失效事件仍待服务端契约；语音直发待真实 ASR 联调。

## 17. 待处理收件箱 refinement（2026-11-22）

- 「待你处理」从整段粗体回复改为紧凑扫描行：语义状态、短标题、可选预览、来源/时间/未读提示与唯一安静操作。标题派生只用于展示，不参与 Task、Approval 或投递状态判断；完整内容、审批、澄清、交付审查和人工核对继续走既有详情路径。
- 新增当前快照内的内容/来源搜索、实时筛选计数和筛选空态；不新增归档、稍后处理、完成、批量、snooze、swipe、服务端全文检索或分页。NOTIFY-003 的服务端消息、已读与投递合同不变。
- 可访问性补齐语义列表、条目标题、可区分的上下文操作名称和粗指针标题目标；筛选保持单行滚动并在选择后回到可见区域。三主题继续使用语义 token，移动端不产生横向页面溢出。
- 证据：以上验证均在候选 worktree 完成。31 项定向回归通过；完整 `pnpm check` 全绿（76 个测试文件 / 710 个测试，statement 85.22%、line 88.26%）；`pnpm smoke`、`pnpm build`、`pnpm review:ui -- --force`（66 张截图）和 `pnpm a11y:review`（light/warm/dark 待处理页与移动端 0 违例）通过。额外 `pnpm smoke:desktop` 被既有发送按钮选择器歧义阻塞，未修改无关脚本。详见 `docs/feature-map.md` DESIGN-002「待处理收件箱 refinement」小节。
- 仍缺：服务端全文搜索、游标分页/虚拟列表、批量处理与通知优先级；VoiceOver/NVDA 实机验证；DESIGN-002 整体 validity、协作操作和真实 ASR 缺口。以上均已登记 `docs/engineering-todo.md`「DESIGN-002 待处理收件箱后续」。改动已隔离提交并进入主线集成流程；未部署到正在运行的 Pegas，不能把候选验证表述为线上验证。

## 18. 对话页安静视觉身份（2026-11-23，DESIGN-005）

- 用户气泡从 accent 10% 淡紫底 + 22px 圆角改为中性 `--message-bubble`（派生自 `--surface`）+ 18px 圆角、右下 6px 尾巴角；气泡内不再包含任何按钮或链接。附件元信息从 canvas 混色改为 `--muted`，保证暖灰底上的对比度。
- 每条用户消息在 meta 行拥有唯一的 icon 状态槽（`状态 · 时间 · 复制`，用户行常显）：pending ✓「已送达」、processing 旋转「正在分配」、failed ⚠「发送失败」+ 常显重试；文字收进 hover title 与 aria-label。「已进入事情」文案废除。
- 成功且派生事情时，状态槽原位升级为入口：单事情渲染 🔗 直接锚点跳转事实卡；多事情渲染 🔗+数量角标，点击向下弹出菜单，逐项列出事情标题与实时状态（statusLabel），选择后跳转并关闭；零事情不渲染假链接。菜单支持 Esc 与点击外部关闭。
- 对话顶栏收敛为单行 16px/500 标题 + 细分隔线，标语移除（PageHeader 新增 compact，仅对话页使用；其余页面标题不变）。侧栏 286px→232px（≤1120px 200px），品牌 30px mark + 16px/500 名称 + 11px 状态行，导航行高 46→38px。
- 门禁：`test/sealed-ui-message-identity.test.ts` 固化 CSS 合同；`ChatExperience.test.tsx` 新增状态槽 DOM 归属、单/多事情入口与失败常显重试回归。触屏无 hover，状态文字不可见但失败重试常显、入口有 aria-label，属可接受权衡（DESIGN.md 已注明）。

## 19. 自动化列表安静化（2026-11-23，DESIGN-006）

- 机器 prompt 不再整段摊在列表：每行只显示折叠空白后的单行摘要（`automationPromptSummary` ≤120 字 + CSS 单行截断），完整指令收进「查看指令」disclosure（`aria-expanded`/`aria-controls`，`pre-wrap` 保留步骤换行，`--surface-subtle` 底、最高 320px 内滚动）。参考 Codex automations 的「不向用户展示原始调度表达」原则：列表是人读的责任摘要，不是执行合同原文。
- 元信息合并为单行 plain text：`每 N 分钟 · 续接：<事情>/每次创建新事情 · 下次触发/保留历史记录 · 最近触发`；状态并入标题行右端（`.record-title` flex），不再单独占位。
- 已结束的 Automation 默认收进「已结束 N」disclosure（ChevronDown 旋转指示），进行中/暂停的保持平铺；全部已结束时不折叠、直接平铺历史。行结构仍是 icon + 正文 + 操作按钮的平铺行，无嵌套卡片。
- 移动端（≤820px）修复既有网格缺陷：两列布局下 `.record-icon`/`.record-copy` 显式指定列，正文不再被自动放置进 34px 图标列挤成竖排单字（记忆页同受益）。
- 门禁：`web/src/sealed/AutomationPage.test.tsx` 6 测试（摘要折叠/指令 disclosure/单行 meta/已结束分组/全结束平铺/暂停与结束命令）；`scripts/capture-ui-review.mjs` 新增长 prompt + 已结束种子与 `desktop-automation-prompt/ended`、`mobile-automation` 实拍。

## 20. 自动化生命周期与触发记录（2026-11-23，DESIGN-006 第二阶段）

> 状态：已实现并发布（合并 `fc72359`，Candidate `main-fc72359-r1`，运行实例 schema v39，真机 API/实拍验证通过；见 `docs/feature-map.md` DESIGN-006 第二阶段记录）。用户裁决（2026-11-23）：加删除入口让用户手动清理已结束自动化；触发记录做 limit + 加载更多。调研依据见本地研究笔记 `research/automation-list-scaling/NOTES.md`（Codex/Cindy 均不做定义列表页码分页：Codex 固定排序 + run 级 cursor 分页 + run 归档；Cindy 分组折叠 + quiet-run 自动归档）。

### 用户结果

- 已结束的自动化可以显式删除，列表不再只增不减；删除不影响对话里已经发生的事实（数数气泡、完成卡都保留）。
- 「触发记录」不再只是调度器状态流水：每次触发显示「状态 + 计划时间 + 这次做了什么（Run 输出首行摘要）+ 进入对应事情的入口」；记录多于 25 条时尾部出现「加载更多」，逐页追加。
- 进行中的自动化排序稳定：启用中在前、按下次触发时间升序；已结束沉底折叠（既有行为不变）。

### 设计要点

1. **删除入口（仅已结束行）**
   - `completed`/`cancelled` 行的操作区追加「删除」quiet-button；点击后原位切换为「确认删除」（danger-button）+「保留」（quiet-button），与既有「结束 → 确认结束/保留」同一交互模式，无模态弹窗。
   - `active`/`paused` 行不出现删除按钮；服务端同样拒绝（`409 automation_read_only`），UI 不是唯一防线。
   - 确认删除后就地移除该行并刷新计数；失败在页级 `actionError` 提示，行保留。
   - 文案口径：按钮「删除」，确认「确认删除」；不需要额外解释文案——保留边界（对话历史不删）由合同文档承载，行内不堆说明。
2. **触发记录行升级**
   - 每条 Invocation 渲染为：状态徽章（既有 `invocation-status`）+「计划 <时间>」+ 摘要（`summary`，Run 输出首行 ≤120 字，muted 单行截断）+「查看事情」inline-link（有 `taskId` 时渲染，跳转对应 Channel）。
   - 无 Run/无输出（pending、失败未派发）只显示状态与时间，失败原因沿用 `invocation-error`；不编造摘要。
   - 摘要与入口是服务端派生的只读投影（`taskId`/`summary`），客户端不从正文推断；权威执行确认仍在对话流（长期架构约束）。
3. **加载更多**
   - 首屏 `limit=25`；响应含 `nextCursor` 时列表尾部渲染「加载更多」quiet-button，点击追加下一页（cursor=上页末条 id），加载中按钮禁用并显示「正在加载…」。
   - 追加失败显示行内错误 +「重试」，已加载页保留；切换 Automation 或收起记录时重置分页状态。
   - 无 `nextCursor` 不渲染按钮；空列表仍显示「还没有触发记录」。
4. **排序（固定规则，不加排序菜单）**
   - 进行中/暂停区：`active` 在前、`paused` 次之，组内按 `nextFireAt` 升序（无下次触发排后），同刻按标题稳定排序。
   - 已结束区：按 `updatedAt` 倒序（最近结束在前）。折叠分组行为不变。
   - 依据：Codex 定义列表同为固定排序（未读→未暂停→nextRun 升序→名称），不提供排序控件；机器运行不改变定义列表顺序。

### 数据与权限边界

- 删除：`POST /v1/automations/:id/delete`（owner 命令幂等 + expectedRevision fence），事务内清定义 + Invocation + pending automation.due Event；Task/Run/消息保留。`automation_commands` 外键改 `ON DELETE SET NULL`（additive 迁移 v39），命令账本保留可重放。合同细节见 `docs/automation-scheduling.md`「删除」「触发记录分页」。
- 分页：`GET .../invocations?limit&cursor` seek 分页（`scheduled_for DESC, rowid DESC`），limit 缺省 50、上限 200；响应 `{ invocations, nextCursor? }`。
- 投影：Invocation 响应附加 `taskId?`/`summary?`（`runs.origin_event_id` JOIN + `output_json` 首行），只读派生不落盘，不新增表。

### 验收条件（已按下述证据先红后绿）

1. store：删除仅限已结束；active/paused 拒绝；revision 冲突 409；同 command 幂等重放冻结回执、异 payload 409；删除后 GET 404；Invocation 与 pending Event 同事务清除；Task/Run/消息保留；processing Event 不受影响；owner 隔离。
2. store：invocations 分页按 scheduled_for DESC seek；limit 边界（1/200/缺省 50/非法拒绝）；非法 cursor 400；nextCursor 有无正确；投影 taskId/summary 正确且 Run 缺失时缺省。
3. HTTP：delete 路由合同（201/200/404/409 各错误码）；invocations cursor 透传。
4. web：已结束行删除两步确认与就地移除；active 行无删除按钮；触发记录含摘要与「查看事情」入口、失败行无摘要；加载更多追加/禁用/重试/重置；排序规则（active→paused→nextFireAt 升序，已结束 updatedAt 倒序）。
5. 门禁：`pnpm check` + `pnpm smoke`（持久化链路）+ `pnpm smoke:crash`（Event 删除与 lease 并发）+ `pnpm review:ui --force`（新增删除确认与加载更多种子实拍）+ `pnpm a11y:review`。

### 实现证据（2026-11-23）

- 服务端：`src/storage/sqlite-store.ts` 迁移 v39（`automation_commands.automation_id` 可空 + `ON DELETE SET NULL`）、`deleteAutomation`（幂等命令重放 + revision fence + 仅已结束；事务内逐 Event 先删 Invocation 再删 pending Event，随后清剩余 Invocation 与定义；Task/Run/消息保留）、`listAutomationInvocations` 改 seek 分页（`scheduled_for DESC, rowid DESC`，缺省 50/上限 200，非法 cursor 拒绝）并投影 `taskId`/`summary`（`runs.origin_event_id` JOIN + `output_json` 首行 ≤120 字）。`src/control-plane/server.ts` 新增 `POST .../delete` 与 invocations `limit/cursor` 透传；`src/worker/main.ts` compatibility maximumSchema 38→39。
- Web：`AutomationPage`/`AutomationRow`（`web/src/sealed/MainPages.tsx`）删除两步确认（仅已结束行）、触发记录摘要 + 「查看事情」inline-link（经 `taskId` 命中 Channel 才渲染）、加载更多（limit 25、cursor 追加、加载禁用、失败重试保留已加载页、切换/收起重置）、固定排序（active→paused→nextFireAt 升序→标题；已结束 updatedAt 倒序）。
- 回归测试：`test/automation-lifecycle.test.ts` 6 测试先红后绿（删除语义/幂等/fence/owner 隔离/HTTP 错误表；分页 seek/limit 边界/非法 cursor/投影与 HTTP 透传）；`web/src/sealed/AutomationPage.test.tsx` 6→11 测试（删除两步确认仅已结束、摘要与事情入口、失败行不编造摘要、加载更多 cursor 追加与耗尽、追加失败重试保留已加载页、固定排序）。既有 store 调用方（schedule/follow-up/run-automations 测试）随分页签名更新为 `.items`。
- 门禁：`pnpm check` 全绿（108 文件 / 1115 测试；statement 85.25%、line 88.47%，阈值 60/55/60/65）；`pnpm smoke`、`pnpm smoke:crash`（3 Task exactly-once）通过；`pnpm review:ui --force` 新增删除确认/触发记录实拍（desktop-automation-delete-confirm/history、mobile-automation-history；种子改为 park+cancel 的计数自动化 + 单次真实触发的「触发记录示例」历史 fixture，经真实 scheduler+worker 产出 Run 摘要；fixture Channel 以显式 taskId 续接回顶保持侧栏确定性）；`pnpm a11y:review` 0 违例。

### 非目标

- 不做定义列表页码分页/搜索框/排序菜单（调研结论：当前规模不需要；>20 条再议搜索）。
- 不做自动清理/N 天归档（用户选择手动删除）。
- 不做 run 级归档/未读圆点（Codex 语义，Pegas 对话流已有 say 声道承载）。
- 不改「查看指令」摘要截断为语义化首句（仍是 DESIGN-006 登记缺口）。

### 失败与恢复

- 删除是破坏性操作但范围受限（仅调度对象）；无「撤销」——确认步骤即防线；误删的补救是重建自动化，历史事实不受损。
- 迁移 v39 additive（外键重建 + 列放宽），旧数据不动；回滚 revert 代码即可，schema 向前兼容（旧代码不写 null automation_id）。
- Candidate 发布走 SELF-001 既有流程；compatibility maximumSchema 提升至 39。

### 设计图

- 交互稿（本地研究材料，不入库）：`research/design-006-lifecycle-history/mockups.html`——桌面列表（删除确认态）、触发记录展开（摘要 + 查看事情 + 加载更多）、390px 移动端三帧，使用 §5 视觉 token 与既有 record-list 结构。
