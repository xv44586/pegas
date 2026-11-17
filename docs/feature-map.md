# Pegas Feature Map

> 状态：Living Document
>
> 更新日期：2026-11-17

Feature Map 是 Pegas 的功能事实索引。任何功能开发开始前先查这里和代码，确认能力是否已经存在、权威实现在哪里、还缺什么；功能合入时必须同步更新对应条目。它不代替 Issue 或路线图，而是防止同一能力被不同入口重复实现。

## 状态定义

- **Planned**：只有明确需求，尚未形成可运行实现。
- **Scaffold**：接口或骨架已存在，但还不能构成用户闭环。
- **Partial**：主要路径可运行，关键场景、可靠性或体验仍缺失。
- **Usable**：目标场景可使用，有自动化验证和明确的事实来源。
- **Hardened**：经过故障、恢复、安全和运维验证，可长期依赖。

## 能力地图

| ID           | 用户能力 / 产品承诺                                              | 状态    | 权威实现                                                        | 自动化证据                                                | 下一缺口                                  |
| ------------ | ---------------------------------------------------------------- | ------- | --------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| CONV-001     | 所有端通过统一事件入口与同一个 Pegas 对话                        | Partial | `src/control-plane/server.ts`, `src/storage/sqlite-store.ts`    | `test/control-plane.test.ts`, `test/sqlite-store.test.ts` | 设备身份、附件、跨端游标                  |
| CONV-002     | Web 端以自然对话为主入口，并可查看任务详情                       | Usable  | `web/src/App.tsx`, `web/src/api.ts`                             | `web/src/App.test.tsx`, smoke test                        | 流式更新、PWA、完整移动端适配             |
| CONV-003     | 消息送达与处理状态作为界面元数据展示，不伪装成 Agent 回复        | Usable  | `web/src/App.tsx`, Inbox Event status                           | `web/src/App.test.tsx`, `test/control-plane.test.ts`      | 更细的失败恢复操作                        |
| ROUTE-001    | 默认由模型判断创建新 Task 或继续已有 Task                        | Usable  | `src/router/router.ts`, `src/model/*`                           | `test/router.test.ts`, Provider tests                     | steer、取消、Idea、Trigger 等控制意图     |
| ROUTE-002    | Router 只判断任务归属，不判断执行工具能力、不直接代替 Agent 回复 | Usable  | `src/worker/processor.ts`, Router schema                        | `test/processor.test.ts`, `test/router.test.ts`           | 多活 Worker 下的用户级 fencing            |
| TASK-001     | Task 和 Run 拥有持久、可查询的生命周期                           | Usable  | `src/storage/sqlite-store.ts`                                   | `test/sqlite-store.test.ts`, `test/processor.test.ts`     | 完整状态机、依赖、暂停和取消              |
| EXEC-001     | DSH headless 执行任务并持久化 session，可继续同一任务            | Usable  | `src/executor/dsh-cli-executor.ts`                              | `test/dsh-cli-executor.test.ts`, `test/processor.test.ts` | 进程内 Controller、结构化 Run Event       |
| EXEC-002     | 真正拥有工具的 Agent 在实质执行前生成一次具体确认                | Usable  | DSH Adapter progress event、Worker Outbox                       | `test/dsh-cli-executor.test.ts`, `test/processor.test.ts` | 将更多中间事件写入 Activity，而非聊天流   |
| EXEC-003     | Worker 失败后按 lease 和已保存 session 恢复                      | Partial | `src/storage/sqlite-store.ts`, `src/worker/*`                   | Store 与 processor tests                                  | 工具调用点故障注入、未知副作用处置        |
| NOTIFY-001   | 结果、问题和阻塞经可靠 Outbox 主动送达                           | Usable  | `src/storage/sqlite-store.ts`, `src/notification/dispatcher.ts` | `test/notification.test.ts`                               | 消息合并、静默时段、优先级                |
| NOTIFY-002   | Webhook 作为首个真实主动通知通道                                 | Usable  | `src/notification/webhook-channel.ts`                           | `test/notification.test.ts`, smoke test                   | Web Push、APNs                            |
| RECOVERY-001 | 独立 Supervisor 提供状态、重启、候选版本和回滚生命线             | Partial | `src/supervisor/*`                                              | Supervisor tests、smoke test                              | 真实切换与故障演练                        |
| SELF-001     | Pegas 在隔离环境修改、验证、发布并在失败时回滚自身               | Planned | 架构约束见 `docs/architecture.md`                               | 暂无                                                      | SelfChange Task、worktree、不可变 Release |
| APPROVAL-001 | 高风险动作可持久等待用户审批后恢复                               | Planned | 领域设计见 `docs/architecture.md`                               | 暂无                                                      | Approval 对象、策略与恢复事件             |
| SCHEDULE-001 | 定时、周期和条件触发事项独立于聊天 session                       | Planned | 领域设计见 `docs/architecture.md`                               | 暂无                                                      | Trigger 与 Scheduler                      |
| MEMORY-001   | 长期偏好和事实带来源、范围与删除路径                             | Planned | 领域设计见 `docs/architecture.md`                               | 暂无                                                      | Memory schema 与装载策略                  |
| MOBILE-001   | iOS 客户端共享对话、任务、审批和通知                             | Planned | 服务端接口边界已建立                                            | 暂无                                                      | 登录、APNs、iOS UI 与恢复入口             |
| QUALITY-001  | 格式、Lint、类型、测试、构建和 smoke 由 CI 统一阻断              | Usable  | `package.json`, `.github/workflows/ci.yml`                      | `pnpm check`, `pnpm smoke`                                | 分支保护与发布门禁                        |
| QUALITY-002  | 覆盖率下限和无用代码检查防止质量倒退                             | Usable  | `vitest.config.ts`, `knip.json`                                 | `pnpm test:coverage`, `pnpm deadcode`                     | 逐步提高阈值、补 UI 与 Recovery 测试      |

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
