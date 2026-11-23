# Pegas Engineering Lessons

> Feature：`QUALITY-001`
>
> 状态：Living Document
>
> 更新日期：2026-11-19

本文件把已经造成返工、回滚、测试漏检或用户影响的事实，转化为可执行的工程规则。它不是通用最佳实践清单，也不收录尚未在 Pegas 中观察到的猜测。

## 用户结果

重复出现的工程失误不会只停留在一次修复里。每次事故留下证据，同类问题达到晋升条件后进入仓库规则或自动化门禁，使后续 Feature 在合并前被阻断。

## 记录格式

每条 Lesson 使用稳定 ID `LESSON-YYYYMMDD-NN`，并包含：

- **Rule**：一句可以检查的规则；
- **Why**：用户或系统受到的实际影响；
- **Feature**：关联的 Feature ID；
- **Evidence**：commit、PR、Issue、测试或日志的稳定引用；
- **Seen**：在不同日期独立观察到的次数与日期；
- **Severity**：`normal`、`security`、`data-loss` 或 `recovery`；
- **Status**：`Observed`、`Candidate` 或 `Promoted`；
- **Enforcement**：晋升后的 `AGENTS.md` 条款、测试、Lint、CI 或运行时约束；
- **Owner / next action**：下一步负责人或缺口。

证据不得包含凭证、用户原文、生产数据库内容或无法安全公开的日志。需要保留敏感证据时，只记录受控 artifact 的引用和脱敏摘要。

## 晋升规则

1. 首次观察记为 `Observed`；第二个独立日期再次出现时改为 `Candidate`。
2. 同一类问题在三个独立日期出现后必须改为 `Promoted`，并在同一个变更中给出 Enforcement。
3. `security`、`data-loss` 和 `recovery` 不等待三次；一次确认即可晋升。
4. 优先使用自动化门禁。只有无法可靠自动检查时，才把规则放入 `AGENTS.md` 或评审清单。
5. 已晋升 Lesson 继续保留证据，但规则只在一个权威位置维护，避免文档分叉。
6. 如果证据不足以证明是同一类问题，保持 `Observed`，不得为了凑次数扩大规则。

## 复盘节奏

- 每个 Bug、回滚、重开的 Issue 和失败的 Candidate 在关闭前检查是否应新增或增加 Seen。
- 每次 Release 复盘当期的返工提交、CI 漏检、人工修复和未覆盖风险。
- Feature 完成时，在 PR 的“经验复盘”中明确填写：新增 Lesson、更新已有 Lesson，或“无新 Lesson”。
- 晋升后验证规则能在旧的错误实现上失败；不能证明这一点的测试不能作为 Enforcement。

## 验收条件

1. Lesson 有统一格式、Seen 计数和明确晋升阈值。
2. 高严重度问题可以立即晋升。
3. PR 会记录精确 tested head、测试数量、真实验证、未验证项和经验复盘。
4. 后续规则集中在工程 TODO，未成熟规则不会提前污染强制标准。

## 非目标与恢复

- 本 Feature 不自动分析 commit 或生产日志，也不接入外部 Issue 系统。
- 本 Feature 不把 Magpie 或其他项目的规则直接认定为 Pegas 已发生的 Lesson。
- 错误晋升可通过普通文档提交降级或撤销；已存在的自动化门禁必须同步移除或收窄，并保留原因。

## Lessons

### LESSON-20261123-03：入口角标与页内计数必须同口径，已读粒度跟随详情落点

- Rule：导航入口角标与目标页主计数必须回答同一个问题（同单位、同过滤条件），不得一个数「未读条数」另一个数「待办行数」；已读粒度跟随详情落点——多个列表项打开同一详情时，打开任一入口应结算该详情的全部对应未读，独立决定/独立内容的条目维持逐条已读。disclosure 展开态不得复用 hover/选中态的整行底色。
- Why：DESIGN-007 侧栏角标数跨区未读通知条数（9），页内 chip 数待办行数（7），用户报告「外面显示跟内部的数量对不上」；失败/动态组每条时间线条目都打开同一事情详情，逐条已读迫使用户无意义多点；展开行整行 `--surface` 灰底与鼠标 hover 选中态相同，被误读为选中。
- Feature：DESIGN-007
- Evidence：2026-11-23 用户两张截图（角标 9 vs chip 7；展开行灰底）；`web/src/App.test.tsx`「badges the rail with the todo row count」「marks every unread member of a task group read」等 4 回归，角标与整组已读用例在修复前代码上失败复现。
- Seen：1（2026-11-23）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本 Feature 回归测试 + 合同验收条件 4、9（角标=chip 口径、整组已读、展开态无整行灰底）已落地。
- Owner / next action：后续出现同类问题时补充独立日期证据；候选检查其他入口角标（自动化、记忆）与页内计数是否同口径。

