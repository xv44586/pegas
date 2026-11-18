# Voice Input

> Feature：`VOICE-001`
>
> 状态：Web 听写与服务端连接配置闭环
>
> 更新日期：2026-11-17

## 用户结果

用户在 Pegas 输入器点击麦克风开始听写，再次点击结束。Pegas 将录音发送到自托管
ASR，转录文字回填输入框供用户校对；只有用户明确点击发送后，文字才作为普通
`user.message` 进入 Durable Event Inbox。语音不会创建另一套 Conversation、Task
或 Agent 入口。

## 验收条件

1. 支持 `MediaRecorder` 的桌面与移动浏览器可以开始、停止听写，控件具备明确的
   空闲、录音、转录和错误状态。
2. 转录结果追加到用户当前草稿，不覆盖录音期间输入的文字，也不自动发送。
3. 麦克风权限拒绝、设备缺失、空音频、ASR 不可用和网络失败都有可恢复提示，
   不创建半成品用户消息。
4. 音频仅在浏览器内存和 ASR 请求期间存在；Pegas 不写入数据库、日志或对象存储。
5. 麦克风按钮使用原生 `button`、可键盘操作、具有可访问名称和至少 44px 的触控目标。
6. Web 端、直接语音客户端和文字输入最终共享同一条服务端消息与 Router 链路。
7. 设置页显示浏览器录音能力与服务端转写配置两个独立状态。未配置转写时，麦克风入口直接引导到语音设置，不请求麦克风、不上传音频。
8. 用户可在语音设置中启用 OpenAI-compatible ASR，配置服务地址、模型与可选 API key；保存后下一段录音立即使用新连接，无需重启。API key 只写入或显式清除，响应不回显，落库前加密。
9. 未配置、鉴权失败、服务不可达和转写失败都有简短中文提示与恢复路径，不在 Web 展示上游原始响应；配置变更不影响已经开始的转写。
10. 设置更新使用 revision 防止旧页面覆盖新配置；迁移保留环境变量初始值，升级和重复启动不覆盖用户保存的设置。

## 非目标

- 第一版不提供离线 ASR、连续监听、唤醒词或实时 partial transcript。
- 第一版不自动把转录文字发送给模型；用户保留校对和取消机会。
- ASR 只负责准确转录，不做意图识别、改写或模型出站脱敏。
- Web 配置不会安装或启动 ASR 服务；用户需提供可访问的兼容转写端点。

## 服务边界

```text
Browser MediaRecorder
  -> POST /v1/voice/transcriptions
  -> SpeechRecognitionProvider
  -> OpenAI-compatible POST /v1/audio/transcriptions
  -> transcript text returned to composer
  -> explicit user send
  -> POST /v1/events as ordinary user.message
```

模型服务是独立部署单元。Pegas 不导入模型运行时，也不依赖 Qwen3-ASR 的内部
Python API。切换本机、远端 GPU、Qwen 新版本或其他兼容供应商只需要修改
设置页中的语音服务连接。首次启动时也可用 `PEGAS_SPEECH_*` 提供初始值；之后
服务端保存的选择优先，重启不会覆盖。

## HTTP 接口

`GET /v1/settings` 的 `speech` 字段只返回 `provider`、`baseUrl`、`model` 与
`hasApiKey`。`PUT /v1/settings` 可附加同名配置，包含可选 `apiKey` 和
`clearApiKey`；写入与其他运行设置使用同一 revision 和事务。未传 `speech` 的旧
客户端不会覆盖已有语音配置。关闭服务时保留地址和模型，重新启用后仍需确认连接可达。

### 听写

`POST /v1/voice/transcriptions` 接收原始音频请求体并只返回文字：

- `Content-Type`：必须是 `audio/*`，推荐 `audio/webm; codecs=opus` 或 `audio/mp4`。
- Query `language`：可选，例如 `zh`；不提供时由模型检测。

```json
{
  "transcript": {
    "text": "帮我安排明天的任务。",
    "language": "Chinese"
  },
  "provider": "openai-compatible",
  "model": "Qwen/Qwen3-ASR-0.6B"
}
```

### 直接语音消息

无输入器的客户端仍可调用 `POST /v1/voice/messages`，使用 `Idempotency-Key`、
`userId`、`source`、`language` 和可选 `taskId` 一步完成转录与入队。成功重试使用
相同 `Idempotency-Key`，现有去重约束保证只创建一个 Conversation Event。

## 权限、失败与恢复

- 浏览器只在用户点击麦克风后请求权限，并使用操作系统的默认输入设备；不添加会让
  macOS 偏选 iPhone Continuity 麦克风的音频处理约束。停止或失败时立即释放所有音轨。
- ASR 未配置：`503 speech_unavailable`。
- 模型失败或返回空文本：`502 speech_provider_failed`。
- 音频类型不支持：`415 unsupported_media_type`。
- 音频超过 `PEGAS_SPEECH_MAX_AUDIO_BYTES`：请求失败且不产生 transcript 或 Event。
- Web 保留已有草稿并允许重新听写；页面刷新不会恢复未提交录音。
- 设置页的“浏览器录音可用”仅说明浏览器支持录音 API；需要单独连接可用的转写服务。
- 兼容端点需由用户自行运行；设置保存只验证地址与模型格式，首次转写请求才验证服务可达。
