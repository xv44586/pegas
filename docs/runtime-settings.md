# 运行设置中心

> Feature：`SETTINGS-001`
>
> 状态：可用闭环
>
> 更新日期：2026-11-19

## 用户结果

用户从 Pegas 设置页统一选择任务 Router、模型 Provider、Router 模型与 Agent 模型，并控制模型出站
脱敏和语音/文字输入改写。模型入口不依赖 Codex 或其他本机 Agent 登录态：Pegas 提供
常用供应商预设，也允许添加任意 OpenAI-compatible 或 Anthropic-compatible 入口。设置由
服务端持久化，Web 和未来原生客户端只通过同一 API 读取与修改；新的消息和 Run 无需
重启 Worker 即可使用最新版。

## 验收条件

1. 设置页展示并保存 Router 模式、Provider、对应模型名、脱敏策略和输入改写策略；
   保存成功后显示服务端 revision 与更新时间。
2. 新实例默认启用模型 Router，以本机 Magpie 和 `discovery-api/deepseek-v4.1-flash-1017` 作为默认连接，并包含 OpenAI、Anthropic、Google Gemini、DeepSeek、xAI、Kimi、
   智谱 GLM、MiniMax、阿里云百炼、OpenRouter、Groq、Mistral、SiliconFlow、Ollama
   与 LM Studio；预设提供协议和 Base URL，模型名始终可编辑。
3. 自定义 Provider 支持名称、OpenAI Chat Completions 或 Anthropic Messages 协议、
   Base URL、模型名和可选 API key。API key 只接受写入和显式清除，响应仅返回是否已
   配置；持久化值使用实例级凭证密钥加密。
4. 设置存入 SQLite 单例记录。首次启动用环境变量生成默认记录，后续重启不得用环境
   变量覆盖用户已保存的选择。
5. Worker 在处理每条新事件和领取每个 Run 时读取当前设置；已经开始的调用不被中途
   切换，下一次调用使用新 revision。
6. API 只接受完整、合法且与服务端能力相符的设置。需要模型的 Router 或改写模式必须
   选择一个可用连接；规则路由允许在尚未配置模型时工作。
7. API key、实例凭证密钥、隐私 HMAC key 和 DSH profile 等服务端凭证不通过设置 API
   返回，也不保存到浏览器。Base URL 作为连接元数据返回，便于确认当前出站目标。
8. 轻量改写只生成 Router/Executor 使用的执行视图，不修改 Conversation Event 原文；
   改写模型不可用或返回无效结果时回退原文，脱敏失败仍然禁止出站。
9. 旧的 Codex 登录态设置迁移为规则路由和 OpenAI 预设，不再假设机器安装或登录
   Codex。旧 `openai-compatible` 环境配置迁移为自定义连接；回滚时新增表可保留。
10. 已配置或正在编辑的 Provider 可以从兼容的模型目录接口获取模型列表；列表获取失败
    不覆盖手工输入，界面给出可恢复错误。模型测试必须使用当前 Provider、凭证和精确
    模型名执行最小结构化请求，并返回成功状态与耗时。
11. Router 模型与 Agent 模型在界面和持久化中分别命名。Router 与轻量改写只使用
    Pegas Provider；Agent 默认使用当前 Router 连接与模型，也可以选择事情级
    provider/model 覆盖。两者都必须引用已保存的 Pegas 模型连接：Worker 把连接
    目录与所选模型生成受管 DSH 配置（EXEC-007），所选 provider 未配置连接时
    执行失败并提示先保存连接，不回落本机 DSH 配置。
12. Agent 模型覆盖只应用于新建 DSH session 的模型快照。已有 Task 恢复原 session
    时按保存的快照生成同一份受管配置，避免同一个恢复链路中途切换模型；保存设置
    不会中断正在执行的 Run。