### LESSON-20261123-02：聚合行的每个计数成员必须有打开入口

- Rule：列表聚合/折叠视图中，计数胶囊声称的 N 条成员必须全部经界面可达（展开时间线含全部成员，或有等价的独立入口）；摘要行引用的具体消息若可被用户理解为「一条记录」，必须可点打开详情并触发该条的已读语义，不得以纯文本呈现唯一副本。
- Why：DESIGN-007 聚合组时间线取 `messages.slice(1)`，最新一条只存在于纯文本摘要「最新：…」中。用户点摘要无反应、未读数不减；展开只见 N-1 条与胶囊 N 不符，被报告为两个 bug（失败区与事情动态区同报）。
- Feature：DESIGN-007
- Evidence：2026-11-23 用户截图与运行实例 Playwright 复现（`research/design-007-live/repro-read.mjs`，本地不入库）；`web/src/App.test.tsx`「opens the latest grouped failure/routine result from its summary line」2 回归在修复前失败、修复后通过。
- Seen：1（2026-11-23）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本 Feature 回归测试 + 合同验收条件 4（时间线条数 = 胶囊计数）已落地。
- Owner / next action：后续出现同类问题时补充独立日期证据；候选检查其他聚合/折叠视图（任务托盘、触发记录）是否存在「计数成员不可达」模式。

### LESSON-20261118-01：看板固定最小宽度导致整页横向位移

- Rule：宽面板需要在实际主内容宽度下验证，不能只按完整视口宽度决定列数。
- Why：任务列被裁切，用户必须横向拖动，标题栏和搜索入口也随滚动偏移。
- Feature：CONV-002
- Evidence：用户提供的任务页截图；`web/src/App.test.tsx` 的任务页回归与浏览器宽度核对。
- Seen：1（2026-11-18）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以容器查询修复，后续评估浏览器布局自动化。
- Owner / next action：后续出现同类问题时补充独立日期证据。

### LESSON-20261118-02：模型目录获取成功却无法完整选用

- Rule：异步获取的选项目录必须让全部返回结果通过分页、虚拟化或搜索实际可达，并提供点击与键盘选用路径；搜索控件必须在真实布局中验证完整宽度、图标和焦点几何；默认模型必须断言 Router 模式、Provider 和模型 ID 三元组，不能用列表排序代替默认行为。状态反馈应紧邻触发控件、保持紧凑并提供下一步，不得展示上游长错误或大字号独立通知卡。
- Why：第一次修复让用户可以从 165 个模型中选择，却仍只呈现前 50 个结果，其余结果不能按浏览路径到达；获取成功反馈又以大字号独立卡片占据设置页，且 Router 模型与 Agent 执行模型在同一分类重复出现，造成配置归属不清。分页重构后，搜索框沿用了已经失效的父级选择器而退回浏览器默认宽度；“Magpie 排第一”也没有阻止默认 Router 继续使用规则模式和小模型池。
- Feature：SETTINGS-001
- Evidence：用户在 2026-11-18 和 2026-11-19 提供的模型设置截图；`web/src/App.test.tsx` 的大列表分页、搜索复位、模型选择、信息架构和 404 反馈回归；`test/config.test.ts`、`test/initial-model.test.ts` 与 `test/runtime-settings.test.ts` 的默认 Router/Magpie/指定模型回归；`test/workspace-theme.test.ts` 的搜索宽度、分页与紧凑反馈布局合同；`scripts/capture-ui-review.mjs` 的默认三元组断言、搜索几何断言及桌面/390px 截图。
- Seen：3（2026-11-18、2026-11-19、2026-11-23）
- Severity：normal
- Status：Promoted（2026-11-23）
- Enforcement：已晋升为自动化门禁——`test/workspace-theme.test.ts`「keeps every model-selection entry on the paginated shared catalog」断言所有模型选择入口共享 30/页分页、composer 不按 Provider 过滤目录、UI review 携带分页断言与隔离模型网关；`scripts/capture-ui-review.mjs` `assertPickerPagination` 在桌面与 390px 真实布局断言 34 模型目录 30+4 分页完整可达；`test/dsh-home.test.ts` 与 `test/connection-catalog.test.ts` 钉死服务端目录装配（全目录注入、选中模型首位、单连接失败回退）。既有目录完整可达、搜索复位、默认三元组、单一配置归属、紧凑反馈回归继续生效。
- Owner / next action：2026-11-23 用户报告对话框选择器固定 1 个模型（第三个独立日期）：根因是服务端受管 DSH patch 每 Provider 只声明 1 个模型 + composer 按接入点过滤且无分页；已修复并晋升门禁。同日后续：用户指出设置页 6 处仍是原生 select/手填框，已抽取共享 `web/src/sealed/ModelPicker.tsx` 统一全部入口（分页/搜索/置顶特殊值/手填保底），门禁扩展为断言三个消费方引用共享组件与搜索框容器聚焦合同；「抽取通用异步选项目录组件」候选项完成。

