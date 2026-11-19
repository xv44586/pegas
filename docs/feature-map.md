# Pegas Feature Map

> 状态：Living Document
>
> 更新日期：2026-11-19

Feature Map 是 Pegas 的功能事实索引。任何功能开发开始前先查这里和代码，确认能力是否已经存在、权威实现在哪里、还缺什么；功能合入时必须同步更新对应条目。它不代替 Issue 或路线图，而是防止同一能力被不同入口重复实现。

## 状态定义

- **Planned**：只有明确需求，尚未形成可运行实现。
- **Scaffold**：接口或骨架已存在，但还不能构成用户闭环。
- **Partial**：主要路径可运行，关键场景、可靠性或体验仍缺失。
- **Usable**：目标场景可使用，有自动化验证和明确的事实来源。
- **Hardened**：经过故障、恢复、安全和运维验证，可长期依赖。

## 能力地图

| ID           | 用户能力 / 产品承诺                                                                | 状态     | 权威实现                                                                                                                             | 自动化证据                                                                                                                     | 下一缺口                                     |
| ------------ | ---------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| CONV-001     | 所有端通过统一事件入口与同一个 Pegas 对话                                          | Partial  | `src/control-plane/server.ts`, `src/storage/sqlite-store.ts`                                                                         | `test/control-plane.test.ts`, `test/sqlite-store.test.ts`                                                                      | 设备身份、附件、跨端游标                     |
| CONV-002     | Web 端以 DS Bot 壳层呈现 Task、对话与可关闭工作区                                  | Usable   | `web/src/App.tsx`, `web/src/DsBotIcons.tsx`, `web/src/workspace-theme.css`, `web/src/api.ts`, `DESIGN.md`                            | Task=Bot/显式 taskId、语音草稿、Markdown、单按钮收缩 rail 与工作区定位回归；桌面、938px 与移动截图；`pnpm check`, `pnpm smoke` | Task 级模型配置、流式更新、附件、PWA         |
| CONV-003     | 消息送达与处理状态作为界面元数据展示，不伪装成 Agent 回复                          | Usable   | `web/src/App.tsx`, Inbox Event status                                                                                                | `web/src/App.test.tsx`, `test/control-plane.test.ts`                                                                           | 更细的失败恢复操作                           |
| CONV-004     | 用户发送内容链接后，Pegas 自动整理为笔记并在确认后写入 Obsidian                    | Planned  | 尚未实现；本地调研见 `research/x-bookmarks/`                                                                                         | 暂无                                                                                                                           | 链接规范化、内容抓取、卡片生成、确认写入     |
| VOICE-001    | 用户可配置并测试语音服务，在输入器中听写、校对文字，再发送给同一个 Pegas           | Usable   | `web/src/App.tsx`, `web/src/useVoiceDictation.ts`, `src/speech/*`, `src/control-plane/server.ts`, `src/storage/sqlite-store.ts`      | 新实例默认 ASR 连接、未配置引导、真实转写、密钥不回显及输入器内错误布局回归；`pnpm check`, `pnpm smoke`                        | 流式字幕、原生移动端录音、Voice Session 恢复 |
| PRIVACY-001  | 发往外部模型或 Executor 的用户内容先脱敏，返回可信边界后恢复                       | Usable   | `src/privacy/*`, Worker provider/executor wrappers                                                                                   | 8 个 privacy tests + config regressions；`pnpm check`, `pnpm smoke`                                                            | 设置页、语义 PII、持久 vault 与流式恢复      |
| SETTINGS-001 | 用户在分类设置页分别选择 Router 与 Agent 模型，并管理 Provider、脱敏和输入改写策略 | Usable   | `src/settings/*`, `src/model/*`, `src/executor/dsh-model-catalog.ts`, `src/storage/sqlite-store.ts`, settings API、`web/src/App.tsx` | Magpie 默认连接/首模型选择、Provider 分组/测试、凭证篡改、可搜索选择与友好错误回归、设置持久化；`pnpm check`, `pnpm smoke`     | 多用户 scope、按 Task 覆盖、持续健康监控     |
| ROUTE-001    | 默认由模型判断创建新 Task 或继续已有 Task                                          | Usable   | `src/router/router.ts`, `src/model/*`                                                                                                | `test/router.test.ts`, Provider tests                                                                                          | steer、取消、Idea、Trigger 等控制意图        |
| ROUTE-002    | Router 只判断任务归属，不判断执行工具能力、不直接代替 Agent 回复                   | Usable   | `src/worker/processor.ts`, Router schema                                                                                             | `test/processor.test.ts`, `test/router.test.ts`                                                                                | 多活 Worker 下的用户级 fencing               |
| TASK-001     | 五状态工作项与独立 Run，失败重试保留完整执行历史                                   | Usable   | `src/storage/sqlite-store.ts`, `docs/task-lifecycle.md`                                                                              | `test/sqlite-store.test.ts`, `test/control-plane.test.ts`, Web 重试回归                                                        | 完成/取消控制入口、依赖、暂停                |
| EXEC-001     | DSH headless 执行任务并持久化 session，可继续同一任务                              | Usable   | `src/executor/dsh-cli-executor.ts`                                                                                                   | `test/dsh-cli-executor.test.ts`, `test/processor.test.ts`                                                                      | 进程内 Controller、结构化 Run Event          |
| EXEC-002     | 真正拥有工具的 Agent 在实质执行前生成一次具体确认                                  | Usable   | DSH Adapter progress event、Worker Outbox                                                                                            | `test/dsh-cli-executor.test.ts`, `test/processor.test.ts`                                                                      | 将更多中间事件写入 Activity，而非聊天流      |
| EXEC-003     | Worker 失败后按 lease 和已保存 session 恢复                                        | Partial  | `src/storage/sqlite-store.ts`, `src/core/clock.ts`, `src/worker/*`, `src/executor/dsh-cli-executor.ts`                               | 确定性 lease 边界、DSH timeout/abort/stream fault 与跨 Candidate worktree session 恢复回归                                     | 工具调用前后崩溃点、未知副作用处置           |
| NOTIFY-001   | 结果、问题和阻塞经可靠 Outbox 主动送达                                             | Usable   | `src/storage/sqlite-store.ts`, `src/notification/dispatcher.ts`                                                                      | `test/notification.test.ts`                                                                                                    | 消息合并、静默时段、优先级                   |
| NOTIFY-002   | Webhook 作为首个真实主动通知通道                                                   | Usable   | `src/notification/webhook-channel.ts`                                                                                                | `test/notification.test.ts`, smoke test                                                                                        | Web Push、APNs                               |
| RECOVERY-001 | 独立 Supervisor 提供状态、重启、候选版本和回滚生命线                               | Partial  | `src/supervisor/*`, `docs/recovery-state.md`                                                                                         | 主备损坏、checksum、degraded API tests、smoke test                                                                             | 真实切换、artifact 校验与故障演练            |
| SELF-001     | Pegas 在隔离环境修改、验证、发布并在失败时回滚自身                                 | Scaffold | `src/supervisor/candidate-manifest.ts`, `docs/candidate-evidence.md`                                                                 | exact-SHA、CI/smoke、artifact tamper tests                                                                                     | SelfChange Task、worktree、构建与切换        |
| APPROVAL-001 | 高风险动作可持久等待用户审批后恢复                                                 | Planned  | 领域设计见 `docs/architecture.md`                                                                                                    | 暂无                                                                                                                           | Approval 对象、策略与恢复事件                |
| SCHEDULE-001 | 定时、周期和条件触发事项独立于聊天 session                                         | Planned  | 领域设计见 `docs/architecture.md`                                                                                                    | 暂无                                                                                                                           | Trigger 与 Scheduler                         |
| MEMORY-001   | 长期偏好和事实带来源、范围与删除路径                                               | Planned  | 领域设计见 `docs/architecture.md`                                                                                                    | 暂无                                                                                                                           | Memory schema 与装载策略                     |
| MOBILE-001   | iOS 客户端共享对话、任务、审批和通知                                               | Planned  | 服务端接口边界已建立                                                                                                                 | 暂无                                                                                                                           | 登录、APNs、iOS UI 与恢复入口                |
| QUALITY-001  | 格式、Lint、类型、测试、构建、smoke 和经验晋升流程形成统一质量门禁                 | Usable   | `package.json`, `.github/workflows/ci.yml`, `docs/lessons.md`                                                                        | `pnpm check`, `pnpm smoke`, PR evidence checklist                                                                              | 分支保护、发布门禁、Lesson 自动 Guard        |
| QUALITY-002  | 覆盖率下限和无用代码检查防止质量倒退                                               | Usable   | `vitest.config.ts`, `knip.json`                                                                                                      | `pnpm test:coverage`, `pnpm deadcode`                                                                                          | 逐步提高阈值、补 UI 与 Recovery 测试         |

