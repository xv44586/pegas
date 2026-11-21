# Pegas MVP 计划

> 状态：In Progress
> 更新日期：2026-11-20

## MVP 验证目标

一个用户只通过单一对话入口连续提出多个事项，即使最初意图尚不完整，Pegas 也能正确分流、共同形成可验收目标、持久执行、跨重启恢复，并通过 evidence 而不是处理日志交付结果。需要判断时用户可以通过手机完成确认；Pegas 修改自身时，失败不能同时破坏唯一的恢复入口。

## 已建立的工程地基

- [x] Node.js / TypeScript / pnpm 工程；
- [x] format、lint、typecheck、unit test、build 和 smoke test；
- [x] 覆盖率下限、dead-code 检查和 Feature Map 开发协议；
- [x] GitHub Actions CI 门禁；
- [x] SQLite 初始 schema；
- [x] 持久 Event Inbox、来源去重和 Worker lease；
- [x] 最小 HTTP Event API 与 bearer token 边界；
- [x] 用户消息创建 Task 和 Outbox 记录的纵向闭环；
- [x] 持久 Routing Decision 和幂等 Run 创建；
- [x] Run lease、并发执行和过期接管；
- [x] DSH headless Adapter、NDJSON 结果判定和 session ID 持久化；
- [x] 显式 Task continuation 复用原 DSH session；
- [x] 可选 Model Router 与确定性降级；
- [x] 常见供应商目录、OpenAI/Anthropic 协议与自定义控制面 Model Provider；
- [x] Outbox lease、重试、失败封顶和 Webhook Dispatcher；
- [x] 受认证的 Agent 主动消息写入 API；
- [x] 独立 Supervisor 进程；
- [x] Release 状态、候选观察期和回滚模型；
- [x] 独立 Recovery API 的状态、重启和回滚端点；
- [x] 自动化测试与端到端 smoke test；
- [x] Router 只做 Task 归属，实际 Agent 基于真实工具生成执行确认。

这些能力目前是可运行骨架，不代表完整产品功能。Control Plane 默认只允许本机访问，尚未提供可直接使用的移动端界面。

## 第一条真实产品闭环

- [ ] Channel & Identity Gateway；
- [ ] 单用户认证和移动端设备登录；
- [ ] 同一用户的 Router lease / fencing；
- [ ] 新建、补充、纠正和取消 Task 的完整路由；
- [ ] 从自由文本或语音形成带 revision 的 Goal Contract，只追问会改变结果、权限、成本或风险的关键未知项；
- [ ] Task 与 Run 完整状态迁移；
- [x] success criteria、EvidenceRef 与 Control Plane 完成门禁；
- [x] 第一版 DSH headless Executor Adapter；
- [x] Run 与 DSH session 映射及租约过期恢复；
- [x] Outbox dispatcher 与一个真实投递渠道；
- [ ] Outbox Review Pack：按完成条件聚合结果 evidence、限制、风险、回滚和审计入口；
- [ ] 图片、视频、UI 和排版变化的最终视觉 evidence 预览；
- [x] Activity/Task 只读视图；
- [ ] 结构化日志、指标和错误追踪。

## 长期运行闭环

- [ ] Follow-up 对话式自动化；
- [x] 一次性与固定间隔 Schedule；
- [x] Scheduler 事务性写入 Event Inbox；
- [x] Approval 持久等待、释放 Worker 和事件恢复；
- [x] Action idempotency 与未知副作用处理（已接入协议的 Executor；通用 DSH tool-call 代理待补）；
- [x] Memory 来源、修正、删除和按需加载（服务端闭环；自动抽取与 Web 写操作待补）；
- [ ] SQLite 备份、校验与恢复演练；
- [ ] Worker、网络和数据库故障注入测试；
- [ ] Outbox 的重试、合并、静默时段和未知投递处理。

## 自我修改闭环

- [ ] SelfChange Task 类型与风险策略；
- [ ] 隔离 worktree / sandbox 创建和清理；
- [ ] Pegas 生成修改后强制运行完整 CI；
- [ ] 将 commit 构建成不可变 Release；
- [ ] Release manifest、产物校验值和 schema 兼容范围（Candidate evidence 校验已完成，artifact 打包与签名待实现）；
- [ ] 发布前自动备份；
- [ ] Candidate readiness 和关键路径 smoke test；
- [ ] Supervisor 原子切换、观察期和自动回滚；
- [ ] 发布后从持久 Task 恢复并向用户汇报；
- [ ] 破坏性 migration 的单独审批。

## 手机长期使用闭环

- [ ] 响应式 Web/PWA 或第一种消息渠道；
- [x] 可靠主动通知（Webhook；iOS APNs 待接入）；
- [ ] 对话、任务状态和审批跨设备一致；
- [ ] Mac 执行节点注册、心跳和离线状态；
- [ ] Remote Sandbox 执行节点；
- [ ] 独立 Recovery API 的移动端状态、重启和回滚界面；
- [ ] 主机级外部健康检查和离线告警。

## MVP 完成定义

以下场景必须自动化验证：

1. 用户连续发送多个话题，系统正确新建或更新对应 Task；
2. 在事件领取、工具调用和结果写回的不同位置杀死进程，重启后不丢任务、不重复副作用；
3. 用户在手机端完成 Approval，原 Task 从持久恢复点继续；
4. Mac 执行节点离线时，本地 Action 明确等待，其他 Task 不被阻塞；
5. Pegas 在隔离环境修改自身，候选版本通过后接管服务；
6. 候选版本无法启动时，Supervisor 自动回滚且 Recovery API 始终可用；
7. 数据备份能够在空环境中恢复并继续处理未完成 Task。
8. 用户只给出模糊愿望或失败样例时，Executor 形成可纠正的 Goal Contract；Router 不越界回答业务问题或判断工具能力。
9. Worker 声称 `ready` 但缺少当前 Goal revision 的必需 evidence 时，Task 不完成；补齐证据后生成按 criterion 组织的 Review Pack。
10. 视觉结果发生变化时，Outbox 可以预览绑定最终 Artifact revision 的截图、关键帧或页面渲染；旧 revision、错误视口或敏感未脱敏证据被拒绝。
11. 用户从 Review Pack 可以判断目标是否达成，并能按需进入 Channel 查看代码与处理过程；默认 Outbox 不被执行日志淹没。
