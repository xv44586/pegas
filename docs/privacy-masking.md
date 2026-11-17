# 模型出站脱敏

> Feature：`PRIVACY-001`
>
> 状态：确定性规则闭环
>
> 更新日期：2026-11-17

## 用户结果

Pegas 在把用户内容交给外部模型或 Executor 前，识别明确的密钥、密码、邮箱和手机
号并替换为稳定占位符。模型或 Executor 返回的文本进入可信边界后恢复原值；
Conversation Event、Task 和本地工具仍以原文为事实来源。

## 验收条件

1. 开启脱敏后，Router provider 收到的 system/input 以及 DSH Executor 收到的用户
   prompt 不包含已识别原值。
2. 同一 HMAC key 下，同一类型和原值始终映射到同一占位符；映射只驻留进程内存，
   命中记录不包含原值。
3. provider 的嵌套 JSON 返回、Executor 的 acknowledgement 与最终文本都能恢复占位
   符；未知占位符保持原样。
4. `user.message`、Task goal/input 和 Run input 继续保存用户原文，不被原地改写。
5. 脱敏开启但 HMAC key 缺失或过短时，Worker 启动失败；运行中 masker 抛错时不会把
   未处理原文交给 provider 或 Executor。
6. 关闭脱敏时保持现有行为和配置兼容。

## 边界与数据流

```text
canonical user.message (原文)
  -> Router provider wrapper -> mask -> external model -> restore decision
  -> Executor wrapper        -> mask -> DSH prompt     -> restore visible text
```

Pegas 只负责自己能控制的出站边界。DSH 在执行中读取文件、调用工具后形成的后续模型
请求由 DSH 的 provider gateway 负责脱敏；Pegas 的 `headless` profile 当前使用本地
gateway，因此两层可以同时启用。Executor 仍负责工具权限、审批和副作用判断。

## 第一版规则

- PEM 私钥块；
- 常见带前缀的 API key 和 bearer token；
- `password`、`secret`、`token`、`api_key` 等字段后的长值；
- 真实邮箱（保留 `example.com`、`.test` 和 `.invalid` 示例地址）；
- 中国大陆手机号。

占位符形如 `{{API_KEY_ab12cd34ef56}}`。摘要由配置的 HMAC key、类型和原值共同
派生；原值只保存在 Worker 内存中的反向映射，用于恢复本次进程收到的模型文本。
日志只能记录类型、长度和占位符，不能记录原值或原始上下文。

## 配置、失败与恢复

```bash
PEGAS_PRIVACY_MODE=mask
PEGAS_PRIVACY_HMAC_KEY=至少十六个字符的独立随机密钥
```

- 默认 `disabled`，避免升级后在未配置密钥时改变现有运行方式。
- `mask` 模式必须提供至少 16 个字符的 HMAC key，配置错误时 fail closed。
- Worker 重启后反向映射会丢失；后续请求再次携带原值时会生成同一个占位符并恢复
  映射。恢复前收到的历史占位符保持原样，不猜测原值。
- 回滚只需将 `PEGAS_PRIVACY_MODE` 改回 `disabled` 并重启 Worker；不会迁移或改写
  数据库。

## 非目标

- 第一版不使用 LLM 或云服务识别人名、地址等语义 PII。
- 不在本 Feature 中增加 Web 设置页、持久化 vault、数据库加密或录音脱敏。
- 不替代 DSH provider gateway 对文件内容、工具结果和流式 tool-call arguments 的
  保护。