13. 获取模型目录后立即展示可搜索、可点选的模型列表；选择仅更新尚未保存的 Router 模型，仍需用户保存。目录为空或获取失败时保留手动填写模型 ID 的路径；更换连接配置时清除过期目录。
14. 模型测试结果先给出可理解的结论与下一步：连接正常时显示响应时间；404、鉴权失败、限流和服务故障分别提示模型选择、密钥权限、额度与稍后重试。供应商原始错误不得直接铺到页面或回显凭证。
15. 开启轻量改写后可选择沿用 Router 模型，或填写独立的协议、API 根地址、模型名和可选密钥。测试使用未保存的表单值与可编辑示例文本，返回原文、改写结果及耗时；不保存设置，不写入 Conversation 或 Event。
16. 独立改写连接与运行设置同一事务保存，密钥加密且不回显；旧设置默认沿用 Router。切换连接地址时不得把旧地址的密钥发送到新地址。测试失败显示可操作的归类提示；运行时改写失败回退原文，脱敏失败仍禁止出站。
17. 新实例在用户没有显式指定模型时，从 Magpie `http://127.0.0.1:3425/v1/models` 优先选择已通过真实连接探测的 `discovery-api/deepseek-v4.1-flash-1017`；目录不含该模型时选择第一个可用模型，目录不可达时继续使用该已知 fallback，不覆盖已保存选择。设置页将 Magpie 放在常用供应商首位，Gemini 放入“更多供应商”。
18. 模型目录按每页 20 项完整分页，搜索后从第一页重新计算范围。搜索框占满模型面板可用宽度，并为搜索图标、占位文字、输入文本、清除按钮和焦点环保留独立空间。

## 数据与权限边界

```text
Web / native settings UI
  -> authenticated Control Plane PUT /v1/settings
  -> SQLite runtime_settings (server authoritative)
  -> Worker reads revision before event/run
  -> rewrite view -> Router / Executor

Environment / encrypted provider connection store
  -> provider addresses and encrypted credentials
  -> privacy HMAC key
  -> capability checks only; never returned to clients
```

运行设置是当前 Pegas 实例的全局单例，适合现阶段单用户部署。未来多租户化时需要增加
scope 与 owner，不应把当前表误当作用户偏好表。

即时应答车道（PLAN-001 P1，ROUTE-004/EXEC-005）由 `chatLaneEnabled` 控制，默认关闭。
新实例可用 `PEGAS_CHAT_LANE=on` 生成开启的默认记录；此后以服务端保存值为准，
`PUT /v1/settings` 省略该字段时保留现值（不会因旧客户端保存而意外关闭）。关闭后
reply 决策兜底为完整 Task，行为回到现状；历史 conversation Task 数据保留可读。
chat 车道的并发预算独立于重任务：`PEGAS_CHAT_CONCURRENCY`（默认 1）只影响本进程
领取 conversation Run 的数量，不进入运行设置单例。Web 设置页开关属后续缺口，当前
经环境变量（首次启动）或设置 API 启停。

执行池（PLAN-001 P3 第一阶段，WORKER-002）在“Pegas”页 Agent 模型区配置：
fast/balanced/deep 三池各指向一个已配置的 provider/model，允许只配 1–3 个，
未配置的池按 fast→balanced→全局 Agent 默认降级，降级原因记入 Run 快照；
三池全空且无全局默认时显式拒绝执行，不静默换模型。事情详情在“继承全局设置”
模式下可为单个 Task 选择执行池与推理 effort，与模型覆盖互斥；effort 仅在
存在生效模型时随 DSH patch 透传。保存省略 `executionPools` 字段时保留现值。
密钥/权限/模型不存在类 Provider 错误首次即停放 Task（awaiting_provider_condition）
并通知用户，修正模型连接或池设置后再继续；限流与服务故障仍走既有重试链。

## 保存、失败与恢复

- PUT 使用客户端读到的 `revision` 做乐观并发控制；revision 不一致返回冲突，避免旧
  页面覆盖新设备刚保存的设置。
- Provider 连接与设置保存使用同一事务更新；校验失败或 revision 冲突时原记录和凭证均
  保持不变。