### LESSON-20261123-01：保存路径不得静默重置已配置的连接地址

- Rule：非 custom Provider 的设置保存/探测路径必须保留 capabilities 中已存连接或环境配置的 baseUrl，不得无条件回写 preset 默认地址；隔离 UI/集成夹具必须断言请求真的落在夹具网关上。
- Why：`parseRuntimeSettingsUpdate` 对非 custom Provider 一律 `baseUrl: preset.baseUrl`，把 `PEGAS_MODEL_BASE_URL` 初始化的连接在目录探测/测试/保存时静默改写到 preset 地址；UI review 的 34 模型隔离网关因此被绕过，目录探测打到真实 Magpie 网关返回 83 个真实模型，隔离性失效且可能误导用户覆盖连接配置。
- Feature：SETTINGS-001
- Evidence：2026-11-23 UI review 隔离夹具断言失败（已读取 83 个模型 ≠ 34）；`test/runtime-settings.test.ts`「keeps the configured preset connection address instead of resetting it」回归；`scripts/capture-ui-review.mjs` 目录 34 模型计数断言。
- Seen：1（2026-11-23）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；回归测试 + UI review 夹具计数断言已落地。
- Owner / next action：后续出现同类问题时补充独立日期证据；候选检查其他写路径是否存在 preset 覆盖已存配置的同类模式。

### LESSON-20261118-03：密文末字符变更不能稳定代表字节篡改

- Rule：加密完整性测试必须修改解码后的密文字节或认证标签字节，再重新编码；不能只替换编码字符串的末字符。
- Why：Base64url 末字符可能含不参与解码的尾部位，也可能恰好与替换字符相同，导致 CI 偶发通过解密。
- Feature：SETTINGS-001
- Evidence：2026-11-18 主分支 CI run 44248190224 的失败断言；`test/model-credential-vault.test.ts` 的确定性标签篡改测试。
- Seen：1（2026-11-18）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；测试已改为确定性字节篡改。
- Owner / next action：后续出现同类问题时补充独立日期证据。

### LESSON-20261118-04：录音能力与语音服务状态混淆

- Rule：语音入口应分别显示浏览器录音能力和服务端转写配置，并在申请麦克风权限前检查服务配置。
- Why：设置页显示“浏览器可用”，实际服务端未配置 ASR，录音结束后才出现英文错误，且用户无法在页面修复。
- Feature：VOICE-001
- Evidence：用户提供的输入器和设置截图；`web/src/App.test.tsx` 未配置引导回归及 `test/control-plane.test.ts` 保存后转写回归。
- Seen：1（2026-11-18）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以回归测试覆盖。
- Owner / next action：后续出现同类问题时补充独立日期证据。

### LESSON-20261118-05：连接设置缺少实际验证入口

- Rule：新增外部服务连接表单时，提供基于当前未保存配置的真实请求测试和可理解的结果反馈。
- Why：用户可以填入语音地址、模型和密钥，却要保存并返回对话录音后才知道连接是否可用。
- Feature：VOICE-001、SETTINGS-001
- Evidence：用户提供的语音与改写设置截图；`test/control-plane.test.ts` 未保存连接探测、失败脱敏及改写回归，`web/src/App.test.tsx` 对应交互回归。
- Seen：1（2026-11-18）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以回归测试覆盖。
- Owner / next action：同日改写服务再次出现缺少测试入口，后续独立日期复发时评估统一门禁。

### LESSON-20261118-06：绝对定位子元素必须有明确的局部包含块

- Rule：面板内绝对定位的标题栏必须锚定到面板自身的定位上下文，并为收缩态的可见控件数量增加回归证据。
- Why：工作区空态标题以 viewport 为包含块，导致窄屏覆盖面板中的文字和分隔线跨过左边界；左 rail 收缩后也保留了多余入口。
- Feature：CONV-002
- Evidence：用户提供的工作区与收缩 rail 截图；`web/src/App.test.tsx` 单按钮回归与 `test/workspace-theme.test.ts` 定位合同。
- Seen：1（2026-11-18）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以 DOM 和 CSS 回归测试覆盖。
- Owner / next action：后续独立日期复发时补充可视化几何门禁。

