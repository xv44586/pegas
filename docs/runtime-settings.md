# 运行设置中心

> Feature：`SETTINGS-001`
>
> 状态：可用闭环
>
> 更新日期：2026-11-17

## 用户结果

用户从 Pegas 设置页统一选择任务 Router、模型 Provider 与模型名，并控制模型出站
脱敏和语音/文字输入改写。模型入口不依赖 Codex 或其他本机 Agent 登录态：Pegas 提供
常用供应商预设，也允许添加任意 OpenAI-compatible 或 Anthropic-compatible 入口。设置由
服务端持久化，Web 和未来原生客户端只通过同一 API 读取与修改；新的消息和 Run 无需
重启 Worker 即可使用最新版。

## 验收条件

1. 设置页展示并保存 Router 模式、Provider、对应模型名、脱敏策略和输入改写策略；
   保存成功后显示服务端 revision 与更新时间。
2. Provider 目录至少包含 OpenAI、Anthropic、Google Gemini、DeepSeek、xAI、Kimi、
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

## 保存、失败与恢复

- PUT 使用客户端读到的 `revision` 做乐观并发控制；revision 不一致返回冲突，避免旧
  页面覆盖新设备刚保存的设置。
- Provider 连接与设置保存使用同一事务更新；校验失败或 revision 冲突时原记录和凭证均
  保持不变。
- Worker 每次只读取一个完整快照。设置变更不终止已经进行的模型调用或 Run。
- 凭证密钥位于数据目录的权限受限文件；文件缺失或密文损坏时连接标记为不可用，不用
  空值覆盖密文，也不把解密错误降级为明文读取。
- 回滚应用版本不需要删除新增连接表；旧版本继续读取环境变量。恢复新版本后再次读取
  已保存设置。

## 非目标

- 不提供供应商模型目录自动发现、余额查询、延迟测试、故障转移或多账号轮换。
- 不把隐私 HMAC key、实例凭证密钥或 DSH profile 做成浏览器可编辑字段。
- 不提供按 Conversation、Task 或用户分别覆盖模型的规则。
- 不支持改写模板市场、复杂提示词编辑器或 LLM 识别语义 PII。
