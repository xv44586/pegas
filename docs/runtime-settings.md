# 运行设置中心

> Feature：`SETTINGS-001`
>
> 状态：可用闭环
>
> 更新日期：2026-11-17

## 用户结果

用户从 Pegas 设置页统一选择任务 Router、模型 Provider 与模型名，并控制模型出站
脱敏和语音/文字输入改写。设置由服务端持久化，Web 和未来原生客户端只通过同一 API
读取与修改；新的消息和 Run 无需重启 Worker 即可使用最新版。

## 验收条件

1. 设置页展示并保存 Router 模式、Provider、对应模型名、脱敏策略和输入改写策略；
   保存成功后显示确认，API 保留 revision 用于并发控制。
2. 设置存入 SQLite 单例记录。首次启动用环境变量生成默认记录，后续重启不得用环境
   变量覆盖用户已保存的选择。
3. Worker 在处理每条新事件和领取每个 Run 时读取当前设置；已经开始的调用不被中途
   切换，下一次调用使用新 revision。
4. API 只接受完整、合法且与服务端能力相符的设置。未配置 OpenAI-compatible Base
   URL 或隐私 HMAC key 时，不允许选择相关能力；首次默认值也执行同一校验。
5. API key、Provider Base URL、隐私 HMAC key 和 DSH profile 等服务端凭证不通过设置
   API 返回，也不保存到浏览器。
6. 轻量改写只生成 Router/Executor 使用的执行视图，不修改 Conversation Event 原文；
   改写模型不可用或返回无效结果时回退原文，脱敏失败仍然禁止出站。
7. 旧数据库通过只新增表的 migration 升级；回滚旧版本时新表可保留并被忽略。

## 数据与权限边界

```text
Web / native settings UI
  -> authenticated Control Plane PUT /v1/settings
  -> SQLite runtime_settings (server authoritative)
  -> Worker reads revision before event/run
  -> rewrite view -> Router / Executor

Environment / secret store
  -> provider addresses and credentials
  -> privacy HMAC key
  -> capability checks only; never returned to clients
```

运行设置是当前 Pegas 实例的全局单例，适合现阶段单用户部署。未来多租户化时需要增加
scope 与 owner，不应把当前表误当作用户偏好表。

## 保存、失败与恢复

- PUT 使用客户端读到的 `revision` 做乐观并发控制；revision 不一致返回冲突，避免旧
  页面覆盖新设备刚保存的设置。
- 设置保存使用单条事务更新；校验失败或 revision 冲突时原记录保持不变。
- Worker 每次只读取一个完整快照。设置变更不终止已经进行的模型调用或 Run。
- 回滚应用版本不需要删除新表；旧版本继续读取环境变量。恢复新版本后再次读取已保存
  设置。

## 非目标

- 本 Feature 不把 API key、Base URL、HMAC key 或 DSH profile 做成浏览器可编辑字段。
- 不提供按 Conversation、Task 或用户分别覆盖模型的规则。
- 不支持改写模板市场、复杂提示词编辑器或 LLM 识别语义 PII。

## 分类设置页（SETTINGS-001）

验收：默认打开“模型”，依次为“模型 / 任务路由 / 语音与输入 / 隐私”；每个 Tab 只展示同类内容，切换保留未保存的编辑。键盘左右箭头、Home、End 可切换，当前页有下划线。设置页隐藏对话刷新和工作区操作，也不显示右侧工作区。

非目标：不增加新 Provider、语音服务或客户端权威配置。所有分类仍共享同一个服务端 revision，并通过现有保存接口一次保存。保存失败保留编辑，冲突不自动覆盖。回滚只撤销本次界面提交，无 schema 变化。

验证证据：分栏与工作区隐藏测试在旧 UI 上复现 2 个失败，修改后 19 个测试文件 / 77 个测试通过，`pnpm check` 与 `pnpm smoke` 通过。浏览器验证桌面与 375px 手机单一 Tab 面板、无横向溢出；保存数据边界未改变。