### LESSON-20261119-01：发布目录不能成为不可恢复的 Session 身份

- Rule：Executor 恢复必须区分“已开始执行后的失败”和运行时在执行前明确拒绝的 workspace 身份漂移；只有后者可以自动新建 session。
- Why：Candidate worktree 切换后，历史 DSH session 仍绑定旧路径，新的 Worker 使用当前路径恢复时把运行时路径错误直接展示给用户，导致可用模型看起来不可用。
- Feature：EXEC-003
- Evidence：用户提供的对话错误截图；`test/dsh-cli-executor.test.ts` 跨 workspace session 恢复回归。
- Seen：1（2026-11-19）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以精确错误匹配和回归测试约束，其他失败仍保持不可自动重放。
- Owner / next action：将 Task workspace 与 Candidate artifact 生命周期彻底解耦，并补真实 Candidate 切换故障演练。

### LESSON-20261119-02：错误反馈不能覆盖用户正在阅读的内容

- Rule：输入器异步错误必须在输入器内部占据正常布局空间，并通过礼貌 live region 宣告；不得绝对定位到消息流上方。
- Why：语音服务不可达时，错误文案覆盖了上一条消息的时间和输入器边缘，用户既看不清错误归属也无法稳定操作输入框。
- Feature：VOICE-001
- Evidence：用户提供的语音失败截图；`web/src/App.test.tsx` 的 inline status 回归和 `test/workspace-theme.test.ts` 的非覆盖布局合同。
- Seen：1（2026-11-19）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；本轮以语义和 CSS 回归覆盖。
- Owner / next action：后续独立日期复发时补充浏览器几何截图门禁。

### LESSON-20261119-03：功能完成必须按用户闭环判定

- Rule：Feature 开始前必须冻结“用户场景 × UI 状态 × 视口 × 真实依赖 × Candidate 生命周期”的验收矩阵；完成声明必须写明已达到的证据层级，并在合并、重启后用新浏览器页面按用户原始视口、状态和数据复现关键场景。源码测试、Candidate 截图、合入 main 和正在服务的 main 是四层不同证据，低层证据不能替代高层证据。
- Why：DS Bot 前端重构连续经历了壳层重做、设置和工作区补回、工作区定位与收缩态修复、默认 ASR、默认 Magpie、跨 Candidate session 恢复和错误提示布局修复。反复修改不是因为这些问题无法同时发现，而是第一轮没有把完整闭环定义为一个验收对象：我把明确的“复刻”要求当成可解释的设计方向，没有先逐项对照源码与参考截图；自动化主要验证 DOM、状态和局部 CSS，没有在真实布局里检查几何关系；模型和语音先验证了配置值，没有在最终 Candidate 上走真实服务；运行代码所在 worktree 又被误当成 DSH 的稳定 Task workspace；同一界面存在多层主题 CSS，最终级联覆盖没有在所有关键状态下渲染验证。最近一次又在 Candidate 的 390px 截图和静态 CSS 测试通过后先宣告修复，服务重启后仍未按用户的桌面展开态复现；随后还因只检查了 568px 移动覆盖态而误判为浏览器缓存。直到在新的桌面页面测量真实几何，才发现 Channel 列表继承旧布局的 `align-items: center`，宽度扩张到约 690px 并居中到负坐标。根因是用相邻证据替代原始场景证据，而不是单纯“服务没重启”。
- Feature：QUALITY-001、CONV-002、VOICE-001、SETTINGS-001、EXEC-003
- Evidence：2026-11-18 至 2026-11-19 的提交序列 `56906db`、`0427a0a`、`1598a76`、`d4747d6`、`1f2ced6`、`d205ccb`、`f2142dd`、`5d4dd3c`、`fb9c8a6`；用户连续提供的首页、工作区、收缩栏、设置、错误状态、165 模型选择器压缩和 Channels 文案消失截图；首次修复只覆盖移动侧栏，随后在运行中的 main 上确认桌面侧栏列表因继承 `align-items: center` 而扩张到约 690px、居中到负坐标；随后补入的 `web/src/App.test.tsx`、`test/workspace-theme.test.ts`、`test/dsh-cli-executor.test.ts`、`test/css-cascade-lint.test.ts`、`scripts/capture-ui-review.mjs` 与 `scripts/lint-css-cascade.ts` 回归；首轮 QUALITY-001 CI artifact 名称绑定 PR head、报告正文却绑定 GitHub synthetic merge commit，最终核验发现后增加显式 head checkout 回归。
- Seen：2（2026-11-18、2026-11-19）
- Severity：normal
- Status：Candidate
- Enforcement：根据用户明确要求提前实现 QUALITY-001 门禁，但 Lesson 仍按 Seen 次数保持 Candidate：仓库永久保存验收条件和测试能力；CI 显式检出 PR head 并在准确 SHA 上生成短期报告与 UI 截图；UI Review 必须打开大模型列表并检查面板宽度/滚动区，同时检查窄侧栏导航子元素边界和整个 Channel 列表是否仍位于 rail 内；`pnpm lint` 阻断后置 column flex 主题规则隐式继承旧 `align-items`；关键 `Not tried` 阻断审核；Candidate schema v2 绑定报告哈希与人工 reviewed commit；完成报告必须区分源码、Candidate、main 与运行实例四层证据，只有运行实例按原始场景复现后才能声称用户问题已修复。运行结果不再作为永久 Feature manifest 提交。
- Owner / next action：补通用 Candidate canary runner；第三个独立日期再次出现同类问题时，按晋升规则将本 Lesson 标记为 Promoted。

