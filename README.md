# Pegas

Pegas 是一个以自然对话为统一入口的个人智能代理。

你只需要表达目标、需求或灵感；Pegas 负责理解上下文、组织任务、调用工具、持续执行，并在需要你参与时回来找你。用户不需要管理 session、模型、工作流或执行进程。

名字来自《宇宙骑士 BLADE》中的支援机器人 Pegas（柏卡斯）：它不是主角本身，而是承接意图、提供能力并帮助完成“变身”的长期搭档。

## 核心承诺

- 一个持续存在的 Pegas：Web、App、macOS 和消息渠道共享身份、任务和记忆。
- 对话是唯一必需的入口：用户可以随时插入新想法，不必先分类或切换工作区。
- 后台自动管理多个任务：识别新任务、旧任务补充、临时想法、周期事项和等待条件。
- 长任务可以跨进程、跨设备、跨时间继续运行，失败后能够恢复。
- 只在有阶段成果、需要决策、遇到阻塞或完成时主动联系用户。
- 自主性服从风险边界：权限、审批、执行记录和撤销能力是产品的一部分。

## 当前阶段

项目目前处于 MVP 验证阶段。仓库已经包含最小 Control Plane、SQLite 持久层、模型 Router、可恢复 Run Worker、DSH headless Adapter、可靠 Outbox/Webhook Dispatcher、独立 Supervisor、恢复 API、React Web 客户端和 CI 骨架。第一阶段以 DSH 作为 Agent Runtime，Pegas 自己维护产品领域与任务控制层。

- [产品定位](docs/product-positioning.md)
- [系统架构](docs/architecture.md)
- [MVP 计划](docs/mvp-plan.md)

## 本地验证

需要 Node.js 22.19+ 或 24+，以及 pnpm 11：

```bash
pnpm install
pnpm check
pnpm smoke
```

启动开发进程：

```bash
pnpm build
pnpm start:supervisor
```

单独开发 Web 客户端时，分别启动 Control Plane、Worker 和 Vite：

```bash
pnpm dev
pnpm dev:worker
pnpm dev:web
```

如需让 Agent 主动投递消息，再配置 Webhook 并启动 Dispatcher：

```bash
PEGAS_PUSH_MODE=webhook \
PEGAS_PUSH_WEBHOOK_URL=https://example.com/pegas \
pnpm dev:notification
```

Web 开发服务器默认位于 `http://127.0.0.1:4319`，并将 API 请求代理到 `http://127.0.0.1:4317`。生产构建由 Control Plane 在同一地址直接提供。

默认情况下 Control Plane 和 Recovery API 只监听本机回环地址。对外暴露任何接口前必须配置独立访问令牌。

Worker 默认通过 DSH headless 执行 Run。自动化测试使用显式的 `PEGAS_EXECUTOR=echo`，不会调用模型；生产或人工验证不能使用该测试执行器。

Router 默认使用本机 Codex CLI 的登录态和 `gpt-5.6-luna`，判断一条新消息是在继续已有 Task，还是应该创建新 Task；无需向 Pegas 复制 Codex 凭证：

```bash
PEGAS_ROUTER=model
PEGAS_MODEL_PROVIDER=codex-cli
PEGAS_CODEX_COMMAND=codex
PEGAS_MODEL_NAME=gpt-5.6-luna
```

Codex Provider 以 ephemeral、read-only、无项目规则的非交互进程运行，并关闭 Router 不需要的 Apps、Plugins、Hooks 和模型发现，只接收任务摘要并按 JSON Schema 输出。模型不可用或输出无效时，Router 会安全降级为创建独立 Task。测试或离线开发可显式设置 `PEGAS_ROUTER=rules`；如需接入其他服务，也可切换到 `openai-compatible` 并提供 Base URL、模型和可选 API Key。

这里的 Provider 只负责 Router 等轻量控制面判断。DSH 执行任务时使用的模型、凭证和 Provider 仍由 DSH profile 自己管理，两者不会共享隐式 session 或配置。

受认证的客户端或 Agent 也可以向 `POST /v1/outbox` 写入带稳定 `dedupeKey` 的消息。Dispatcher 会以租约领取、失败重试并携带 `Idempotency-Key` 投递；未来 iOS/APNs 只需实现新的 Notification Channel，不改变任务和 Outbox 语义。

## 最重要的产品判断

Conversation 是用户输入流，Task 才是工作的生命周期。

Pegas 可以在内部创建任意数量的 session、worker 或 sub-agent，但这些都属于实现细节。用户始终只面对同一个 Pegas；可选的任务中心用于查看和接管，而不是要求用户进行日常维护。