**SETTINGS-001 更新（2026-11-18）**：独立改写服务和未保存配置测试已形成 Usable 闭环。权威实现为 `src/rewrite/*`、`src/control-plane/server.ts`、`src/storage/sqlite-store.ts` 与 `web/src/App.tsx`；自动化证据包括改写草稿探测、错误脱敏、密钥地址切换、Web 测试交互回归，以及 `pnpm check` 和 `pnpm smoke`。下一缺口仍为多用户 scope、按 Task 覆盖和持续健康监控。

### CONV-002：DS Bot 交互重构验收边界（2026-11-18）

- **用户结果**：DS Bot 是 Pegas 的交互与视觉壳；DS Bot 中的一个 Bot 在 Pegas 中对应一个服务端 Task。桌面首页复用其 280px 可折叠 Task 侧栏、悬浮当前 Task 标题、960px 对话流、Markdown 气泡、48px 胶囊输入器和默认收缩的右侧工作区 tab；设置、插件及二级详情继续使用同一套弹层语言。
- **验收条件**：服务端 Task 出现在 DS Bot 风格的顶部当前 Task 卡与 Task 列表；选择 Task 后工作区在右侧展开且后续消息显式携带该 `taskId`；工作区关闭时保持为右侧 tab，展开后标题和分隔线完全位于面板内；用户主动收起左侧 rail 时只保留一个展开按钮；对话发送、IME、麦克风听写、空输入语音入口、Markdown、任务搜索、任务详情、失败重试、设置保存与错误反馈继续工作；桌面、938px 工作区展开和 390px 移动截图均无横向溢出、越线、输入框消失或不可达控件。
- **非目标**：本轮不伪造尚不存在的 Task 级模型配置持久化；当前 Agent 模型仍是实例级默认值。除已按 Apache-2.0 归属复用、且明确为后续替换预留边界的 DS Bot 图标与鲸鱼角色几何外，不复制其品牌名、产品文案或服务端领域模型；不新增客户端事实来源，不改变 Router/Executor 责任，也不改数据库和发布链路。
- **数据与权限边界**：Conversation、Task、Run 与设置仍以服务端响应为准；API key 继续只通过现有设置接口提交且不回显；Web 仅保存既有 session token 与未提交输入草稿。
- **失败与恢复**：未授权继续显示 token 恢复入口；快照加载失败可重连；发送和设置保存失败保留用户输入；执行失败保留历史并可在同一 Task 新建 Run 重试；窄屏工作区成为右侧覆盖面板，支持 Escape/显式关闭并把焦点还给触发控件。