### LESSON-20261119-04：上下文切换必须同时验证写入目标和读取投影

- Rule：任何“进入 Task/Channel/Thread 后继续对话”的功能，必须分别验证写入携带正确目标 ID、读取只返回该目标事实，并使用至少两个同用户容器做反向隔离断言；客户端不得用全局快照模拟局部历史。
- Why：CHANNEL-001 只验证了向选中 Channel 发送消息时携带 `taskId`，却继续把用户的全部 Inbox 和 Outbox 合并成对话时间线。结果每个 Channel 虽然写入目标正确，读取界面却完全相同；单一 Channel fixture 和正向断言无法发现这种串线。
- Feature：CHANNEL-002
- Evidence：用户报告所有 Channel 显示与 Pegas 相同历史；服务端两个同用户 Channel、一个其他用户 Channel 的所有权/负向隔离回归；Web 从全局对话切换到 Channel 后立即移除相邻 Channel 内容的回归；真实 Candidate 在主对话展示两个 Channel、进入其中一个后只保留对应输入和结果的浏览器断言与截图。
- Seen：1（2026-11-19）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升为全仓规则；本轮已用服务端权威时间线接口、所有权校验、竞态响应丢弃和双 fixture 负向测试约束 CHANNEL-002。
- Owner / next action：后续 Thread/协作关系/搜索结果详情开发沿用同一负向隔离矩阵；在三个独立日期复发时晋升为通用门禁。

### LESSON-20261121-01：多进程冷启动先完成唯一 schema owner

- Rule：Electron、Supervisor 或开发脚本启动共享同一 SQLite 的常驻写入进程时，必须先让 Control Plane 完成 schema 初始化和健康检查，再启动 Worker、Scheduler、Dispatcher 等后续写入进程。
- Rule evidence：SCHEDULE-001 首次桌面 smoke 中，Control Plane、Worker 与新增 Scheduler 同时冷启动同一数据库，Worker 未完成提交的 Run；改为 Control Plane ready 后再启动后台进程，并把启动顺序加入桌面回归。
- Why：多个进程并发执行 migration 会放大 SQLite 锁竞争，表现为偶发 worker 退出或任务永久 queued。用户看到产品页可输入，但提交不会执行。
- Feature：DESKTOP-001、SCHEDULE-001、RECOVERY-001
- Evidence：2026-11-21 首次 `pnpm smoke:desktop` 的 `Desktop Worker did not complete the submitted Run`；`src/desktop/main.ts` 的 health-first 启动顺序；`test/desktop-runtime.test.ts` 的顺序回归；随后 `pnpm smoke:desktop` 通过。
- Seen：1（2026-11-21）
- Severity：recovery
- Status：Promoted
- Enforcement：Electron 只先启动 Control Plane，`waitForControlPlane` 成功后才启动 Worker 与 Scheduler；桌面回归测试固定该顺序，真实 Electron smoke 继续覆盖 Task→Run。
- Owner / next action：新增其他共享数据库的桌面子进程时必须复用同一 health-first 启动边界。

### LESSON-20261121-02：条件拼接 SQL 的分支占位符必须与参数构造同步

