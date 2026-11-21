# 结构化日志、指标与错误追踪

> Feature：`OBS-001`
>
> 状态：Usable
>
> 更新日期：2026-11-21

## 用户结果

运维者（单用户 MVP 中即用户本人）可以从各服务进程的 stdout 读到每行一个 JSON 对象的结构化日志，按 `service`/`event`/`level` 过滤定位问题；从 Control Plane `GET /metrics` 抓取 Prometheus 文本指标观察请求量、延迟分布、Run/事件/投递结果与错误计数；错误记录携带 durable 标识（runId/taskId/eventId/messageId）与序列化的 name/message/stack，可直接关联数据库事实。

## 合同

- **日志**（`src/observability/logger.ts`）：`{ts, level, service, event, message?, error?: {name, message, stack?}, fields?}`，每行一个 JSON。`PEGAS_LOG_LEVEL=debug|info|warn|error`（默认 info）。`message` 字段保留人类可读启动/停止文案；`child()` 绑定固定字段。已接线服务：control-plane、worker、scheduler、notification、supervisor（含 Recovery API）。
- **隐私边界**：用户消息正文、prompt、凭证不得进入日志字段；调用方只记录 durable 标识与结果。回归测试断言失败日志不包含用户输入文本。
- **指标**（`src/observability/metrics.ts`）：进程内 Prometheus 风格注册表，counter + histogram。`GET /metrics` 与主 API 同一 bearer 鉴权；未配置注册表时 404 `metrics_unavailable`。指标是进程本地运维遥测，重启清零，不是产品事实来源；durable 事实仍在 SQLite。
- **指标清单**：
  - `pegas_http_requests_total{method,route,status}`、`pegas_http_request_duration_seconds{method,route}`（route 归一化动态段为 `:id`，排除 /metrics、/healthz 与静态资源）；
  - `pegas_events_processed_total{outcome=processed|failed|parked|claim_lost}`；
  - `pegas_runs_total{outcome=completed|failed|steered}`、`pegas_run_duration_seconds{outcome}`；
  - `pegas_outbox_deliveries_total{outcome=sent|retry|unknown}`；
  - `pegas_automations_fired_total`；
  - `pegas_errors_total{component,kind}`：request_error、http_5xx、speech_provider、event_processing、event_lease_renew、run_execution、run_lease_renew、run_persistence、node_heartbeat、scheduler iteration、delivery_unknown。
- **错误追踪**：所有既有 `console.error` 运维路径改为结构化 error/warn 记录并同步 `pegas_errors_total`；Supervisor 回滚/重启/迁移审批缺失等生命线事件均有结构化记录（`release.rolling_back`、`release.rollback_blocked`、`release.migration_approval_missing` 等）。

## 非目标

- 不做外部日志聚合/远端 error tracking（Sentry 等）、不做指标持久化与跨进程聚合、不做告警规则；主机级外部健康检查仍是 mvp-plan 独立缺口。
- 不改变任何产品语义：telemetry 参数全部可选，既有调用方与测试不受影响。
- backup CLI 与 desktop 主进程保留人类可读输出（面向终端用户，非服务遥测）。

## 失败与恢复

- 日志/指标路径不抛错、不阻塞请求或 Run；sink 默认写 stdout，进程管理器负责收集。
- 回滚代码即回到 console 输出；无 schema 变更、无数据迁移。

## 自动化证据

`test/observability.test.ts` 8 个测试：日志 JSON 形状/child 字段/级别过滤与默认、counter/histogram Prometheus 渲染与空注册表、`/metrics` 鉴权与请求计数/延迟/错误计数、动态路由归一化低基数、事件与 Run 结果计数、Run 失败错误记录（含用户文本排除断言）、Outbox unknown/sent 投递计数。
