# 运行设置中心

> Feature：`SETTINGS-001`
>
> 状态：可用闭环
>
> 更新日期：2026-11-18

## 用户结果

用户从 Pegas 设置页统一选择任务 Router、模型 Provider、Router 模型与 Agent 模型，并控制模型出站
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
10. 已配置或正在编辑的 Provider 可以从兼容的模型目录接口获取模型列表；列表获取失败
    不覆盖手工输入，界面给出可恢复错误。模型测试必须使用当前 Provider、凭证和精确
    模型名执行最小结构化请求，并返回成功状态与耗时。
11. Router 模型与 Agent 模型在界面和持久化中分别命名。Router 与轻量改写只使用
    Pegas Provider；Agent 默认跟随 DSH profile，也可以选择 DSH profile 暴露的
    provider/model 组合。
12. Agent 模型覆盖只应用于新建 DSH session。已有 Task 恢复原 session 时不注入新
    覆盖，避免同一个恢复链路中途切换模型；保存设置不会中断正在执行的 Run。
13. 获取模型目录后立即展示可搜索、可点选的模型列表；选择仅更新尚未保存的 Router 模型，仍需用户保存。目录为空或获取失败时保留手动填写模型 ID 的路径；更换连接配置时清除过期目录。
14. 模型测试结果先给出可理解的结论与下一步：连接正常时显示响应时间；404、鉴权失败、限流和服务故障分别提示模型选择、密钥权限、额度与稍后重试。供应商原始错误不得直接铺到页面或回显凭证。

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
- Agent 模型覆盖通过临时 DSH patch 注入新 session；patch 文件在子进程退出后删除。
  恢复已有 session 时忽略当前覆盖并继续使用 session 原来的模型。
- 凭证密钥位于数据目录的权限受限文件；文件缺失或密文损坏时连接标记为不可用，不用
  空值覆盖密文，也不把解密错误降级为明文读取。
- 回滚应用版本不需要删除新增连接表；旧版本继续读取环境变量。恢复新版本后再次读取
  已保存设置。

## 非目标

- 不提供余额查询、持续延迟监控、故障转移或多账号轮换。
- 不把隐私 HMAC key、实例凭证密钥或 DSH profile 做成浏览器可编辑字段。
- 不提供按 Conversation、Task 或用户分别覆盖模型的规则；Agent 覆盖是实例级默认值。
- 不支持改写模板市场、复杂提示词编辑器或 LLM 识别语义 PII。

## Web 分类页

设置在独立页面，顶部顺序为模型与供应商、任务路由、语音与输入、隐私。切换保留未保存编辑；顶部只保留一个“设置”标题。Provider 选择、连接凭证、模型发现与测试、Router/Agent 模型都位于模型页，凭证不回显到客户端。

模型目录在 Web 端用于辅助选择，不自动改写服务端设置。列表支持按名称或 ID 搜索；大量结果时先展示前 50 项，输入关键词可继续查找。当前手填 ID 不在目录中时提醒用户，但不阻止测试或保存，因为部分兼容服务的目录可能不完整。连接测试采用当前未保存的表单值，错误反馈仅显示归类后的指导信息。

数据库迁移 v5 添加 Provider 连接，v6 添加 Agent 模型覆盖，v7 添加 Task 重试字段。早期独立 UI 候选版曾将 Task 重试占用 v5；启动时只对检测到重试字段且缺少 Provider 字段的数据库修正迁移编号，再依次应用 Provider 与 Agent 迁移。重复启动不会重复添加字段；回滚需同时恢复对应版本的数据库备份。