- Rule：按查询长度、筛选开关等条件拼接 SQL 分支时，每个分支引入的占位符必须在参数构造处有对应绑定；新增或修改分支必须同时覆盖各分支的自动化回归。
- Why：CHANNEL-003 短查询（<3 字符）EXISTS 分支需要一个原始 query 绑定，但参数构造只在 FTS 分支追加第二个参数，LIMIT 绑到字符串、query 绑到 task_id，1–2 字符搜索全部 400 `datatype mismatch`；已有测试只覆盖长查询，缺陷由 UI 联调发现而非门禁拦截。
- Feature：CHANNEL-003
- Evidence：2026-11-21 DESIGN-002 搜索接线时发现并登记；`fix/CHANNEL-003-short-query` 修复 `searchChannels` 参数构造，`test/channel-search.test.ts` 新增 1/2 字符与中文短查询 store 回归及 HTTP 合同短查询断言，先复现失败再修复通过。
- Seen：1（2026-11-21）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升为全仓规则；本次以短查询回归测试约束该分支。
- Owner / next action：后续给 `searchChannels` 或其他条件拼接查询增加分支时，必须为每个分支补参数绑定回归；同类问题在三个独立日期出现后晋升为门禁。

### LESSON-20261122-01：快速结束的进程边界必须验证下一跳的独占资源交接

- Rule：一个 Run 以「提前结束当前 Executor 进程、由 successor 恢复同一持久 session」为协议时，必须用真实进程验证 park→resume 交接：前一进程的资源释放（如 DSH session 内核写锁的 bounded dispose 窗口）与 successor 的获取时机要能闭环，mock Executor 测试不能替代。
- Why：APPROVAL-001 桥接在 fake DSH 全链路测试与全部门禁通过后，真实 DSH 联调发现 park 进程在 turn 结束后仍持有 session flock 最长约 5 秒（DSH 设计上的 bounded shutdown），用户秒批时 successor 立即 resume 撞 `already owned by an active write handle`，Run 失败且 authorized Action 被 fence 转为 unknown，需要人工核对。修复为 Executor 对该确定性错误做有界重试（默认 20s，可配置，abort 即停）。
- Feature：APPROVAL-001
- Evidence：2026-11-22 真实 DSH 0.2.2-rc.5 + Pegas dist 联调（隔离 home + 受管模型配置）；park 成功创建 `dsh.tool.bash` Approval，approve 后 successor 报 session write handle 冲突；`dsh-session-persistence-jsonl` lease 注释与 `profile-boot` `PROCESS_SHUTDOWN_TIMEOUT_MS=5000` 证实窗口；`test/dsh-cli-executor.test.ts` 新增锁释放后重试成功与超窗失败两条回归。
- Seen：1（2026-11-22）
- Severity：recovery
- Status：Observed
- Enforcement：本次以两条确定性回归 + 真实进程 park→approve→resume 联调作为该路径验收；后续同类进程交接 Feature 必须包含真实进程交接验证。
- Owner / next action：同类问题再次出现时晋升为「进程交接必须真实进程验证」的仓库条款或 smoke 场景（把 park→resume 加入 smoke:crash 类脚本）。

### LESSON-20261122-02：服务入口的运行时装配必须有真实进程验证

- Rule：`src/*/main.ts` 等服务入口新增运行时装配（类、闭包、初始化顺序）时，必须至少有一条真实进程路径（smoke 或等价启动验证）覆盖新装配；单元测试与 `pnpm check` 不能替代入口初始化顺序验证。
- Why：EXEC-007 把 `ManagedDshExecutor` 类声明放在 worker 入口主循环之后，主循环同步启动即引用该类触发 TDZ `ReferenceError`，每个 Run 执行失败；`pnpm check`（708 测试）全绿，缺陷由 `pnpm smoke:crash` 真实进程暴露。main.ts 不在单元测试 import 图内，此类错误对 typecheck/lint/coverage 全部不可见。
- Feature：EXEC-007
- Evidence：2026-11-22 EXEC-007 worktree；修复前 `pnpm smoke:crash` 报 `worker did not reach the event-claim crash point`，worker 日志 `Cannot access 'ManagedDshExecutor' before initialization`；把类声明移到主循环之前后 smoke:crash 三崩溃点通过。
- Seen：1（2026-11-22）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升为全仓规则；本次以 `pnpm smoke` + `pnpm smoke:crash` 作为该入口改动的完成门禁。
- Owner / next action：同类问题再次出现时评估把「入口改动必须跑进程级 smoke」晋升为 AGENTS.md 条款或 CI 条件门禁。

### LESSON-20261122-03：以 prop 为 key 的组件内重置 effect 会吞掉挂载后立刻发起的异步状态

