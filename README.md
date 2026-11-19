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
- [Feature Map](docs/feature-map.md)
- [Feature Review 门禁](docs/feature-review-gate.md)
- [贡献与质量门禁](CONTRIBUTING.md)

## 本地验证

需要 Node.js 22.19+ 或 24+，以及 pnpm 11：

```bash
pnpm install
pnpm check
pnpm smoke
```

`pnpm check` 包含格式、Lint、类型、无用代码、覆盖率阈值和生产构建检查。所有 Feature 在开发前后都需要同步 [Feature Map](docs/feature-map.md)，以复用既有能力并保持唯一事实来源。PR 会为准确提交自动生成 7 天有效的审核报告和 UI 截图；运行结果位于 `output/feature-review/`，不会提交到主分支。

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

Router 默认通过 Magpie 模型判断未指定 Channel 的输入应新建任务还是续接已有任务；显式 Channel/Task 引用仍按确定性路径处理，模型不可用或输出无效时安全降级为新建任务。可在 Web 设置页选择其他供应商、自托管服务或自定义兼容入口，并由 Pegas 保存连接：

```bash
PEGAS_ROUTER=model
PEGAS_MODEL_PROVIDER=magpie
PEGAS_MODEL_BASE_URL=http://127.0.0.1:3425/v1
```

新实例默认连接本机 Magpie `http://127.0.0.1:3425/v1`，优先使用已通过真实连接探测的 `discovery-api/deepseek-v4.1-flash-1017`；实时目录没有该模型时才回退到第一个可用模型。设置页同时内置 OpenAI、Anthropic、Gemini、DeepSeek、xAI、Kimi、GLM、MiniMax、通义千问、OpenRouter、Groq、Mistral、SiliconFlow、Ollama 和 LM Studio，并支持 OpenAI Chat Completions 或 Anthropic Messages 协议的自定义连接。Gemini 收纳在“更多供应商”中。模型不可用或输出无效时，Router 会安全降级为创建独立 Task。

这里的 Provider 只负责 Router 控制面归属判断；默认模型用于提高新建、续接和拆分判断的可靠性，不代表 Router 执行任务内容。DSH 执行任务时使用的模型、凭证和 Provider 仍由 DSH profile 自己管理，两者不会共享隐式 session 或配置。

首次启动后，Router 模式、Provider、对应模型名、脱敏和输入改写由 Web 设置页统一管理，
并保存在服务端 SQLite 中。以上环境变量只用于初始化第一版默认值；用户保存过设置后，
重启不会用环境变量覆盖。API key 使用实例密钥加密后保存在服务端，设置 API 只返回是否已配置，不返回明文或密文；隐私 HMAC key 同样不会返回。详见 `docs/runtime-settings.md`。

如需在用户内容离开 Pegas Worker 前屏蔽高置信度密钥、密码、邮箱和手机号，可开启
模型出站脱敏。HMAC key 只用于生成稳定占位符，必须作为服务端密钥保存：

```bash
PEGAS_PRIVACY_MODE=mask
PEGAS_PRIVACY_HMAC_KEY=replace-with-a-stable-random-secret
PEGAS_REWRITE_MODE=disabled
```

脱敏同时覆盖 Router provider 和 DSH Executor 的初始 prompt；DSH 执行中的文件与
工具结果仍需由其 provider gateway 保护。详细边界和回滚方式见
`docs/privacy-masking.md`。

Web 输入器支持类似 Codex 的听写：点击麦克风录音，再次点击结束，转录文字会先回填草稿供校对，只有用户点击发送后才进入 Conversation。ASR 作为独立的 OpenAI-compatible 模型服务部署，Control Plane 只依赖其 HTTP 契约：

```bash
PEGAS_SPEECH_PROVIDER=openai-compatible
PEGAS_SPEECH_BASE_URL=http://127.0.0.1:18081/v1
PEGAS_SPEECH_API_KEY=replace-me
PEGAS_SPEECH_MODEL=Qwen/Qwen3-ASR-0.6B
```

仓库内的 Qwen3-ASR GPU 服务、远程 SSH 转发和验证方式见 [services/asr/README.md](services/asr/README.md)，听写数据与失败边界见 [docs/voice-input.md](docs/voice-input.md)。

受认证的客户端或 Agent 也可以向 `POST /v1/outbox` 写入带稳定 `dedupeKey` 的消息。Dispatcher 会以租约领取、失败重试并携带 `Idempotency-Key` 投递；未来 iOS/APNs 只需实现新的 Notification Channel，不改变任务和 Outbox 语义。

## 最重要的产品判断

Conversation 是用户输入流，Task 才是工作的生命周期。

Pegas 可以在内部创建任意数量的 session、worker 或 sub-agent，但这些都属于实现细节。用户始终只面对同一个 Pegas；可选的任务中心用于查看和接管，而不是要求用户进行日常维护。