## Feature 开发协议

每次功能开发都遵循下面的顺序：

1. **先查重**：搜索本 Feature Map、架构文档和代码，确认是否已有相同能力或事实来源。
2. **确定归属**：复用现有 ID；确实是新能力时才新增 ID，并先写清用户结果、状态和权威实现位置。
3. **保持单一事实来源**：不同端只实现交互适配，核心状态和决策不得在 Web、iOS 或 macOS 分叉复制。
4. **先定义验证**：新增或修改自动化测试；修复缺陷必须增加能复现原问题的回归测试。
5. **完成质量门禁**：至少通过 `pnpm check`；涉及进程、数据库、通知或恢复路径时同时通过 `pnpm smoke`。
6. **同步地图**：合入前更新状态、实现入口、自动化证据和下一缺口，避免把 Scaffold 误标成 Usable。

## 质量阈值策略

覆盖率阈值是防退化基线，不是目标分数。当前全局最低值记录在 `vitest.config.ts`；新增功能应保持或提高覆盖率，不通过降低阈值来让 CI 变绿。每当关键低覆盖模块补齐测试后，随同该 Feature 提高阈值。

无用文件、依赖和导出由 Knip 阻断。确有动态加载或外部入口时，应在配置中写出最窄的显式例外，并在变更说明中解释原因。