- Worker 每次只读取一个完整快照。设置变更不终止已经进行的模型调用或 Run。
- Agent 模型配置（连接目录 + 默认模型）通过受管临时 DSH patch 注入每次执行与
  模型目录读取；patch 文件在子进程退出后删除，明文 key 只经子进程环境传递。
  恢复已有 session 时忽略当前覆盖并按保存的模型快照重建配置。DSH 运行在
  `<dataDir>/dsh` 隔离 home 内（`PEGAS_DSH_HOME` 可覆盖），不读写本机 `~/.dsh`。
- Agent 执行工作区默认是 `<dataDir>/workspace`（`PEGAS_WORKSPACE_ROOT` 可显式
  覆盖），Worker 启动时幂等创建。工作区与代码 checkout 分离：DSH 会从 cwd 向上
  加载 AGENTS.md 风格指令文件，把工作区指向开发仓库会把开发文档误当作 Agent
  自身指令。既有 Run 的 workspace 快照不可变，改默认值只影响新 Run。
- 凭证密钥位于数据目录的权限受限文件；文件缺失或密文损坏时连接标记为不可用，不用
  空值覆盖密文，也不把解密错误降级为明文读取。
- 回滚应用版本不需要删除新增连接表；旧版本继续读取环境变量。恢复新版本后再次读取
  已保存设置。

## 非目标

- 不提供余额查询、持续延迟监控、故障转移或多账号轮换。
- 不把隐私 HMAC key、实例凭证密钥或 DSH profile 做成浏览器可编辑字段。
- 不提供按 Conversation、Task 或用户分别覆盖模型的规则；Agent 覆盖是实例级默认值。
- 不支持改写模板市场、复杂提示词编辑器或 LLM 识别语义 PII。
- 改写测试不代表持续健康监控，也不会自动替用户发送测试文本。

## Web 分类页

设置在独立页面，分类顺序为 Pegas、模型服务、任务路由、语音与输入、隐私。切换保留未保存编辑；顶部只保留一个“设置”标题。“模型服务”只配置 Router 模型、Provider、连接凭证、模型发现与测试；Agent 执行模型只在“Pegas”页出现，凭证不回显到客户端。

模型目录在 Web 端用于辅助选择，不自动改写服务端设置。列表支持按名称或 ID 搜索并按每页 20 项完整分页；搜索结果重新分页并显示范围。当前手填 ID 不在目录中时提醒用户，但不阻止测试或保存，因为部分兼容服务的目录可能不完整。连接测试采用当前未保存的表单值，错误反馈仅显示归类后的指导信息。当前设置 API 会把上游探测失败包装为 HTTP 400，Web 从已知上游错误前缀提取实际状态码用于提示分类，不展示整段上游响应。

语音与输入页另设服务端 ASR 连接。开关、地址、模型和可选密钥与其他设置共用 revision 和保存按钮；密钥使用实例凭证密钥加密，API 只返回是否已配置。新实例默认连接 `http://127.0.0.1:18081/v1` 的 `Qwen/Qwen3-ASR-0.6B`，`PEGAS_SPEECH_*` 环境变量可在首次启动时覆盖这些初始值，重启不覆盖用户选择。未配置时麦克风入口直接打开语音设置，不申请录音权限。

轻量改写默认沿用 Router 连接。选择独立服务时，协议、API 根地址、模型和加密密钥与运行设置同一事务保存。`POST /v1/settings/rewrite/test` 使用未保存表单值执行一次真实改写，只返回原文、结果和耗时，不保存设置或写入 Conversation Event。当前隐私脱敏已开启时，测试仍需脱敏。仅当目标地址与已保存地址一致时复用密钥；改地址需重新填写。

数据库迁移 v5 添加 Provider 连接，v6 添加 Agent 模型覆盖，v7 添加 Task 重试字段，v8 添加语音服务连接，v9 添加改写服务连接。早期独立 UI 候选版曾将 Task 重试占用 v5；启动时只对检测到重试字段且缺少 Provider 字段的数据库修正迁移编号，再依次应用 Provider 与 Agent 迁移。重复启动不会重复添加字段；回滚需同时恢复对应版本的数据库备份。