- Rule：组件用 `useState('') + useEffect 比较 key` 做「切换对象时重置」时，重置 effect 会在首次挂载后必然运行一次；若用户在首帧内触发异步加载（点击展开、自动预取），结果会被这次重置清空。key 状态应初始化为当前 prop（`useState(channelId)`），或改用父层 `key` 强制重挂载。
- Why：DESIGN-002 详情抽屉 `DeliverySection` 的 `historyKey` 初始为 `''`，挂载后的重置 effect 与「查看历史修订」的 fetch 竞争：CI 慢机器上 fetch 在重置前完成时 `setHistoryOpen(false)`/`setHistory(undefined)` 吞掉结果，历史修订间歇性打不开；本地快机器 fetch 慢于重置所以全绿。
- Feature：DESIGN-002
- Evidence：2026-11-22 CI run 44982291853 `drills into goal and review pack history` 失败；本地插桩日志证实 `TOGGLE-OPEN → RESET → HISTORY-SET` 顺序；`historyKey` 改为 `useState(channelId)` 后完整 App 套件连续 5 次全绿（修复前 3 次内可复现失败）。同 run 还暴露 UTC 时区 `-0` 断言问题（`-getTimezoneOffset()` 在 UTC 下为 `-0`），断言改为 `|| 0` 归一化。
- Seen：1（2026-11-22）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升为全仓规则；本次以组件修复 + 既有回归作为门禁。
- Owner / next action：同类问题再次出现时晋升为「key-reset effect 必须初始化自当前 prop」的 Lint 规则或 review checklist。

### LESSON-20261122-04：在役 Candidate 的依赖不能指向可清理的构建 worktree

- Rule：Supervisor 在役（active/previous）Candidate 的运行依赖必须自包含于 Release 目录；`node_modules` 不得以符号链接指向按流程会被清理的构建 worktree。构建器应原生产出实体依赖（如 APFS clonefile），清理 worktree 前必须校验在役 Release 无树外依赖。
- Why：`buildSelfChangeCandidate` 以符号链接共享 worktree 的 `node_modules`，而 Feature 流程要求合并后清理 worktree/分支：清理会同时打断 active Release 的重启与 previous Release 的回滚恢复路径。本次发布后 `release-b22fa90` 无法按流程清理，需人工把依赖 clonefile 实体化并重算 attestation/manifest 哈希后才能删除 worktree。
- Feature：SELF-001
- Evidence：2026-11-22 `main-b22fa90-r1` 发布记录与依赖重锚定记录（`releases/candidates/main-b22fa90-r1.reanchor.json`，本地）；重锚定前后各一次真实 Supervisor restart 验证；`main-3621a49-r1`、`main-06ffb71-r1` 的 `node_modules` 仍指向 `exec-006-live-feedback` worktree。
- Seen：1（2026-11-22）
- Severity：recovery
- Status：Observed
- Enforcement：尚未晋升；按晋升规则 recovery 类一次确认即可晋升，Enforcement（构建器实体化依赖 + staging/清理前树外依赖校验的自动化门禁）需要独立 SELF-001 代码变更，已登记为下一缺口，不得以纯文档冒充门禁。
- Owner / next action：下一个 SELF-001 迭代实现构建器自包含依赖与在役 Release 树外依赖检查，并同 commit 晋升本 Lesson；在此之前清理任何 worktree 前必须人工核查在役 Candidate 的 `node_modules` 指向。

### LESSON-20261123-01：Agent 工作区默认值必须物理隔离于代码 checkout

