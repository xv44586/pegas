# Worker 模型用量

> Feature：`USAGE-001`
>
> 状态：Usable
>
> 更新日期：2026-11-19

## 用户结果

用户打开一个 Channel 的工作区后，可以查看该 Worker 在这个 Channel 中的模型用量汇总，并下钻到每个 Run：供应商实际回报的输入、输出、缓存读取、缓存写入和推理 token，Pegas 观测到的执行耗时，以及供应商是否回报费用。

所有数字必须携带来源与完整性。Pegas 不使用字符数、分词器猜测或价目表估算冒充供应商账单；某一步或某个字段没有回报时，界面明确显示“部分回报”或“未提供”。

## 验收条件

1. DSH `--json` 的 `status/step_end.usage` 被解析为结构化 Executor usage；多个已回报步骤按 DSH 的互斥 token 桶相加。
2. 任一步骤未回报 usage 时，Run 记录为 `partial`；全部步骤都没有回报时记录为 `unavailable`，不得显示伪造的 0 token。
3. Run 完成时在同一服务端事务中写入一条幂等用量记录，保留执行快照中的模型引用、来源、完整性和 Pegas 观测耗时。
4. 用量 API 按 `userId` 和可选 `taskId/channelId` 隔离数据；其他用户不能通过 Run ID 或 Channel ID 读取记录。
5. Channel 工作区显示当前 Worker/Channel 汇总与逐 Run 明细；缓存命中率只在确切 prompt token 分母可用时计算。
6. 费用只有在 Executor/供应商实际回报时才显示数值；当前 DSH 合同未回报费用时显示“供应商未提供”。
7. 空数据、部分数据、长模型名和窄屏均可阅读；表格使用语义化 caption、列标题和可横向滚动容器。
8. Executor、存储迁移、API、Web 展示和用户隔离有自动化回归；`pnpm check` 与 `pnpm smoke` 通过。

## 数据与权限边界

- 服务端 `model_usage_records` 是 Pegas 的用量事实来源；Web 只负责读取和格式化。
- 设置页用量表支持「按 Run / 按模型」维度切换：模型维度按 `modelRef ?? executor` 在客户端聚合输入/输出/缓存 token 与观测时长，并显示 Run 数与事情数；聚合只是同一权威记录的视图，不产生新事实。
- token 来源为 `provider_reported`，经 DSH durable `step_end` 投影传递；Pegas 不重新分词。
- `durationMs` 来源为 `pegas_observed`，表示整个 Executor Run 的墙钟耗时，不伪装成模型首 token 延迟或纯推理时间。
- 模型引用来自 Run 的不可变 `executionContext.model` 快照。值为 `profile` 时只能说明使用 DSH profile，不能推断实际 provider/model。
- 缓存命中率分母为互斥的 `inputTokens + cacheReadTokens + cacheWriteTokens`；任一必要桶未知时不计算。
- 所有读取沿用当前单用户 bearer token 与 `userId` 所有者边界；不向客户端暴露 API key、原始供应商响应或隐藏 prompt。

## 非目标

- 语音识别、图片或嵌入模型调用尚未计入；它们后续应复用同一账本，而不是在 Web 单独统计。Router 与输入改写已于 PLAN-001 P2 接入（见下）。
- 不从 Magpie 账户余额、套餐窗口或价目表推算本次 Run 成本。
- 不实现预算告警、按日期账期、CSV 导出或跨 Worker 排行。
- 不把 token 数量作为 Channel 完成、Worker 能力或质量判断依据。

## 失败与恢复

- 用量写入与 Run 完成处于同一事务；写入失败时 Run 不得被标记完成，恢复 Worker 可以重试。
- 每个 `run_id` 只有一条记录，重复完成路径不会重复计费。
- 旧 Run 没有历史 usage 时 API 返回 `unavailable`，Web 显示“执行器未回报”，不回填估算值。
- 数据库迁移只新增表和索引；回滚应用代码时该表可保留，不影响 Task、Run 或 Outbox。

## 权威实现

- DSH usage 解析：`src/executor/dsh-cli-executor.ts`
- Run 完成事务与用量账本：`src/storage/sqlite-store.ts`
- 所有者隔离 API：`GET /v1/usage?userId=…&taskId=…`，实现于 `src/control-plane/server.ts`
- Channel 工作区汇总与逐 Run 表格：`web/src/App.tsx`

## 自动化证据

- `test/dsh-cli-executor.test.ts`：多步骤求和、缺失步骤、可选 token 桶缺失。
- `test/sqlite-store.test.ts`：迁移 13、真实字段持久化、部分/不可用状态、所有者和 Channel 隔离。
- `test/processor.test.ts`：Executor 结果经 Worker 完成链路写入用量账本。
- `test/control-plane.test.ts`：用量 API 的所有者与 Channel 边界。
- `web/src/App.test.tsx`：汇总、逐 Run、缓存命中、部分/未回报和供应商未提供费用。
- `pnpm review:ui`：桌面与 390px Channel 工作区截图及几何越界检查。

## 下一缺口

- ASR、图片与嵌入模型调用尚未接入同一账本。
- 尚无账期、预算告警、CSV 导出、分页或跨 Channel/Worker 对比。
- 当前 DSH 合同不回报费用；界面因此诚实显示“供应商未提供”。

## Router 与改写计量（PLAN-001 P2，2026-11-22）

schema v33 新增 `router_usage_records`：Router 与输入改写的每次模型调用一行，幂等键为 `component:eventId:modelRef`（同一事件重放路由不重复计费）。token 只取供应商上报（OpenAI `usage.prompt_tokens/completion_tokens/prompt_tokens_details.cached_tokens`；Anthropic `usage.input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens`）；无上报记 `unavailable`，调用失败记 `outcome=error`，绝不估算。耗时为 Pegas 观测墙钟。计量经 `MeteredJsonModelProvider` 包裹在 PrivacyMaskingProvider 外层，写失败静默跳过、不阻塞路由。`GET /v1/usage?userId=…`（不带 taskId）附 `router` 报告；设置页“模型用量”新增“路由与改写用量”汇总与明细。证据：`test/routing-cost.test.ts` 计量 4 测试、`web/src/App.test.tsx` 渲染回归。