- Rule：会被 Executor 当作 Agent 工作区/身份目录使用的配置默认值，不得默认 `resolve('.')` 继承启动目录，也不得落在任何代码 checkout 树内（含仓库内的数据目录子目录）——执行器会从 cwd 向上发现项目指令，"逻辑上属于数据目录"不构成隔离。默认位置须物理上在仓库外（如 `~/.pegas/workspaces/<dataDir 哈希>`），按实例派生互不共享；服务入口幂等创建，桌面入口显式注入并覆盖父进程残留。
- Why：`workspaceRoot` 默认 `'.'` 使开发仓库里拉起的 Pegas 把 checkout 当 Agent 工作区，DSH `dsh-agent-instructions` 从 cwd 向上加载了仓库的开发版 AGENTS.md/docs 作为 Agent 自身指令；本地库中 12 个 Run 快照 workspace 固化为主仓库路径。第一轮修复改为 `<dataDir>/workspace` 后真实 DSH 探针（Run 9d2cd0f7）证实仍被吸入：DSH `findProjectRoot` 向上走到最近 `.git` 根，开发场景 dataDir 本身在仓库树内。与 LESSON-20261119-03 中「运行代码 worktree 被误当成 DSH 稳定 Task workspace」同类（该次以流程规则处理，未落运行时约束）。
- Feature：EXEC-008
- Evidence：EXEC-008 两轮修复（第一轮 `<dataDir>/workspace`；第二轮 `defaultAgentWorkspace`：`~/.pegas/workspaces/<dataDir SHA-256 前 12 位>`，`src/core/config.ts`、`src/desktop/runtime.ts`）；`test/config.test.ts`（checkout 树外断言 + 按 dataDir 互异）、`test/desktop-runtime.test.ts` 回归均在旧默认值上失败；`scripts/smoke.mjs` Run 快照 workspace 位置断言；真实 DSH 探针 Run 9d2cd0f7 输出（Agent 逐字引用仓库规则）；Cindy/Hermes 位置隔离一手源码调研（本地研究记录）。
- Seen：2（2026-11-19 见 LESSON-20261119-03；2026-11-23 用户报告开发文档被运行时加载，同日两轮修复属同一事件不重复计数）
- Severity：normal
- Status：Candidate
- Enforcement：尚未晋升；已有 config/desktop 回归与 smoke 快照断言守住 workspaceRoot 一处（断言 workspace 在 checkout 树外，而非仅"等于某派生路径"）。第三个独立日期出现时晋升，并评估把「默认目录物理隔离于 checkout」扩展为对 `selfChangeRepositoryRoot` 等其余 `resolve('.')` 默认值的统一检查（self-change 显式指仓库属预期，需区分）。
- Owner / next action：再次出现同类默认目录泄漏时晋升本 Lesson；显式覆盖指向仓库子目录的场景已在 `.env.example` 警示，属用户主动授权。

### LESSON-20261123-02：跨进程送达的凭证必须有真实执行链路端到端验证

- Rule：凡执行合同要求 Executor 使用的凭证/能力，不能只验证「注入了子进程环境」，必须验证它在 Executor 实际使用的工具（模型 bash shell）里可获取——中间层（如 DSH `dsh-subprocess` 的 `SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i`）会按名字剥掉凭证形环境变量。含敏感词命名的凭证必须同时提供不触发过滤的第二通道（如 0600 capability 文件 + 非敏感词路径环境变量），并有模拟中间层过滤行为的端到端回归。
- Why：SCHEDULE-001 周期入口上线后真机验证失败：Worker 正确注入 `PEGAS_RUN_CLAIM_TOKEN`，既有测试用 fakeDsh 直读 `process.env` 全绿，但 DSH bash 工具经 `scrubbedParentEnv()` 剥掉 TOKEN 形变量，真实 Executor 在 shell 里拿不到 claim，创建 Automation 403，模型转而空转 60+ 步找凭证。同一断点也影响既有 approvals/collaborations/follow-ups/goal-proposals 合同（此前 smoke 全部用 echo-test executor，从未走真实 DSH shell 调用 run-capability API）。
- Feature：SCHEDULE-001（同样约束 EXEC-003/APPROVAL-001/CONV-006 的 run-capability 通道）
- Evidence：线上 Run e2f6df78（activity 记录 bash env 无 claim、POST 403）；DSH `dsh-subprocess/src/index.ts` `SENSITIVE_ENV_PATTERN` 与 `scrubbedParentEnv()`；修复 `createRunCapabilityFile` + `PEGAS_RUN_CAPABILITY_FILE`（src/executor/dsh-cli-executor.ts）；`test/dsh-cli-executor.test.ts` 3 项新回归（capability 文件内容/退出清理/模拟 scrub 的子进程可读）+ `test/run-automations.test.ts` 端到端（scrubbed shell 读文件→真实 HTTP 201→落盘）。
- Seen：1（2026-11-23）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升；已有模拟 DSH scrub 行为的端到端回归守住 claim 通道。若其他凭证（approval grant、privacy key 等）再因中间层过滤不可达，按同类计数。
- Owner / next action：CONV-006 接线时复核 chat lane 只读通道同样经 capability 文件可达；评估把「真实 DSH probe 验证 run-capability API」纳入发布 checklist。

<!--
### LESSON-YYYYMMDD-NN：简短标题

- Rule：
- Why：
- Feature：
- Evidence：
- Seen：1（YYYY-MM-DD）
- Severity：normal
- Status：Observed
- Enforcement：尚未晋升
- Owner / next action：
-->
